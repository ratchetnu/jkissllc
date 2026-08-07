// ── The KV lock primitive ────────────────────────────────────────────────────
//
// LOCK-1 (July 2026 race audit). The OS had two grades of lock. The per-entity
// mutexes (route-mutex, claim-mutex, pay-statement-mutex) each mint a unique token
// and release with compare-and-delete, so a holder can only ever delete its OWN
// lock. The rest — the per-booking write lease and the Release Center's publish /
// rollback / approval mutexes — stored a constant (or a non-unique actor name) and
// released with an unconditional DEL. That is unsafe in one specific, reachable way:
//
//   A acquires (lease T) → A's work outruns T → the key expires → B acquires →
//   A finishes and DELs the key → B's lock is gone while B is still working → C
//   acquires. Two writers, one record.
//
// Reproduced against the real `withBookingWriteLock` during the audit. This module
// is the ONE implementation of the proven pattern so there is no third grade of
// lock: unique ownership token, SET NX PX acquisition, compare-and-delete release,
// ownership verification available before any write, and an opt-in heartbeat for
// operations (the AI model call) that can outlive a sane lease.
//
// Tenancy: keys are passed as LOGICAL keys and namespaced by the redis chokepoint
// (app/lib/redis.ts), exactly as the existing mutexes do. Never build a tenant
// prefix here.
import { redis } from './redis'

// Compare-and-delete: release only while we still own the key.
const RELEASE_IF_OWNED = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
// Compare-and-extend: a heartbeat can only ever prolong its own lock.
const RENEW_IF_OWNED = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"

const DEFAULT_TTL_MS = 20_000
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Compare-and-delete `key`, but only while it still holds `token`. The same
 * primitive `release()` uses, exposed for callers that own a value directly rather
 * than through a KvLock handle (the booking idempotency claim). Never throws — a
 * failed release leaves the value to expire, which is always safer than an
 * unconditional DEL that could remove someone else's.
 */
export async function releaseIfOwned(key: string, token: string): Promise<boolean> {
  try {
    const res = await redis.eval(RELEASE_IF_OWNED, [key], [token])
    return res === 1 || res === '1'
  } catch {
    return false
  }
}

/** Raised by `assertHeld()` when this caller no longer owns the lock. */
export class LockLostError extends Error {
  constructor(key: string) { super(`LOCK_LOST:${key}`); this.name = 'LockLostError' }
}

/** A held lock. Only the holder of this handle can release or renew it. */
export type KvLock = {
  /** The logical key (un-scoped). Safe to log. */
  key: string
  /** This holder's unique token. Never reused across acquisitions. */
  token: string
  /** True if the store still says this lock is ours. Never throws. */
  heldNow(): Promise<boolean>
  /** Throw LockLostError unless we still own it — call before a first write. */
  assertHeld(): Promise<void>
  /** Compare-and-delete + stop the heartbeat. Returns true if WE released it. */
  release(): Promise<boolean>
}

export type AcquireOpts = {
  /** Lease length. Keep it short; use `renew` for long work rather than a big TTL. */
  ttlMs?: number
  /** Acquisition attempts (1 = non-blocking, today's behaviour for every caller). */
  attempts?: number
  /** Wait between attempts. */
  backoffMs?: number
  /** Heartbeat the lease while held (compare-and-extend at ttlMs/3). */
  renew?: boolean
  /** Optional human tag folded into the token for debugging. Not an identity. */
  holder?: string
}

/**
 * A token that is unique per ACQUISITION — never per actor. Two publishes by the
 * same admin, or two retries of one cron, must not be able to release each other.
 */
export function newLockToken(holder?: string): string {
  const tag = holder ? `${holder.replace(/[^\w.-]/g, '').slice(0, 24)}-` : ''
  return `${tag}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Acquire `key`, or return null when it is held by someone else. Throws only on a
 * genuine store error (callers decide whether that is fatal — see `withLock`).
 */
export async function acquireLock(key: string, opts: AcquireOpts = {}): Promise<KvLock | null> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  const attempts = Math.max(1, opts.attempts ?? 1)
  const backoffMs = opts.backoffMs ?? 100
  const token = newLockToken(opts.holder)

  let got = false
  for (let i = 0; i < attempts; i++) {
    if (await redis.setNxPx(key, token, ttlMs)) { got = true; break }
    if (i < attempts - 1) await sleep(backoffMs)
  }
  if (!got) return null

  // Heartbeat: keeps a short lease alive under long work, so the lease never has to
  // be sized against the slowest conceivable operation. A transport hiccup is not a
  // loss — the next beat retries and `assertHeld` re-reads the store for the truth.
  let beat: ReturnType<typeof setInterval> | null = null
  if (opts.renew) {
    // TTL/3 so two beats may fail before the lease lapses. The floor is deliberately
    // small: it must never exceed the lease itself, or `renew` would be a lie for a
    // short lock. Real leases here are 20s/90s/120s → beats at ~6.7s/30s/40s.
    beat = setInterval(() => {
      void redis.eval(RENEW_IF_OWNED, [key], [token, String(ttlMs)]).catch(() => { /* retried next beat */ })
    }, Math.max(50, Math.floor(ttlMs / 3)))
    ;(beat as unknown as { unref?: () => void }).unref?.()
  }

  const heldNow = async () => {
    try { return (await redis.get(key)) === token } catch { return false }
  }

  return {
    key,
    token,
    heldNow,
    async assertHeld() {
      if ((await redis.get(key)) !== token) throw new LockLostError(key)
    },
    async release() {
      if (beat) { clearInterval(beat); beat = null }
      // Never falls back to an unconditional DEL; the lease self-expires instead.
      return releaseIfOwned(key, token)
    },
  }
}

export type WithLockOpts<T> = AcquireOpts & {
  /** What to return when the lock is held by someone else. */
  onBusy: () => T | Promise<T>
  /**
   * What to do when the STORE itself errors on acquisition:
   *  - 'run_unlocked' (default): proceed without a lock — availability over
   *    serialization, the pre-existing booking-lease behaviour. We then hold NO
   *    token, so we release nothing and can never delete another writer's lock.
   *  - 'busy': treat it as contention and return `onBusy()`.
   */
  onStoreError?: 'run_unlocked' | 'busy'
}

/**
 * Run `fn` under `key`. Always releases on the way out — and only if we still own
 * it. `fn` receives the handle so it can `assertHeld()` before a first write.
 */
export async function withLock<T>(key: string, fn: (lock: KvLock | null) => Promise<T>, opts: WithLockOpts<T>): Promise<T> {
  let lock: KvLock | null = null
  try {
    lock = await acquireLock(key, opts)
  } catch {
    if (opts.onStoreError === 'busy') return await opts.onBusy()
    return await fn(null)   // unlocked, but we own nothing and will release nothing
  }
  if (!lock) return await opts.onBusy()
  try {
    return await fn(lock)
  } finally {
    await lock.release()
  }
}
