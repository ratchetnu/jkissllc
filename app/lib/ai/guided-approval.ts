// ─────────────────────────────────────────────────────────────────────────────
// Guided-estimate approval — the PURE decision layer shared by the OpsPilot panel
// and the server `approve-final` action, so authorization + idempotency + display
// are unit-tested once and can't drift between UI and API.
// ─────────────────────────────────────────────────────────────────────────────

import type { Booking } from '../bookings'

export type GuidedApprovalState = {
  hasFinal: boolean
  decision: string          // finalAiEstimate.finalDecision
  tier: string
  lowUsd: number
  highUsd: number
  recommendedUsd: number
  alreadySent: boolean      // the quote link has already gone to the customer
  canSend: boolean          // owner may Approve & Send now
  sensitiveItems: string[]
}

/** Display + eligibility state for the approval panel (no side effects). */
export function guidedApprovalState(b: Pick<Booking, 'finalAiEstimate' | 'confirmationLinkSentAt'>): GuidedApprovalState {
  const fe = b.finalAiEstimate
  const alreadySent = !!b.confirmationLinkSentAt
  const sendable = !!fe && (fe.finalDecision === 'quote_ready' || fe.finalDecision === 'awaiting_owner_approval')
  return {
    hasFinal: !!fe,
    decision: fe?.finalDecision ?? 'none',
    tier: fe?.routingTier ?? 'none',
    lowUsd: fe?.pricing.lowUsd ?? 0,
    highUsd: fe?.pricing.highUsd ?? 0,
    recommendedUsd: fe?.pricing.recommendedUsd ?? 0,
    alreadySent,
    canSend: sendable && !alreadySent,
    sensitiveItems: fe?.sensitiveItems ?? [],
  }
}

export type ApprovalGate = { allowed: true } | { allowed: false; reason: 'not_owner' | 'no_estimate' | 'already_sent'; status: number; message: string }

/**
 * The server-side gate for `approve-final`. Owner/admin only; requires a final
 * estimate; a SEND is idempotent (refused once the quote link has been sent).
 */
export function canApproveAndSend(opts: { role?: string | null; booking: Pick<Booking, 'finalAiEstimate' | 'confirmationLinkSentAt'>; send: boolean }): ApprovalGate {
  if (opts.role !== 'admin') return { allowed: false, reason: 'not_owner', status: 403, message: 'Owner/admin only.' }
  if (!opts.booking.finalAiEstimate) return { allowed: false, reason: 'no_estimate', status: 400, message: 'No final estimate to approve.' }
  if (opts.send && opts.booking.confirmationLinkSentAt) return { allowed: false, reason: 'already_sent', status: 409, message: 'This quote has already been sent to the customer.' }
  return { allowed: true }
}
