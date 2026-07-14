// Guided confirmation UI logic (Phase 2) — the PURE layer the /quote client
// delegates to: plain-language confidence, item seeding, payload assembly, answer
// mapping, and customer-safe final-state projection. Hermetic (no DOM, no I/O).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  confidenceBucket, confidenceExplanation, CONFIDENCE_LABEL,
  seedDraftItems, newDraftItem, buildConfirmationPayload, applyAnswer,
  projectCustomerFinalState,
  type FollowUpValue,
} from '../app/lib/ai/confirmation-ui'
import { QUESTION_CATALOG } from '../app/lib/ai/followup-questions'
import { normalizeConfirmation, activeItems, attestationComplete } from '../app/lib/ai/confirmation-schema'
import { buildConfirmedEstimate } from '../app/lib/ai/confirmed-analysis'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'

const NOW = '2026-07-13T00:00:00.000Z'

// ── Confidence, in plain language (never a bare %) ───────────────────────────
test('confidence buckets map to plain-language labels', () => {
  assert.equal(confidenceBucket(0.95), 'clear')
  assert.equal(confidenceBucket(0.65), 'confirm')
  assert.equal(confidenceBucket(0.45), 'partial')
  assert.equal(confidenceBucket(0.2), 'review')
  assert.equal(CONFIDENCE_LABEL.clear, 'Looks clear')
  assert.equal(CONFIDENCE_LABEL.review, 'Needs review')
})

test('confidence explanation is customer-safe and adapts to the read', () => {
  const zero = confidenceExplanation({ overall: 0, itemCount: 0 })
  assert.match(zero, /add the items/i)
  const clear = confidenceExplanation({ overall: 0.9, itemCount: 4 })
  assert.match(clear, /identified the major items clearly/i)
  // No raw percentage leaks into the copy.
  assert.ok(!/\d%/.test(clear))
})

// ── Seeding editable rows from AI detections ─────────────────────────────────
test('seedDraftItems marks rows aiDetected and normalizes categories', () => {
  const rows = seedDraftItems([
    { id: 'ai-0', label: 'Sofa', quantity: 1, category: 'furniture', confidence: 0.9, photoUrl: 'https://x/1.jpg' },
    { label: 'Old fridge', quantity: 2, category: 'appliance', confidence: 0.4 },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].aiDetected, true)
  assert.equal(rows[0].category, 'furniture')
  assert.equal(rows[0].sourcePhotoUrl, 'https://x/1.jpg')
  assert.equal(rows[1].quantity, 2)
})

test('newDraftItem is a customer-added row with a caller id', () => {
  const it = newDraftItem('hot_tub', 'add-1', 'Backyard spa')
  assert.equal(it.aiDetected, false)
  assert.equal(it.category, 'hot_tub')
  assert.equal(it.id, 'add-1')
})

// ── Answer mapping onto structured paths ─────────────────────────────────────
test('applyAnswer writes to the right structured sub-object + records the raw answer', () => {
  const payload = buildConfirmationPayload({
    items: [], answers: [], isEverything: 'yes', everythingPictured: true,
    attestation: { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true },
  })
  applyAnswer(payload, QUESTION_CATALOG.elevator_available, true)   // accessConditions path
  applyAnswer(payload, QUESTION_CATALOG.hazardous, true)           // disclosures path
  assert.equal(payload.accessConditions.elevatorAvailable, true)
  assert.equal(payload.disclosures.containsHazardous, true)
  assert.equal(payload.followUpAnswers.length, 2)
})

// ── Payload assembly + "is this everything" mapping ──────────────────────────
test('buildConfirmationPayload maps the "is this everything" checkpoint + attestation', () => {
  const more = buildConfirmationPayload({
    items: [], answers: [], isEverything: 'more_items', everythingPictured: false,
    attestation: { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true },
  })
  assert.equal(more.disclosures.everythingVisibleInPhotos, false)
  assert.equal(more.disclosures.additionalItemsNotPictured, true)
  assert.equal(more.photoQuality.allItemsPictured, false)
  assert.ok(more.attestation)
})

