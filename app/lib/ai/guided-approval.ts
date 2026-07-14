// ─────────────────────────────────────────────────────────────────────────────
// Guided-estimate approval — the PURE decision layer shared by the OpsPilot panel
// and the server `approve-final` action, so authorization + idempotency + display
// are unit-tested once and can't drift between UI and API.
// ─────────────────────────────────────────────────────────────────────────────

import type { Booking } from '../bookings'

// The panel operates in one of two modes: GUIDED (a customer-confirmed final
// estimate is awaiting one-click Approve & Send) or MANUAL (no guided estimate —
// e.g. the AI routed to manual_review — so the owner enters the price and sends).
export type ApprovalMode = 'guided' | 'manual' | 'sent' | 'none'

export type GuidedApprovalState = {
  mode: ApprovalMode
  hasFinal: boolean
  decision: string          // finalAiEstimate.finalDecision (guided) or the aiEstimate decision (manual)
  tier: string
  lowUsd: number
  highUsd: number
  recommendedUsd: number    // 0 in manual mode → owner must enter a price
  alreadySent: boolean      // the quote link has already gone to the customer
  canSend: boolean          // owner may Approve & Send now (guided) — manual always needs a price
  needsPrice: boolean       // manual mode: the owner must enter an amount
  sensitiveItems: string[]
}

type ApprovalBooking = Pick<Booking, 'finalAiEstimate' | 'aiEstimate' | 'confirmationLinkSentAt' | 'invoiceAmountCents' | 'source'>

/** Display + eligibility state for the approval panel (no side effects). */
export function guidedApprovalState(b: ApprovalBooking): GuidedApprovalState {
  const fe = b.finalAiEstimate
  const alreadySent = !!b.confirmationLinkSentAt
  const quotedOrSent = alreadySent || (b.invoiceAmountCents ?? 0) > 0
  const guidedSendable = !!fe && (fe.finalDecision === 'quote_ready' || fe.finalDecision === 'awaiting_owner_approval')
  // Manual mode: an online booking with an initial read but NO guided estimate,
  // not yet quoted/sent — the owner needs to price it by hand and send.
  const manual = !fe && b.source === 'online' && !quotedOrSent && !!b.aiEstimate
  const mode: ApprovalMode = alreadySent ? 'sent' : fe ? 'guided' : manual ? 'manual' : 'none'
  return {
    mode,
    hasFinal: !!fe,
    decision: fe?.finalDecision ?? b.aiEstimate?.decision ?? 'none',
    tier: fe?.routingTier ?? 'manual',
    lowUsd: fe?.pricing.lowUsd ?? 0,
    highUsd: fe?.pricing.highUsd ?? 0,
    recommendedUsd: fe?.pricing.recommendedUsd ?? 0,
    alreadySent,
    canSend: guidedSendable && !alreadySent,
    needsPrice: mode === 'manual',
    sensitiveItems: fe?.sensitiveItems ?? [],
  }
}

export type ApprovalGate = { allowed: true } | { allowed: false; reason: 'not_owner' | 'no_price' | 'already_sent'; status: number; message: string }

/**
 * The server-side gate for `approve-final`. Owner/admin only; a SEND is idempotent
 * (refused once the quote link has been sent). A quote needs a number: either the
 * guided final estimate's recommended price OR an owner-entered `amount` (manual).
 */
export function canApproveAndSend(opts: { role?: string | null; booking: Pick<Booking, 'finalAiEstimate' | 'confirmationLinkSentAt'>; send: boolean; amount?: number }): ApprovalGate {
  if (opts.role !== 'admin') return { allowed: false, reason: 'not_owner', status: 403, message: 'Owner/admin only.' }
  const hasNumber = !!opts.booking.finalAiEstimate || (opts.amount ?? 0) > 0
  if (!hasNumber) return { allowed: false, reason: 'no_price', status: 400, message: 'Enter a price to send this quote.' }
  if (opts.send && opts.booking.confirmationLinkSentAt) return { allowed: false, reason: 'already_sent', status: 409, message: 'This quote has already been sent to the customer.' }
  return { allowed: true }
}

// How approve-final should deliver the quote link:
//   • none      — Approve Only (no send requested): nothing ever leaves the building.
//   • simulated — a SANDBOX/test record asked to send: record the send, but NEVER
//                 reach an email/SMS provider (a test record must never message a
//                 real person). The invoice + timeline still update.
//   • live      — a real booking asked to send: the actual customer send path.
export type QuoteDelivery = 'none' | 'simulated' | 'live'

/**
 * The sandbox outbound-comms guard for the ONE send path (`approve-final`) that is
 * not in the route's blanket OUTBOUND_COMMS list. Approve Only never delivers; a
 * test record's send is SIMULATED (so it can be exercised end-to-end without ever
 * calling a provider); a real booking's send is LIVE — the production path, byte
 * for byte unchanged. Duplicate-send protection is unaffected: the caller stamps
 * confirmationLinkSentAt on BOTH simulated and live sends, so `canApproveAndSend`
 * still refuses a second send (409) on a sandbox record too.
 */
export function quoteDeliveryMode(opts: { send: boolean; isTest: boolean }): QuoteDelivery {
  if (!opts.send) return 'none'
  return opts.isTest ? 'simulated' : 'live'
}
