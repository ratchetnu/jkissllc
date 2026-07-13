import {
  type Booking, type ServiceType,
  JUNK_SERVICE_TYPES,
} from './bookings'

// ─────────────────────────────────────────────────────────────────────────────
// Book Now operations queue — the pre-job pipeline of online customer submissions.
//
// A Book Now request is a persisted Booking with `source:'online'`. It appears here
// the moment POST /api/quote succeeds — BEFORE any quote approval, payment, or
// booking confirmation. This module is the single, pure (no-I/O) source of truth for
// which bookings belong in the queue and what workflow stage each is in, so the
// Operations UI, the counters, and the tests all agree. Keep it hermetic + testable.
// ─────────────────────────────────────────────────────────────────────────────

/** A submission belongs in the Book Now queue iff it came from the public wizard. */
export function isBookNow(b: Pick<Booking, 'source'>): boolean {
  return b.source === 'online'
}

// Service groups the owner thinks in — junk/cleanout vs a move vs a delivery/freight run.
export type BookNowServiceGroup = 'junk' | 'moving' | 'delivery' | 'other'
const DELIVERY_SERVICE_TYPES: ServiceType[] = ['appliance-delivery', 'freight']
export function bookNowServiceGroup(t: ServiceType): BookNowServiceGroup {
  if (JUNK_SERVICE_TYPES.includes(t)) return 'junk'
  if (t === 'moving') return 'moving'
  if (DELIVERY_SERVICE_TYPES.includes(t)) return 'delivery'
  return 'other'
}

// Canonical workflow stage — the single furthest-along state of a request. Ordered
// terminal-first so the most advanced fact wins (a paid request is 'paid', not 'new').
export type BookNowStage =
  | 'failed'
  | 'booked'
  | 'paid'
  | 'payment_pending'
  | 'quote_sent'
  | 'awaiting_approval'
  | 'quote_ready'
  | 'awaiting_ai'
  | 'awaiting_photos'
  | 'new'

export const BOOK_NOW_STAGE_LABEL: Record<BookNowStage, string> = {
  failed: 'Failed',
  booked: 'Booking Confirmed',
  paid: 'Paid',
  payment_pending: 'Payment Pending',
  quote_sent: 'Quote Sent',
  awaiting_approval: 'Awaiting Approval',
  quote_ready: 'Quote Ready',
  awaiting_ai: 'Awaiting AI',
  awaiting_photos: 'Awaiting Photos',
  new: 'New',
}

const BOOKED_STATUSES = new Set([
  'booking_created', 'confirmation_link_sent', 'customer_viewed',
  'time_verification_pending', 'time_verified', 'confirmed',
  'in_progress', 'continued', 'completed', 'partially_completed',
])
const FAILED_STATUSES = new Set(['cancelled', 'refunded', 'could_not_complete'])
const PAYMENT_PENDING_STATUSES = new Set(['pending_payment', 'pending_zelle_verification'])

/** The furthest-along stage this request has reached. Derived from the booking alone
 *  (no events required) so it works with the governed-intake flag off. */
export function bookNowStage(b: Booking): BookNowStage {
  if (FAILED_STATUSES.has(b.status)) return 'failed'
  if (BOOKED_STATUSES.has(b.status)) return 'booked'
  if ((b.amountPaidCents ?? 0) > 0) return 'paid'
  if (PAYMENT_PENDING_STATUSES.has(b.status)) return 'payment_pending'
  if ((b.invoiceAmountCents ?? 0) > 0) return 'quote_sent'          // priced → quote is out
  if (b.aiEstimate?.decision === 'manual_review') return 'awaiting_approval'
  if (b.aiEstimate?.pricing) return 'quote_ready'                   // AI priced, owner can send
  const isJobBased = bookNowServiceGroup(b.serviceType) === 'junk'
  if ((b.invoicePhotos?.length ?? 0) === 0 && isJobBased) return 'awaiting_photos'
  if ((b.invoicePhotos?.length ?? 0) > 0 && !b.aiEstimate) return 'awaiting_ai'
  return 'new'
}

// ── Sub-status read-outs shown on each row (independent of the canonical stage) ──
export function aiStatus(b: Booking): 'none' | 'analyzing' | 'review' | 'priced' {
  if (!b.aiEstimate) return (b.invoicePhotos?.length ?? 0) > 0 ? 'analyzing' : 'none'
  if (b.aiEstimate.decision === 'manual_review') return 'review'
  return 'priced'
}
export function quoteStatus(b: Booking): 'none' | 'ready' | 'sent' {
  if ((b.invoiceAmountCents ?? 0) > 0) return 'sent'
  if (b.aiEstimate?.pricing) return 'ready'
  return 'none'
}
export function paymentStatus(b: Booking): 'unpaid' | 'partial' | 'paid' {
  const paid = b.amountPaidCents ?? 0
  const inv = b.invoiceAmountCents ?? 0
  if (paid <= 0) return 'unpaid'
  if (inv > 0 && paid >= inv) return 'paid'
  return 'partial'
}
/** The owner-alert delivery state for the new-submission notification. */
export function ownerAlertStatus(b: Booking): 'sent' | 'failed' | 'none' {
  const last = [...(b.notifications ?? [])].reverse().find(n => n.kind === 'new_submission')
  if (!last) return 'none'
  return last.status === 'sent' ? 'sent' : 'failed'
}

// ── Queue filters (superset of stages + service groups + inclusion toggles) ─────
export type BookNowFilter =
  | 'all' | 'new'
  | 'junk' | 'moving' | 'delivery'
  | 'awaiting_photos' | 'awaiting_ai' | 'ai_failed'
  | 'awaiting_approval' | 'quote_ready' | 'quote_sent'
  | 'accepted' | 'payment_pending' | 'paid' | 'booked' | 'failed'

export function matchesBookNowFilter(b: Booking, f: BookNowFilter): boolean {
  const stage = bookNowStage(b)
  switch (f) {
    case 'all': return true
    case 'new': return stage === 'new'
    case 'junk': return bookNowServiceGroup(b.serviceType) === 'junk'
    case 'moving': return bookNowServiceGroup(b.serviceType) === 'moving'
    case 'delivery': return bookNowServiceGroup(b.serviceType) === 'delivery'
    case 'awaiting_photos': return stage === 'awaiting_photos'
    case 'awaiting_ai': return stage === 'awaiting_ai'
    case 'ai_failed': return aiStatus(b) === 'analyzing' && (b.invoicePhotos?.length ?? 0) > 0 && !b.aiEstimate
    case 'awaiting_approval': return stage === 'awaiting_approval'
    case 'quote_ready': return stage === 'quote_ready'
    case 'quote_sent': return stage === 'quote_sent'
    case 'accepted': return stage === 'payment_pending'   // accepted-but-unpaid == awaiting payment
    case 'payment_pending': return stage === 'payment_pending'
    case 'paid': return stage === 'paid'
    case 'booked': return stage === 'booked'
    case 'failed': return stage === 'failed'
    default: return false
  }
}

/** Counts per stage across a set of online bookings — drives the overview counters. */
export function summarizeBookNow(bookings: Booking[]): Record<BookNowStage, number> {
  const out: Record<BookNowStage, number> = {
    failed: 0, booked: 0, paid: 0, payment_pending: 0, quote_sent: 0,
    awaiting_approval: 0, quote_ready: 0, awaiting_ai: 0, awaiting_photos: 0, new: 0,
  }
  for (const b of bookings) if (isBookNow(b)) out[bookNowStage(b)]++
  return out
}
