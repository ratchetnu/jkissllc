// Guided-estimate approval gate: owner-only authorization, one-quote-per-booking
// idempotency, and the panel display/eligibility state. Pure/hermetic.
import assert from 'node:assert/strict'
import test from 'node:test'

import { guidedApprovalState, canApproveAndSend, quoteDeliveryMode } from '../app/lib/ai/guided-approval'
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

test('no final estimate + no prior read → mode none, nothing to approve', () => {
  const st = guidedApprovalState(mk({ finalAiEstimate: undefined }))
  assert.equal(st.hasFinal, false)
  assert.equal(st.canSend, false)
  assert.equal(st.mode, 'none')
})

// ── Manual pricing mode: online booking, an initial read but NO guided estimate ──
test('manual mode: online booking with an initial read but no final estimate needs a price', () => {
  const st = guidedApprovalState(mk({ finalAiEstimate: undefined, source: 'online', aiEstimate: { decision: 'manual_review' } as never }))
  assert.equal(st.mode, 'manual')
  assert.equal(st.needsPrice, true)
  assert.equal(st.hasFinal, false)
  assert.equal(st.recommendedUsd, 0)
  assert.equal(st.decision, 'manual_review')
})

test('manual mode: the owner-saved override prefills the send price (override wins over AI baseline)', () => {
  const st = guidedApprovalState(mk({
    finalAiEstimate: undefined, source: 'online',
    aiEstimate: { decision: 'manual_review', pricing: { recommendedUsd: 770 }, override: { overriddenUsd: 1300 } } as never,
  }))
  assert.equal(st.mode, 'manual')
  assert.equal(st.suggestedPriceUsd, 1300)   // the owner's $1300 override, not the $770 baseline
  assert.equal(st.recommendedUsd, 0)         // unchanged: guided-only field stays 0 in manual mode
})

test('manual mode: with no override, the AI baseline prefills the price', () => {
  const st = guidedApprovalState(mk({
    finalAiEstimate: undefined, source: 'online',
    aiEstimate: { decision: 'manual_review', pricing: { recommendedUsd: 770 } } as never,
  }))
  assert.equal(st.suggestedPriceUsd, 770)
})

test('guided mode: suggestedPriceUsd is 0 (guided uses recommendedUsd, blank = recommended)', () => {
  const st = guidedApprovalState(mk({ finalAiEstimate: fe('quote_ready') }))
  assert.equal(st.suggestedPriceUsd, 0)
})

test('manual mode ends once quoted/sent → not manual anymore', () => {
  const sent = guidedApprovalState(mk({ finalAiEstimate: undefined, source: 'online', aiEstimate: { decision: 'manual_review' } as never, confirmationLinkSentAt: 5 }))
  assert.equal(sent.mode, 'sent')
  const quoted = guidedApprovalState(mk({ finalAiEstimate: undefined, source: 'online', aiEstimate: { decision: 'manual_review' } as never, invoiceAmountCents: 42000 }))
  assert.equal(quoted.mode, 'none')
  assert.equal(quoted.needsPrice, false)
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

test('gate: no final estimate AND no owner-entered price → 400 no_price', () => {
  const g = canApproveAndSend({ role: 'admin', booking: mk({ finalAiEstimate: undefined }), send: true })
  assert.equal(!g.allowed && g.reason, 'no_price')
  assert.equal(!g.allowed && g.status, 400)
})

test('gate: manual mode — an owner-entered amount satisfies the price requirement', () => {
  const g = canApproveAndSend({ role: 'admin', booking: mk({ finalAiEstimate: undefined }), send: true, amount: 425 })
  assert.equal(g.allowed, true)
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

// ── Sandbox outbound guard for approve-final ─────────────────────────────────
// approve-final is the one send path NOT in the route's blanket OUTBOUND_COMMS
// list, so the test-record guard lives here in the shared decision layer.
test('sandbox guard: a test record Approve & Send is SIMULATED — never a live provider call', () => {
  assert.equal(quoteDeliveryMode({ send: true, isTest: true }), 'simulated')
})

test('sandbox guard: a test record Approve Only delivers nothing (approve-only is always safe)', () => {
  assert.equal(quoteDeliveryMode({ send: false, isTest: true }), 'none')
})

test('sandbox guard: a REAL booking Approve & Send is LIVE — production send path unchanged', () => {
  assert.equal(quoteDeliveryMode({ send: true, isTest: false }), 'live')
})

test('sandbox guard: a real booking Approve Only delivers nothing', () => {
  assert.equal(quoteDeliveryMode({ send: false, isTest: false }), 'none')
})
