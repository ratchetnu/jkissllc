// Per crew-member statement generation lock — the pay-statement
// counterpart to lib/route-mutex and lib/claim-mutex.
//
// FIN-1 (July 2026 audit). Issuing a statement was a check-then-act sequence:
// findByPeriod() decided "no live statement for this crew+period yet", and only
// later did the separate persistence step write the period index that makes the next caller see
// it. Five identical POSTs arriving together all ran the check before any of them
// wrote, so all five passed and all five issued. Number allocation is atomic
// (INCR), so the duplicates even received valid sequential numbers — they look
// legitimate, and a contractor sees five statements for one week.
//
// The fix is the same primitive the rest of the OS uses for money: serialize the
// whole check → compute → allocate → persist section behind a short Redis lock
// keyed on the crew member. Historical statements may use day, week, month, or
// custom periods, so different date tuples can overlap; serializing every issuance
// for one crew member makes the overlap check atomic too.
//
// Tenancy: the key is a `paystmt:` logical key, so app/lib/redis.ts routes it
// through scopeKey() and it becomes `t:{tenantId}:paystmt:lock:...` when
// TENANCY_ENABLED — two tenants can never contend on, or release, each other's
// lock. Building the prefix here by hand is forbidden (bypass-detection gate);
// the chokepoint is the one place that does it.
//
// Different crew members use different keys and never block each other. Different
// periods for the same crew member deliberately serialize.
import { redis } from './redis'

// ── Lease sizing ─────────────────────────────────────────────────────────────
// A fixed TTL cannot be sized against this critical section: it is dominated by
// computePay(), whose cost is DATA-PROPORTIONAL. Every record is an individual
// Upstash REST round trip, and at the configured read ceilings (routes 2000,
// bookings 2000, staff 200, claims 1000) one generation measures ~5,200 GETs. The
// route declares no `maxDuration`, so the function itself may run for minutes.
//
// So the lease is kept SHORT (a crashed holder frees the period in ~30s, not
// minutes) and RENEWED while the work is still running — compare-and-extend, so a
// heartbeat can only ever extend this caller's own lock. If the lease is ever
// genuinely lost (a stall long enough that the key expired and someone else took
// it), the holder must NOT write: `assertHeld()` before the first write turns that
// into a retryable 423 instead of the duplicate statement this module exists to
// prevent.
const LOCK_TTL_MS = 30_000       // base lease; how long a crashed holder can wedge the period
const RENEW_EVERY_MS = 10_000    // heartbeat at TTL/3 — two beats may fail before the lease lapses
const ATTEMPTS = 60              // ~6s of retries: long enough that a contender usually
const BACKOFF_MS = 100           // waits out the winner and then sees the duplicate (409)

// Compare-and-delete: only release the lock if we still own it. Prevents deleting a
// lock that expired mid-operation and was re-acquired by another writer.
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
// Compare-and-extend: the heartbeat. Same ownership test, so it can never prolong
// another caller's lock.
const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Raised when the generation lock could not be acquired within the retry budget. */
export class StatementGenerationBusyError extends Error {
  constructor() { super('STATEMENT_GENERATION_IN_PROGRESS'); this.name = 'StatementGenerationBusyError' }
}

/**
 * Raised by `assertHeld()` when this caller no longer owns the lock — the lease
 * lapsed mid-generation and another caller took it. Callers must treat this as
 * contention (retryable), never as a reason to continue writing.
 */
export class StatementLockLostError extends Error {
  constructor() { super('STATEMENT_GENERATION_LOCK_LOST'); this.name = 'StatementLockLostError' }
}

/** The handle handed to the guarded function. */
export type PayStatementLock = {
  /** The logical (un-scoped) lock key — for logging/tests, never for writing. */
  key: string
  /**
   * Re-verify ownership against the store. Call immediately before the FIRST write
   * of the critical section, so a lost lease can never become a duplicate statement.
   * Throws StatementLockLostError if the lock is gone or now belongs to someone else.
   */
  assertHeld: () => Promise<void>
}

