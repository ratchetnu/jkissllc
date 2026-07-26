// ── Booking status transition policy (single source of truth) ────────────────
// Sprint 1 closeout. Before this module the legal moves between booking statuses were
// implicit, spread across six call sites, and each enforced a different subset:
// `recompute()` refused to touch closed states, the admin control guarded only
// `confirmed`, `send-link` carried its own four-status whitelist, and the public view
// carried a two-status one. Nothing prevented, say, `refunded → in_progress`.
//
// The matrix below is derived from those existing behaviours — it is deliberately a
// description of the workflows already in use, not a redesign. Every move the audited
// paths could legitimately make is still allowed; what changes is that anything else
// is now refused rather than silently written.
//
// Terminal statuses are the important asymmetry: a job that is over may only move
// between closure outcomes (a completed job can still be refunded, an aborted one can
// still be finished later), and never back into the active funnel. Reopening a closed
// booking is a new booking, not a status edit.
import type { BookingStatus } from './bookings'

/** The job is over. Mirrors `CLOSED_STATUSES` in bookings.ts — kept in lockstep by test. */
export const TERMINAL_BOOKING_STATUSES: readonly BookingStatus[] = [
  'completed', 'partially_completed', 'could_not_complete', 'cancelled', 'refunded',
]

export function isTerminalBookingStatus(s: BookingStatus): boolean {
  return TERMINAL_BOOKING_STATUSES.includes(s)
}

// Closure outcomes reachable from anywhere: a job can always be ended, whatever stage
// it reached. `refunded` is intentionally NOT here — money back is a closure *revision*,
// only reachable from an already-closed booking (see the terminal rows).
const CLOSURES: readonly BookingStatus[] = [
  'completed', 'partially_completed', 'could_not_complete', 'cancelled',
]

/**
 * The authoritative adjacency map: for each status, every status it may legally become.
 * Same-status is handled separately as an idempotent no-op and is not listed here.
 */
export const BOOKING_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  // ── Intake funnel ──────────────────────────────────────────────────────────
  // Payment and scheduling arrive in either order, so these stages move freely
  // among themselves; that freedom already existed via the admin status control.
  // `confirmed` is reachable directly because recompute() auto-confirms as soon as a
  // date is verified and money has landed, whatever stage the record had reached.
  quote_received: [
    'pending_payment', 'pending_zelle_verification', 'payment_received', 'booking_created',
    'confirmation_link_sent', 'customer_viewed', 'time_verification_pending', 'time_verified',
    'confirmed', ...CLOSURES,
  ],
  pending_payment: [
    'pending_zelle_verification', 'payment_received', 'booking_created', 'confirmation_link_sent',
    'customer_viewed', 'time_verification_pending', 'time_verified', 'confirmed', ...CLOSURES,
  ],
  pending_zelle_verification: [
    'pending_payment', 'payment_received', 'booking_created', 'confirmation_link_sent',
    'customer_viewed', 'time_verification_pending', 'time_verified', 'confirmed', ...CLOSURES,
  ],
  payment_received: [
    'pending_zelle_verification', 'booking_created', 'confirmation_link_sent', 'customer_viewed',
    'time_verification_pending', 'time_verified', 'confirmed', ...CLOSURES,
  ],
  booking_created: [
    'pending_payment', 'pending_zelle_verification', 'payment_received', 'confirmation_link_sent',
    'customer_viewed', 'time_verification_pending', 'time_verified', 'confirmed', ...CLOSURES,
  ],

  // ── Confirmation funnel ────────────────────────────────────────────────────
  confirmation_link_sent: [
    'customer_viewed', 'pending_payment', 'pending_zelle_verification', 'payment_received',
    'time_verification_pending', 'time_verified', 'confirmed', ...CLOSURES,
  ],
  customer_viewed: [
    'confirmation_link_sent', 'pending_payment', 'pending_zelle_verification', 'payment_received',
    'time_verification_pending', 'time_verified', 'confirmed', ...CLOSURES,
  ],
  time_verification_pending: [
    'time_verified', 'pending_payment', 'pending_zelle_verification', 'payment_received',
    'confirmed', ...CLOSURES,
  ],
  // A customer may re-pick a date, so `time_verified` can fall back to pending.
  time_verified: [
    'time_verification_pending', 'pending_zelle_verification', 'payment_received',
    'confirmed', ...CLOSURES,
  ],

  // ── Locked in and executing ────────────────────────────────────────────────
  // `confirmed` may return to `time_verified` because rescheduling un-locks the job;
  // recompute() re-confirms automatically once time+payment hold again.
  // `pending_zelle_verification` is reachable because a confirmed booking whose payments
  // are later voided leaves an unverified Zelle proof as the only money on file, and
  // recompute() reflects that rather than leaving the record claiming it is paid.
  confirmed: [
    'in_progress', 'continued', 'time_verified', 'time_verification_pending',
    'pending_zelle_verification', ...CLOSURES,
  ],
  in_progress: ['continued', ...CLOSURES],
  continued: ['in_progress', ...CLOSURES],

  // ── Terminal: closure outcomes only, never back into the funnel ────────────
  completed: ['partially_completed', 'could_not_complete', 'refunded'],
  partially_completed: ['completed', 'could_not_complete', 'refunded'],
  could_not_complete: ['completed', 'partially_completed', 'cancelled', 'refunded'],
  cancelled: ['refunded'],
  // Money returned is the final resting state — anything after it is a new booking.
  refunded: [],
}

