// Per crew-member-and-period statement generation lock — the pay-statement
// counterpart to lib/route-mutex and lib/claim-mutex.
//
// FIN-1 (July 2026 audit). Issuing a statement was a check-then-act sequence:
// findByPeriod() decided "no live statement for this crew+period yet", and only
// later did saveStatement() write the period index that makes the next caller see
// it. Five identical POSTs arriving together all ran the check before any of them
// wrote, so all five passed and all five issued. nextStatementNumber() is atomic
// (INCR), so the duplicates even received valid sequential numbers — they look
// legitimate, and a contractor sees five statements for one week.
//
// The fix is the same primitive the rest of the OS uses for money: serialize the
// whole check → compute → allocate → persist section behind a short Redis lock
// keyed on the identity that must be unique (crew member + exact period), so the
// duplicate check can no longer be read while a generation is still in flight.
//
// Tenancy: the key is a `paystmt:` logical key, so app/lib/redis.ts routes it
// through scopeKey() and it becomes `t:{tenantId}:paystmt:lock:...` when
// TENANCY_ENABLED — two tenants can never contend on, or release, each other's
// lock. Building the prefix here by hand is forbidden (bypass-detection gate);
// the chokepoint is the one place that does it.
//
// Different crew members, and different periods for the same crew member, use
// different keys and never block each other.
import { redis } from './redis'

const LOCK_TTL_MS = 20_000   // > the slowest generation (computePay + persist); auto-frees a crashed holder
const ATTEMPTS = 60          // ~6s of retries: long enough that a contender usually
const BACKOFF_MS = 100       // waits out the winner and then sees the duplicate (409)

// Compare-and-delete: only release the lock if we still own it. Prevents deleting a
// lock that expired mid-operation and was re-acquired by another writer.
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Raised when the generation lock could not be acquired within the retry budget. */
export class StatementGenerationBusyError extends Error {
  constructor() { super('STATEMENT_GENERATION_IN_PROGRESS'); this.name = 'StatementGenerationBusyError' }
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
 * The logical lock key. Mirrors the period index key
 * (`paystmt:period:{staffId}:{start}:{end}`) exactly, so the lock guards precisely
 * the uniqueness the index enforces. Tenant namespacing is applied by the redis
 * chokepoint, not here.
 */
export function payStatementLockKey(staffId: string, periodStart: string, periodEnd: string): string {
  const staff = String(staffId ?? '').trim()
  if (!staff) throw new Error('pay-statement lock: staffId is required')
  return `paystmt:lock:${staff}:${normalizePeriodBoundary(periodStart)}:${normalizePeriodBoundary(periodEnd)}`
}

export type PayStatementLockOpts = {
  ttlMs?: number
  attempts?: number
  backoffMs?: number
}

/**
 * Run `fn` while holding the generation lock for one crew member + period. The
 * caller must do the ENTIRE critical section inside `fn` — duplicate check,
 * payroll-gap validation, snapshot build, statement-number allocation and persist
 * — otherwise the race is only narrowed, not closed.
 *
 * Throws StatementGenerationBusyError if the lock can't be acquired within the
 * retry budget; callers surface that as a non-500 "generation in progress".
 * The lock is always released on the way out, including when `fn` throws, and only
 * when this caller still owns it (compare-and-delete).
 */
export async function withPayStatementLock<T>(
  scope: { staffId: string; periodStart: string; periodEnd: string },
  fn: () => Promise<T>,
  opts: PayStatementLockOpts = {},
): Promise<T> {
  const key = payStatementLockKey(scope.staffId, scope.periodStart, scope.periodEnd)
  const token = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
  const ttlMs = opts.ttlMs ?? LOCK_TTL_MS
  const attempts = Math.max(1, opts.attempts ?? ATTEMPTS)
  const backoffMs = opts.backoffMs ?? BACKOFF_MS

  let held = false
  for (let i = 0; i < attempts; i++) {
    if (await redis.setNxPx(key, token, ttlMs)) { held = true; break }
    await sleep(backoffMs)
  }
  if (!held) throw new StatementGenerationBusyError()
  try {
    return await fn()
  } finally {
    try { await redis.eval(RELEASE, [key], [token]) } catch { /* lock will expire on its own */ }
  }
}
