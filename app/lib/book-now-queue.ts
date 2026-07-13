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
//
// The AI-phase stages (queued / processing / failed / manual review) come from the
// DURABLE server-side job (`booking.aiJob`, see book-now-ai.ts), so "AI Failed" is a
// real persisted status — never an overlap with "Awaiting AI".
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

// A genuine, usable AI estimate is attached (not a failed shell).
function hasValidEstimate(b: Booking): boolean {
  return !!b.aiEstimate && b.aiEstimate.status !== 'failed' && !!b.aiEstimate.pricing
}

// Canonical workflow stage — the single furthest-along state of a request. Ordered
// terminal-first so the most advanced fact wins (a paid request is 'paid', not 'new').
export type BookNowStage =
  | 'failed'
  | 'booked'
  | 'paid'
  | 'payment_pending'
  | 'quote_sent'
  | 'manual_review'
  | 'awaiting_owner_approval'   // FINAL analysis produced an estimate; owner must approve before send
  | 'quote_ready'
  | 'final_processing'          // customer confirmed → second (final) analysis running
  | 'ai_failed'
  | 'ai_processing'
  | 'ai_queued'
  | 'awaiting_ai'
  | 'awaiting_photos'
  | 'new'

export const BOOK_NOW_STAGE_LABEL: Record<BookNowStage, string> = {
  failed: 'Failed',
  booked: 'Booking Confirmed',
  paid: 'Paid',
  payment_pending: 'Payment Pending',
  quote_sent: 'Quote Sent',
  manual_review: 'Manual Review',
  awaiting_owner_approval: 'Owner Approval Needed',
  quote_ready: 'Quote Ready',
  final_processing: 'Finalizing Estimate',
  ai_failed: 'AI Failed',
  ai_processing: 'AI Processing',
  ai_queued: 'AI Queued',
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
 *  (no external events required) so it works with the governed-intake flag off. */
export function bookNowStage(b: Booking): BookNowStage {
  if (FAILED_STATUSES.has(b.status)) return 'failed'
  if (BOOKED_STATUSES.has(b.status)) return 'booked'
  if ((b.amountPaidCents ?? 0) > 0) return 'paid'
  if (PAYMENT_PENDING_STATUSES.has(b.status)) return 'payment_pending'
  if ((b.invoiceAmountCents ?? 0) > 0) return 'quote_sent'                     // priced → quote is out
  // ── Guided-confirmation FINAL workflow — only when the confirmation flow is
  // engaged (confirmation / finalAiJob / finalAiEstimate present). Records that
  // predate the feature fall through to the unchanged initial-AI logic below. ──
  if (b.finalAiEstimate && b.confirmation && b.finalAiEstimate.confirmationVersion === b.confirmation.confirmationVersion) {
    const fd = b.finalAiEstimate.finalDecision
    if (fd === 'manual_review') return 'manual_review'
    if (fd === 'awaiting_owner_approval') return 'awaiting_owner_approval'
    return 'quote_ready'
  }
  if (b.finalAiJob) {
    if (b.finalAiJob.status === 'failed') return 'ai_failed'
    if (b.finalAiJob.status === 'manual_review') return 'manual_review'
    return 'final_processing'                                                  // queued / processing / retrying
  }
  if (b.confirmation) return 'final_processing'                               // confirmed, job about to enqueue
  if (b.aiJob?.status === 'manual_review' || b.aiEstimate?.decision === 'manual_review') return 'manual_review'
  if (hasValidEstimate(b)) return 'quote_ready'                               // AI priced, owner can send
  // ── AI recovery phase (real, persisted job states) ──
  if (b.aiJob?.status === 'failed') return 'ai_failed'
  if (b.aiJob?.status === 'processing' || b.aiJob?.status === 'retrying') return 'ai_processing'
  if (b.aiJob?.status === 'queued') return 'ai_queued'
  const isJobBased = bookNowServiceGroup(b.serviceType) === 'junk'
  if ((b.invoicePhotos?.length ?? 0) === 0 && isJobBased) return 'awaiting_photos'
  if ((b.invoicePhotos?.length ?? 0) > 0 && !b.aiEstimate) return 'awaiting_ai'  // legacy: photos, never enqueued
  return 'new'
}

// ── Sub-status read-outs shown on each row (independent of the canonical stage) ──
export type AiStatusRead = 'none' | 'queued' | 'processing' | 'failed' | 'review' | 'priced'
export function aiStatus(b: Booking): AiStatusRead {
  if (b.aiEstimate && b.aiEstimate.status !== 'failed' && b.aiEstimate.pricing) {
    return b.aiEstimate.decision === 'manual_review' ? 'review' : 'priced'
  }
  switch (b.aiJob?.status) {
    case 'queued': return 'queued'
    case 'processing':
    case 'retrying': return 'processing'
    case 'failed': return 'failed'
    case 'manual_review': return 'review'
    default: break
  }
  return (b.invoicePhotos?.length ?? 0) > 0 ? 'processing' : 'none'
}
export function quoteStatus(b: Booking): 'none' | 'ready' | 'sent' {
  if ((b.invoiceAmountCents ?? 0) > 0) return 'sent'
  if (hasValidEstimate(b)) return 'ready'
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

// ── Customer inventory-confirmation phase read-out (independent of the canonical
// stage, so it never disturbs backward-compatible records). Drives the OpsPilot
// "Confirmation" column + the customer workflow banner. ──
export type ConfirmationStatusRead =
  | 'none'          // not a photo-AI service, or first analysis not done yet
  | 'awaiting'      // first analysis done, customer has not confirmed the inventory
  | 'processing'    // customer confirmed → final analysis running
  | 'approval'      // final estimate needs owner approval before sending
  | 'ready'         // final estimate priced, owner can send
  | 'review'        // final analysis routed to manual review
  | 'failed'        // final analysis failed after retries
  | 'submitted'     // confirmation recorded, final job not yet resolved
export function confirmationStatus(b: Booking): ConfirmationStatusRead {
  const isJunk = bookNowServiceGroup(b.serviceType) === 'junk'
  if (b.finalAiEstimate && b.confirmation && b.finalAiEstimate.confirmationVersion === b.confirmation.confirmationVersion) {
    switch (b.finalAiEstimate.finalDecision) {
      case 'manual_review': return 'review'
      case 'awaiting_owner_approval': return 'approval'
      default: return 'ready'
    }
  }
  if (b.finalAiJob?.status === 'failed') return 'failed'
  if (b.finalAiJob?.status === 'manual_review') return 'review'
  if (b.finalAiJob && ['queued', 'processing', 'retrying'].includes(b.finalAiJob.status)) return 'processing'
  if (b.confirmation) return 'submitted'
  // No confirmation yet — is the request waiting for the customer to confirm?
  const firstDone = b.aiJob?.status === 'completed' || b.aiJob?.status === 'manual_review'
    || (!!b.aiEstimate && b.aiEstimate.status !== 'failed')
  if (isJunk && firstDone) return 'awaiting'
  return 'none'
}

// ── Queue filters (superset of stages + service groups + inclusion toggles) ─────
export type BookNowFilter =
  | 'all' | 'new'
  | 'junk' | 'moving' | 'delivery'
  | 'awaiting_photos' | 'ai_queued' | 'ai_processing' | 'ai_failed'
  | 'awaiting_confirmation' | 'final_processing' | 'awaiting_owner_approval'
  | 'awaiting_approval' | 'quote_ready' | 'manual_review' | 'quote_sent'
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
    case 'ai_queued': return stage === 'ai_queued'
    case 'ai_processing': return stage === 'ai_processing'
    case 'ai_failed': return stage === 'ai_failed'                 // REAL persisted status
    case 'awaiting_confirmation': return confirmationStatus(b) === 'awaiting'
    case 'final_processing': return stage === 'final_processing'
    case 'awaiting_owner_approval': return stage === 'awaiting_owner_approval'
    case 'awaiting_approval': return stage === 'quote_ready' || stage === 'awaiting_owner_approval' // an estimate awaiting the owner's send
    case 'quote_ready': return stage === 'quote_ready'
    case 'manual_review': return stage === 'manual_review'
    case 'quote_sent': return stage === 'quote_sent'
    case 'accepted': return stage === 'payment_pending'            // accepted-but-unpaid == awaiting payment
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
    failed: 0, booked: 0, paid: 0, payment_pending: 0, quote_sent: 0, manual_review: 0,
    awaiting_owner_approval: 0, quote_ready: 0, final_processing: 0,
    ai_failed: 0, ai_processing: 0, ai_queued: 0, awaiting_ai: 0, awaiting_photos: 0, new: 0,
  }
  for (const b of bookings) if (isBookNow(b)) out[bookNowStage(b)]++
  return out
}