export type TransitionRefusalCode =
  | 'TERMINAL_STATUS'
  | 'ILLEGAL_TRANSITION'
  | 'UNKNOWN_STATUS'

export type TransitionCheck =
  | { ok: true; sameStatus: boolean }
  | { ok: false; code: TransitionRefusalCode; reason: string }

/**
 * The one boundary every status change passes through. Fails closed: a pair that is not
 * explicitly listed is refused.
 *
 * Re-applying the current status is always allowed so that repeated saves, retried
 * requests, and recompute() running on an unchanged record stay idempotent — callers
 * receive `sameStatus: true` and should skip audit events and timestamp stamping.
 */
export function canTransition(from: BookingStatus, to: BookingStatus): TransitionCheck {
  const allowed = BOOKING_TRANSITIONS[from]
  if (!allowed) return { ok: false, code: 'UNKNOWN_STATUS', reason: `unknown current status "${from}"` }
  if (!BOOKING_TRANSITIONS[to]) return { ok: false, code: 'UNKNOWN_STATUS', reason: `unknown target status "${to}"` }
  if (from === to) return { ok: true, sameStatus: true }
  if (allowed.includes(to)) return { ok: true, sameStatus: false }
  return isTerminalBookingStatus(from)
    ? {
        ok: false,
        code: 'TERMINAL_STATUS',
        reason: `${from} is a closed booking — it cannot return to ${to}`,
      }
    : {
        ok: false,
        code: 'ILLEGAL_TRANSITION',
        reason: `${from} cannot become ${to}`,
      }
}

/** Convenience for the automatic paths: the new status if legal, else the current one. */
export function nextStatusOrKeep(from: BookingStatus, to: BookingStatus): BookingStatus {
  return canTransition(from, to).ok ? to : from
}

// Automatic events have narrower authority than an owner's manual status edit. Keep
// their historical source predicates explicit, then apply the global matrix as a second
// fail-closed boundary. A customer viewing a link must never erase payment-review state,
// and resending a link must never erase evidence that the customer already viewed it.
const CONFIRMATION_LINK_SENT_FROM: ReadonlySet<BookingStatus> = new Set([
  'quote_received', 'pending_payment', 'payment_received', 'booking_created',
])
const CUSTOMER_VIEWED_FROM: ReadonlySet<BookingStatus> = new Set([
  'confirmation_link_sent', 'booking_created',
])

export function statusAfterConfirmationLinkSent(from: BookingStatus): BookingStatus {
  return CONFIRMATION_LINK_SENT_FROM.has(from)
    ? nextStatusOrKeep(from, 'confirmation_link_sent')
    : from
}

export function statusAfterCustomerView(from: BookingStatus): BookingStatus {
  return CUSTOMER_VIEWED_FROM.has(from)
    ? nextStatusOrKeep(from, 'customer_viewed')
    : from
}

// ── Closure reversal (the explicit escape hatch) ─────────────────────────────
// BOOKING_TRANSITIONS deliberately keeps terminal statuses closed, so no ordinary
// status edit can reopen a finished job. But `Mark complete` and `Cancel` are one-click
// controls, and a mis-click must not be permanent. Reopening is therefore its own
// action with its own allowlist: deliberate, narrow, and audited by the caller.
//
// The source may be any closed status — a refund can be mis-clicked too, and recovering
// from that matters more, not less. The TARGET is restricted to the active states a job
// can plausibly return to; recompute() then settles payment/time-derived statuses.
export const REOPEN_TARGETS: readonly BookingStatus[] = [
  'confirmed', 'in_progress', 'continued', 'time_verified', 'booking_created',
]

export type ReopenRefusalCode = 'NOT_CLOSED' | 'INVALID_REOPEN_TARGET' | 'UNKNOWN_STATUS'
export type ReopenCheck =
  | { ok: true }
  | { ok: false; code: ReopenRefusalCode; reason: string }

/** Whether a closed booking may be reopened to `to`. Independent of canTransition(),
 *  which must keep refusing this move for ordinary edits. */
export function canReopen(from: BookingStatus, to: BookingStatus): ReopenCheck {
  if (!BOOKING_TRANSITIONS[from]) return { ok: false, code: 'UNKNOWN_STATUS', reason: `unknown current status "${from}"` }
  if (!isTerminalBookingStatus(from)) {
    return { ok: false, code: 'NOT_CLOSED', reason: `${from} is not a closed booking — change the status directly instead` }
  }
  if (!REOPEN_TARGETS.includes(to)) {
    return {
      ok: false,
      code: 'INVALID_REOPEN_TARGET',
      reason: `a reopened booking must return to one of: ${REOPEN_TARGETS.join(', ')}`,
    }
  }
  return { ok: true }
}

/** Closure stamps a reopened booking must shed, so the record never claims both states. */
export function closureFieldsToClear(from: BookingStatus): Array<'completedAt' | 'cancelledAt'> {
  if (from === 'completed' || from === 'partially_completed') return ['completedAt']
  if (from === 'could_not_complete') return ['completedAt', 'cancelledAt']
  return ['cancelledAt']   // cancelled, refunded
}
