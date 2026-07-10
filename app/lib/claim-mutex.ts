// Per-claim mutex — the claims counterpart to lib/route-mutex.
//
// A claim is an aggregate root: responsibility per crew member and the whole money
// ledger live inside one Redis document (clm:{id}). Every writer does an independent
// get → mutate → saveClaim, so two actors on the SAME claim at the SAME time (the
// daily accrual cron posting a scheduled deduction while an admin waives or edits it;
// two admin actions at once) both read the same pre-state and the second SET clobbers
// the first — a posted deduction, a waiver, or an evidence attachment can silently
// vanish. Because that lost write is money, this matters exactly as much as it does
// for routes.
//
// This serializes all read-modify-write on a given claim behind a short Redis lock,
// keyed on the claim id, so those operations can no longer interleave. Different
// claims never block each other. Same design and guarantees as route-mutex; see the
// commentary there.
import { redis } from './redis'
import { getClaim, saveClaim, type ClaimRecord } from './claims'

const LOCK_TTL_MS = 8_000   // generous vs. the few ms a mutation takes; auto-frees a crashed holder
const ATTEMPTS = 40         // ~2s of retries before giving up
const BACKOFF_MS = 50

const lockKeyFor = (claimId: string) => `clm:lock:${claimId}`
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// Compare-and-delete: only release the lock if we still own it. Prevents deleting a
// lock that expired mid-operation and was re-acquired by another writer.
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

export class ClaimBusyError extends Error {
  constructor() { super('CLAIM_BUSY'); this.name = 'ClaimBusyError' }
}

// Run `fn` while holding the claim's lock. Throws ClaimBusyError if the lock can't be
// acquired within the retry budget (a caller should surface a "try again" rather than
// risk a clobbering write).
export async function withClaimLock<T>(claimId: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKeyFor(claimId)
  const token = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
  let held = false
  for (let i = 0; i < ATTEMPTS; i++) {
    if (await redis.setNxPx(key, token, LOCK_TTL_MS)) { held = true; break }
    await sleep(BACKOFF_MS)
  }
  if (!held) throw new ClaimBusyError()
  try {
    return await fn()
  } finally {
    try { await redis.eval(RELEASE, [key], [token]) } catch { /* lock will expire on its own */ }
  }
}

// Load a claim fresh under its lock, let `mutator` change it, then persist — the safe
// replacement for getClaim()→mutate→saveClaim. Returns the mutator's value, or null if
// the claim no longer exists. `mutator` may return false to skip the save (an
// idempotent no-op or a validation bail-out).
export async function mutateClaim<T>(
  claimId: string,
  mutator: (claim: ClaimRecord) => T | Promise<T>,
): Promise<{ claim: ClaimRecord; value: T } | null> {
  return withClaimLock(claimId, async () => {
    const claim = await getClaim(claimId)
    if (!claim) return null
    const value = await mutator(claim)
    if (value !== false) await saveClaim(claim)
    return { claim, value }
  })
}
