// ── Booking idempotency: one booking per client key ─────────────────────────
//
// Both public intake paths (`POST /api/book` and `persistQuoteRequest`) dedupe a
// retried submission on a client-supplied key. They used to do it with a single
// Redis key holding a `'PENDING'` sentinel under a FIXED 30s TTL:
//
//   A claims PENDING (30s) → A's work outruns 30s → the key EXPIRES → B retries,
//   sees a free key, claims it → two bookings for one submission. Two booking
//   numbers, two deposits owed, one date double-held.
//
// The lease was sized against a guess about how long the route takes, and the route
// can legitimately outrun it: a bookable-date scan, a deposit read, Zelle proof
// sealing (encrypt + blob PUT), the booking save, an ops email, a Stripe checkout
// create. A slow dependency was all it took. The same expiry also stranded the key
// on FAILURE — nothing ever released the claim, so a customer who fixed a bad date
// and resubmitted was told "already being processed" for 30 seconds.
//
// The fix is not a bigger number. It splits the two states that were sharing one
// key, and leases the in-flight one through the LOCK-1 primitive (lib/kv-lock),
// which already solved exactly this class of bug for the booking write lease:
//
//   bk:idem:{key}        FINAL only — the booking token, 24h. Written once, on
//                        success. Unchanged shape, so existing records keep working.
//   bk:idem:lock:{key}   IN FLIGHT — a renewable lease with a unique ownership
//                        token. The heartbeat keeps it alive for as long as the
//                        owning request is genuinely running, so an active
//                        reservation cannot silently expire; it lapses on its own if
//                        the process dies, so a crash cannot poison the key; and
//                        release is compare-and-delete, so one request can never
//                        free another's reservation.
//
// Read order matters: FINAL is checked before the lease, so a retry that arrives
// after the owner finished always gets the original booking rather than a 409.
//
// Both keys live under `bk:`, so the redis chokepoint tenant-scopes them identically
// (see lib/platform/tenancy/keys.ts — `bk:` is not platform-global).
import { redis } from './redis'
import { acquireLock, releaseIfOwned, type KvLock } from './kv-lock'

/** How long the finished mapping answers retries. Unchanged from both call sites. */
export const IDEM_FINAL_TTL_MS = 24 * 60 * 60_000

/**
 * Lease length for an in-flight reservation. This is NOT a bound on how long the
 * request may take — the heartbeat (ttl/3) extends it for as long as the owner is
 * alive. It is the window after a CRASH before the key frees itself, so it stays
 * short on purpose.
 */
export const RESERVATION_TTL_MS = 30_000

const finalKey = (key: string) => `bk:idem:${key}`
const leaseKey = (key: string) => `bk:idem:lock:${key}`

/**
 * The booking token a completed submission under this key produced, or null.
 *
 * Tolerates the legacy `'PENDING'` sentinel: a key still holding it at deploy time
 * is an in-flight claim from the old scheme, never a booking token. It self-clears
 * within 30s and is treated as "not finalized" until then.
 */
export async function finalizedBookingToken(key: string): Promise<string | null> {
  const v = await redis.get(finalKey(key))
  if (!v || v === 'PENDING') return null
  return v
}

/**
 * Reserve this key for the caller, or return null when another request holds it.
 *
 * The caller MUST release in a `finally` — on every path, including failure. A
 * failed attempt that releases lets the customer's corrected resubmission proceed
 * immediately instead of waiting out a lease.
 */
export async function reserveIdempotencyKey(key: string, holder: string): Promise<KvLock | null> {
  return acquireLock(leaseKey(key), { ttlMs: RESERVATION_TTL_MS, renew: true, holder })
}

/**
 * The outcome of trying to commit a booking under an idempotency key.
 * `winnerToken` is the booking token of whoever holds the claim instead — null when
 * they hold it but have not finished persisting yet.
 */
export type CommitOutcome = { ok: true } | { ok: false; winnerToken: string | null }

/**
 * Persist a booking as THE booking for this key, or refuse.
 *
 * ── Why the claim is taken before the write, and why not `assertHeld()` ──────
 *
 * Issue #178: the lease alone could not make the write safe. If the heartbeat
 * cannot reach the store for a full window the lease lapses, another request
 * legitimately acquires the key, and the original — still running — used to write
 * anyway. Two bookings.
 *
 * The obvious patch is an ownership assertion immediately before `save()`. It was
 * rejected for two reasons:
 *
 *   • It is not a proof. Ownership verified at time T says nothing at time T+ε; the
 *     lease can still lapse between the assertion and the write. It narrows the
 *     window, it does not close it.
 *   • It cannot tell "lease lost" from "store unreachable" — `heldNow()` reports
 *     false for both. Failing closed on that would reject a perfectly good booking
 *     whenever a single GET blips, trading a rare duplicate for a common lost sale.
 *
 * So the write boundary stops depending on the lease. `SET NX` on the FINAL key is
 * the commit point: the store itself admits exactly one winner per key, atomically,
 * with no clock and no interpretation involved. A heartbeat failure now has no
 * bearing on correctness at all — which is what makes "a heartbeat failure alone
 * must not duplicate" true by construction rather than by timing.
 *
 * The lease from #176 is preserved and still earns its place: it stops two requests
 * doing the whole booking build concurrently, gives the fast 409, and self-heals
 * after a crash. It is simply no longer what keeps the write unique.
 *
 * Rollback: if `save()` throws, the claim is compare-and-deleted so it cannot
 * strand the key — and only ever OUR claim, never a successor's.
 */
export async function commitIdempotently(
  key: string | undefined,
  bookingToken: string,
  save: () => Promise<void>,
): Promise<CommitOutcome> {
  if (!key) { await save(); return { ok: true } }

  const won = await redis.setNxPx(finalKey(key), bookingToken, IDEM_FINAL_TTL_MS)
  if (!won) return { ok: false, winnerToken: await finalizedBookingToken(key) }

  try {
    await save()
  } catch (e) {
    await releaseIfOwned(finalKey(key), bookingToken)
    throw e
  }
  return { ok: true }
}
