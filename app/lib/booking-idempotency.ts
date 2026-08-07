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
import { acquireLock, type KvLock } from './kv-lock'

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
 * Record the booking this key produced, so every later retry short-circuits to it.
 * Call AFTER the booking is durably saved — the mapping must never outlive its
 * record. Fail-soft: the reservation still guards the request either way.
 */
export async function finalizeIdempotencyKey(key: string, bookingToken: string): Promise<void> {
  await redis.set(finalKey(key), bookingToken)
  await redis.pexpire(finalKey(key), IDEM_FINAL_TTL_MS)
}
