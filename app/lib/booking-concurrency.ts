// ─────────────────────────────────────────────────────────────────────────────
// Per-record optimistic concurrency (compare-and-swap with bounded retry) and a
// per-record write lease — the two protected-write primitives for bookings.
//
// The KV store is last-write-wins with no multi-key transactions. To stop a
// cross-request "read → mutate → save" from silently clobbering a concurrent
// writer, callers go through ONE of:
//   • updateBooking(token, mutate)  — CAS + retry. The mutate RE-RUNS on a fresh
//     copy each attempt, so only the winning save's audit events persist (no
//     duplicate events) and no valid update is lost. Use for pure-data mutations.
//   • withBookingWriteLock(token, fn) — a short, self-expiring per-booking lease
//     that SERIALIZES a multi-step operation with external side effects (Stripe,
//     the model call, SMS), where a CAS re-run would double the side effect.
//
// This module is the PURE, dependency-free core (`optimisticUpdate`) so the retry
// logic is unit-tested against a simulated concurrent store with no real Redis.
// ─────────────────────────────────────────────────────────────────────────────

export type CasResult = 'ok' | 'conflict'

export type OptimisticDeps<T> = {
  /** Load the freshest copy (with its current version). Null = not found. */
  load: () => Promise<T | null>
  /** Read the concurrency token off a loaded value. */
  versionOf: (v: T) => number
  /** Compare-and-swap: persist ONLY if the stored version still equals `expected`. */
  save: (value: T, expected: number) => Promise<CasResult>
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
}

export type UpdateOutcome<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; reason: 'not_found' | 'conflict' | 'aborted'; attempts: number; error?: string }

// A mutate may return the sentinel to stop non-retryably with a controlled error.
export type MutateResult = void | { abort: string }
export type Mutate<T> = (v: T) => MutateResult | Promise<MutateResult>

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
// Deterministic-ish backoff (no Math.random — unavailable in some runtimes): a
// short, growing wait keyed off the attempt so contending writers de-sync.
const backoffMs = (attempt: number) => Math.min(200, 10 * attempt * attempt)

/**
 * Run `mutate` against the freshest copy and persist it with CAS. On a version
 * conflict, reload + re-apply + retry (bounded). Because each retry starts from a
 * fresh load, the mutate's audit events only land on the winning save — never
 * duplicated. Returns a controlled outcome; never throws for a conflict.
 */
export async function optimisticUpdate<T>(
  deps: OptimisticDeps<T>,
  mutate: Mutate<T>,
  opts: { maxAttempts?: number } = {},
): Promise<UpdateOutcome<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5)
  const sleep = deps.sleep ?? defaultSleep
  let attempts = 0
  for (let i = 0; i < maxAttempts; i++) {
    attempts++
    const value = await deps.load()
    if (value == null) return { ok: false, reason: 'not_found', attempts }
    const expected = deps.versionOf(value)
    const res = await mutate(value)
    if (res && typeof res === 'object' && 'abort' in res) {
      return { ok: false, reason: 'aborted', attempts, error: res.abort }
    }
    const cas = await deps.save(value, expected)
    if (cas === 'ok') return { ok: true, value, attempts }
    // Conflict — someone wrote between our load and save. Back off and retry.
    if (i < maxAttempts - 1) await sleep(backoffMs(i + 1))
  }
  return { ok: false, reason: 'conflict', attempts }
}
