// Guided-estimate approval gate: owner-only authorization, one-quote-per-booking
// idempotency, and the panel display/eligibility state. Pure/hermetic.
import assert from 'node:assert/strict'
import test from 'node:test'

import { guidedApprovalState, canApproveAndSend } from '../app/lib/ai/guided-approval'
import type { Booking } from '../app/lib/bookings'

const fe = (decision: string): Booking['finalAiEstimate'] => ({
  analysisId: 'f', createdAt: 'now', confirmationVersion: 1, policyVersion: 'v', routingTier: decision === 'quote_ready' ? 'high' : 'medium',
  finalDecision: decision as never, mergedAnalysis: {} as never,
  pricing: { recommendedUsd: 340, lowUsd: 300, highUsd: 420, breakdown: {} as never },
  conflicts: [], reviewReasons: [], routingReasons: [], evidenceSummary: [], missingInfo: [],
  truckLoadMin: 1, truckLoadMax: 1, laborHours: 1.5, crewSize: 2, disposalUsd: 75, expectedTrips: 1, specialHandling: false, sensitiveItems: [],
})
const mk = (p: Partial<Booking>): Booking => ({ finalAiEstimate: fe('awaiting_owner_approval'), ...p } as Booking)

// ── Display / eligibility ────────────────────────────────────────────────────
test('panel state: owner_approval + quote_ready are sendable; review/site-visit are not', () => {
  assert.equal(guidedApprovalState(mk({ finalAiEstimate: fe('awaiting_owner_approval') })).canSend, true)
  assert.equal(guidedApprovalState(mk({ finalAiEstimate: fe('quote_ready') })).canSend, true)
  assert.equal(guidedApprovalState(mk({ finalAiEstimate: fe('manual_review') })).canSend, false)
  assert.equal(guidedApprovalState(mk({ finalAiEstimate: fe('site_visit_required') })).canSend, false)
})

test('panel state exposes the revised range + recommended + tier', () => {
  const st = guidedApprovalState(mk({ finalAiEstimate: fe('quote_ready') }))
  assert.equal(st.lowUsd, 300); assert.equal(st.highUsd, 420); assert.equal(st.recommendedUsd, 340)
  assert.equal(st.tier, 'high'); assert.equal(st.decision, 'quote_ready'); assert.equal(st.hasFinal, true)
})

test('panel state: once the link is sent, it shows sent and is no longer sendable', () => {
  const st = guidedApprovalState(mk({ finalAiEstimate: fe('quote_ready'), confirmationLinkSentAt: 123 }))
  assert.equal(st.alreadySent, true)
  assert.equal(st.canSend, false)
})

test('no final estimate → nothing to approve', () => {
  const st = guidedApprovalState(mk({ finalAiEstimate: undefined }))
  assert.equal(st.hasFinal, false)
  assert.equal(st.canSend, false)
})

// ── Server gate: authorization ───────────────────────────────────────────────
test('AUTHZ: only admin may approve/send; manager/crew/anon are refused 403', () => {
  const b = mk({})
  for (const role of ['manager', 'crew', undefined, null] as const) {
    const g = canApproveAndSend({ role, booking: b, send: true })
    assert.equal(g.allowed, false)
    assert.equal(!g.allowed && g.reason, 'not_owner')
    assert.equal(!g.allowed && g.status, 403)
  }
  assert.equal(canApproveAndSend({ role: 'admin', booking: b, send: true }).allowed, true)
})

test('gate: no final estimate → 400 no_estimate', () => {
  const g = canApproveAndSend({ role: 'admin', booking: mk({ finalAiEstimate: undefined }), send: true })
  assert.equal(!g.allowed && g.reason, 'no_estimate')
  assert.equal(!g.allowed && g.status, 400)
})

// ── Server gate: idempotency (one quote per booking) ─────────────────────────
test('IDEMPOTENCY: a second SEND after the link went out is refused 409', () => {
  const sent = mk({ finalAiEstimate: fe('quote_ready'), confirmationLinkSentAt: 999 })
  const g = canApproveAndSend({ role: 'admin', booking: sent, send: true })
  assert.equal(!g.allowed && g.reason, 'already_sent')
  assert.equal(!g.allowed && g.status, 409)
})

test('idempotency guards SEND only — approve-only (no send) is still allowed after a prior send', () => {
  const sent = mk({ finalAiEstimate: fe('quote_ready'), confirmationLinkSentAt: 999 })
  assert.equal(canApproveAndSend({ role: 'admin', booking: sent, send: false }).allowed, true)
  // And a first send (not yet sent) is allowed.
  assert.equal(canApproveAndSend({ role: 'admin', booking: mk({}), send: true }).allowed, true)
})