/**
 * Canonical form of a period boundary, so two spellings of the same day cannot
 * take two different locks. Trims, accepts a full ISO timestamp by taking its
 * calendar day, and requires YYYY-MM-DD — anything else is a programming error
 * (the route validates with isDateStr before ever getting here).
 */
export function normalizePeriodBoundary(day: string): string {
  const norm = String(day ?? '').trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(norm)) throw new Error('pay-statement lock: period boundary must be YYYY-MM-DD')
  return norm
}

/**
 * The logical lock key. Period boundaries are still validated at this boundary,
 * but are intentionally absent from the key: exact-period uniqueness and
 * cross-scale overlap prevention must share one critical section per crew member.
 * Tenant namespacing is applied by the redis chokepoint, not here.
 */
export function payStatementLockKey(staffId: string, periodStart: string, periodEnd: string): string {
  const staff = String(staffId ?? '').trim()
  if (!staff) throw new Error('pay-statement lock: staffId is required')
  normalizePeriodBoundary(periodStart)
  normalizePeriodBoundary(periodEnd)
  return `paystmt:lock:${staff}`
}

export type PayStatementLockOpts = {
  ttlMs?: number
  attempts?: number
  backoffMs?: number
  renewEveryMs?: number
}

/**
 * Run `fn` while holding the generation lock for one crew member. The
 * caller must do the ENTIRE critical section inside `fn` — duplicate check,
 * payroll-gap validation, snapshot build, statement-number allocation and persist
 * — otherwise the race is only narrowed, not closed.
 *
 * Throws StatementGenerationBusyError if the lock can't be acquired within the
 * retry budget; callers surface that as a non-500 "generation in progress".
 *
 * While `fn` runs, the lease is renewed on a heartbeat (compare-and-extend), so a
 * long generation cannot outlive its own lock. `fn` receives a lock handle and must
 * call `assertHeld()` immediately before its first write.
 *
 * The lock is always released on the way out, including when `fn` throws, and only
 * when this caller still owns it (compare-and-delete).
 */
export async function withPayStatementLock<T>(
  scope: { staffId: string; periodStart: string; periodEnd: string },
  fn: (lock: PayStatementLock) => Promise<T>,
  opts: PayStatementLockOpts = {},
): Promise<T> {
  const key = payStatementLockKey(scope.staffId, scope.periodStart, scope.periodEnd)
  const token = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
  const ttlMs = opts.ttlMs ?? LOCK_TTL_MS
  const attempts = Math.max(1, opts.attempts ?? ATTEMPTS)
  const backoffMs = opts.backoffMs ?? BACKOFF_MS
  const renewEveryMs = Math.max(1, opts.renewEveryMs ?? Math.min(RENEW_EVERY_MS, Math.floor(ttlMs / 3)))

  let held = false
  for (let i = 0; i < attempts; i++) {
    if (await redis.setNxPx(key, token, ttlMs)) { held = true; break }
    await sleep(backoffMs)
  }
  if (!held) throw new StatementGenerationBusyError()

  // Heartbeat. A transport hiccup is not a loss — the beat simply retries, and
  // assertHeld() re-reads the store for the authoritative answer before any write.
  const beat = setInterval(() => {
    void redis.eval(RENEW, [key], [token, String(ttlMs)]).catch(() => { /* retried next beat */ })
  }, renewEveryMs)
  // Never let the heartbeat hold the runtime open by itself.
  ;(beat as unknown as { unref?: () => void }).unref?.()

  const lock: PayStatementLock = {
    key,
    assertHeld: async () => {
      if (await redis.get(key) !== token) throw new StatementLockLostError()
    },
  }

  try {
    return await fn(lock)
  } finally {
    clearInterval(beat)
    try { await redis.eval(RELEASE, [key], [token]) } catch { /* lock will expire on its own */ }
  }
}