// ── Integration: Phase 2 payload → Phase 1 normalizer → Phase 1 engine ───────
test('a built payload normalizes and prices through the governed engine (high tier)', () => {
  const items = seedDraftItems([{ id: 'ai-0', label: 'Sofa', quantity: 1, category: 'furniture', confidence: 0.9 }])
  const answers = [
    { question: QUESTION_CATALOG.rooms, value: 1 as FollowUpValue },
    { question: QUESTION_CATALOG.parking_near, value: true as FollowUpValue },
  ]
  const payload = buildConfirmationPayload({
    items, answers, isEverything: 'yes', everythingPictured: true,
    attestation: { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true },
    idempotencyKey: 'conf-1',
  })
  const confirmation = normalizeConfirmation(payload, { now: NOW, confirmationVersion: 1, submittedBy: 'customer' })
  assert.equal(activeItems(confirmation).length, 1)
  assert.equal(attestationComplete(confirmation), true)
  assert.equal(confirmation.accessConditions.rooms, 1)

  const result = buildConfirmedEstimate({
    initial: undefined, confirmation, serviceType: 'junk-removal',
    settings: DEFAULT_DISPOSAL, now: NOW, analysisId: 'f', bookingId: 'b',
  })
  assert.equal(result.finalDecision, 'quote_ready')
  assert.equal(result.routingTier, 'high')
})

test('a payload disclosing hazardous routes to manual review', () => {
  const payload = buildConfirmationPayload({
    items: seedDraftItems([{ label: 'Boxes', quantity: 2, category: 'household_trash' }]),
    answers: [{ question: QUESTION_CATALOG.hazardous, value: true as FollowUpValue }],
    isEverything: 'yes', everythingPictured: true,
    attestation: { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true },
  })
  const confirmation = normalizeConfirmation(payload, { now: NOW, confirmationVersion: 1 })
  assert.equal(confirmation.disclosures.containsHazardous, true)
  const result = buildConfirmedEstimate({
    initial: undefined, confirmation, serviceType: 'junk-removal',
    settings: DEFAULT_DISPOSAL, now: NOW, analysisId: 'f', bookingId: 'b',
  })
  assert.equal(result.finalDecision, 'manual_review')
})

// ── Customer-safe final-state projection (Part 13) ───────────────────────────
test('projectCustomerFinalState: quote_ready shows a range; owner review hides price', () => {
  const ready = projectCustomerFinalState({
    confirmation: { confirmationVersion: 1 },
    finalAiEstimate: { finalDecision: 'quote_ready', confirmationVersion: 1, pricing: { recommendedUsd: 300, lowUsd: 250, highUsd: 360 } },
  })
  assert.equal(ready.stage, 'quote_ready')
  assert.equal(ready.lowUsd, 250)
  assert.equal(ready.highUsd, 360)

  const owner = projectCustomerFinalState({
    confirmation: { confirmationVersion: 1 },
    finalAiEstimate: { finalDecision: 'awaiting_owner_approval', confirmationVersion: 1, pricing: { recommendedUsd: 900, lowUsd: 800, highUsd: 1100 } },
  })
  assert.equal(owner.stage, 'owner_review')
  assert.equal(owner.lowUsd, undefined)   // never leak a price the owner hasn't approved
})

test('projectCustomerFinalState: manual review, failure, and processing fallbacks', () => {
  const manual = projectCustomerFinalState({
    confirmation: { confirmationVersion: 1 },
    finalAiEstimate: { finalDecision: 'manual_review', confirmationVersion: 1, pricing: { recommendedUsd: 0, lowUsd: 0, highUsd: 0 } },
  })
  assert.equal(manual.stage, 'manual_review')

  assert.equal(projectCustomerFinalState({ finalAiJob: { status: 'failed' } }).stage, 'failed')
  assert.equal(projectCustomerFinalState({ finalAiJob: { status: 'processing' } }).stage, 'processing')
  assert.equal(projectCustomerFinalState({}).stage, 'processing')
  // Never surfaces a technical error string.
  assert.ok(!/error|exception|provider/i.test(projectCustomerFinalState({ finalAiJob: { status: 'failed' } }).message))
})

test('a stale final estimate (older confirmation version) is treated as still processing', () => {
  const s = projectCustomerFinalState({
    confirmation: { confirmationVersion: 2 },
    finalAiEstimate: { finalDecision: 'quote_ready', confirmationVersion: 1, pricing: { recommendedUsd: 300, lowUsd: 250, highUsd: 360 } },
  })
  assert.equal(s.stage, 'processing')
})
