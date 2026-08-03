// Compact primary-analysis prompt — SCHEMA-CONSUMER EQUIVALENCE.
//
// The compact spec (ops.junkAnalysisCompact) asks the vision model for fewer fields.
// This suite proves that dropping them changes NOTHING downstream: the same photos,
// described with the smaller shape, must normalize into an analysis that every
// consumer — deterministic pricing, the quote decision, the safety checks, the
// consistency monitor, follow-up selection, the customer view and the critic's
// summary — treats identically to the full v1 response.
//
// What this suite does NOT prove: that the model READS photos as well under the
// smaller spec. That is a live-model question and is answered by the LAT-002
// comparison in Preview, not here. This proves the plumbing is equivalent, which is
// the precondition for that experiment being meaningful at all.
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeAnalysis, type NormalizeCtx } from '../app/lib/ai/analysis-schema'
import { monitorAnalysis, applyMonitor } from '../app/lib/ai/analysis-monitor'
import { decideQuote } from '../app/lib/pricing/quote-decision'
import { selectFollowUpQuestions } from '../app/lib/ai/followup-questions'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'
import { getPrompt, hasPrompt } from '../app/lib/ai/prompts'
import { analysisTaskId } from '../app/lib/ai/junk-analysis'

const ctx: NormalizeCtx = {
  analysisId: 'a-1', bookingId: 'b-1',
  photoUrls: ['https://blob.example.com/p1.jpg', 'https://blob.example.com/p2.jpg'],
  modelProvider: 'vercel-ai-gateway', modelName: 'test-model', analyzedAt: '2026-08-03T00:00:00.000Z',
}

// The SAME job, described twice: once with every v1 field, once with only the
// fields the compact spec asks for. Identical facts, different verbosity.
const V1_RESPONSE = {
  normalizedItems: [
    {
      category: 'furniture', label: 'sectional couch', estimatedQuantity: 1,
      estimatedVolumeCubicYards: 4.5,
      estimatedWeightPounds: { minimum: 180, likely: 240, maximum: 320 },
      bulky: true, heavy: true, requiresDisassembly: true,
      likelyDisposalType: 'landfill', confidence: 0.82,
      evidence: 'Large three-piece sectional visible against the garage wall in both photos, roughly two metres wide.',
    },
    {
      category: 'appliance', label: 'chest freezer', estimatedQuantity: 1,
      estimatedVolumeCubicYards: 1.8,
      estimatedWeightPounds: { minimum: 120, likely: 160, maximum: 210 },
      bulky: true, heavy: true, requiresDisassembly: false,
      likelyDisposalType: 'special_handling', confidence: 0.74,
      evidence: 'White chest freezer at the rear of the second photo, lid closed, standard domestic size.',
    },
    {
      category: 'household_junk', label: 'boxed household goods', estimatedQuantity: 12,
      estimatedVolumeCubicYards: 0.4,
      estimatedWeightPounds: { minimum: 15, likely: 25, maximum: 40 },
      bulky: false, heavy: false, requiresDisassembly: false,
      likelyDisposalType: 'landfill', confidence: 0.66,
      evidence: 'Approximately a dozen medium cardboard boxes stacked two-high along the left side.',
    },
  ],
  photoObservations: [
    {
      photoUrl: 'https://blob.example.com/p1.jpg', estimatedPhotoVolumeCubicYards: 7.2,
      accessObservations: ['garage door access', 'level driveway'],
      possibleDuplicateViewOfOtherPhoto: false, duplicateGroupId: '', imageQuality: 'good',
    },
    {
      photoUrl: 'https://blob.example.com/p2.jpg', estimatedPhotoVolumeCubicYards: 6.9,
      accessObservations: ['same garage, opposite angle'],
      possibleDuplicateViewOfOtherPhoto: true, duplicateGroupId: 'g1', imageQuality: 'good',
    },
  ],
  totalEstimatedVolumeCubicYards: { minimum: 9, likely: 11.1, maximum: 13 },
  totalEstimatedWeightPounds: { minimum: 600, likely: 700, maximum: 900 },
  estimatedTruckLoadFraction: { minimum: 0.2, likely: 0.25, maximum: 0.32 },
  estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
  laborEstimate: { crewSize: 2, minimumMinutes: 60, likelyMinutes: 90, maximumMinutes: 150 },
  detectedConditions: {
    stairs: false, elevator: false, longCarry: false, narrowAccess: false,
    indoorRemoval: true, outdoorRemoval: false, disassemblyRequired: true, heavyItemsPresent: true,
    hazardousMaterialPossible: false, refrigerantAppliancePossible: true, concreteOrSoilPossible: false,
    tiresPossible: false, paintOrChemicalPossible: false,
  },
  confidence: { overall: 0.78, volume: 0.72, weight: 0.6, itemClassification: 0.8, accessDifficulty: 0.7 },
  additionalQuestions: ['Is the freezer empty and disconnected?'],
  warnings: ['Rear of the pile is partly obscured.'],
  reviewRequired: false,
  reviewReasons: [],
}

const COMPACT_RESPONSE = {
  normalizedItems: [
    { category: 'furniture', label: 'sectional couch', estimatedQuantity: 1, estimatedVolumeCubicYards: 4.5, heavy: true, requiresDisassembly: true, confidence: 0.82 },
    { category: 'appliance', label: 'chest freezer', estimatedQuantity: 1, estimatedVolumeCubicYards: 1.8, heavy: true, requiresDisassembly: false, confidence: 0.74 },
    { category: 'household_junk', label: 'boxed household goods', estimatedQuantity: 12, estimatedVolumeCubicYards: 0.4, heavy: false, requiresDisassembly: false, confidence: 0.66 },
  ],
  photoObservations: [
    { photoUrl: 'https://blob.example.com/p1.jpg', imageQuality: 'good' },
    { photoUrl: 'https://blob.example.com/p2.jpg', imageQuality: 'good' },
  ],
  totalEstimatedVolumeCubicYards: { minimum: 9, likely: 11.1, maximum: 13 },
  totalEstimatedWeightPounds: { minimum: 600, likely: 700, maximum: 900 },
  estimatedTruckLoadFraction: { minimum: 0.2, likely: 0.25, maximum: 0.32 },
  estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
  laborEstimate: { crewSize: 2, likelyMinutes: 90 },
  detectedConditions: V1_RESPONSE.detectedConditions,
  confidence: { overall: 0.78, volume: 0.72 },
  additionalQuestions: ['Is the freezer empty and disconnected?'],
  warnings: ['Rear of the pile is partly obscured.'],
  reviewRequired: false,
  reviewReasons: [],
}

const priceIt = (raw: unknown, serviceType = 'junk-removal') => {
  const analysis = applyMonitor(normalizeAnalysis(raw, ctx), monitorAnalysis(normalizeAnalysis(raw, ctx)))
  const monitor = monitorAnalysis(normalizeAnalysis(raw, ctx))
  const decision = decideQuote({
    analysis, settings: DEFAULT_DISPOSAL, serviceType, forceReview: monitor.forceReview,
  })
  return { analysis, monitor, decision }
}

// ── The prompt variant is selectable and OFF by default ──────────────────────

test('both analysis specs are registered and the compact one is opt-in', () => {
  assert.ok(hasPrompt('ops.junkAnalysis'))
  assert.ok(hasPrompt('ops.junkAnalysisCompact'))
  assert.equal(analysisTaskId({}), 'ops.junkAnalysis', 'flag unset ⇒ the shipped v1 spec')
  assert.equal(analysisTaskId({ AI_COMPACT_ANALYSIS_PROMPT: '0' }), 'ops.junkAnalysis')
  assert.equal(analysisTaskId({ AI_COMPACT_ANALYSIS_PROMPT: '1' }), 'ops.junkAnalysisCompact')
})

test('the compact spec really is smaller, and keeps the reasoning rules', () => {
  const full = getPrompt('ops.junkAnalysis').system
  const compact = getPrompt('ops.junkAnalysisCompact').system
  assert.ok(compact.length < full.length, 'a compact spec that is not smaller is pointless')

  // Reasoning survives — this is a RESPONSE reduction, not an instruction reduction.
  for (const rule of ['COUNT IT ONCE', '24 ft box truck', 'Hazardous materials', 'NEVER identify faces', 'reviewRequired=true']) {
    assert.ok(compact.includes(rule), `compact spec must keep the rule: ${rule}`)
  }
  // The unread fields are gone from the requested shape.
  for (const dropped of ['evidence', 'estimatedWeightPounds', 'bulky', 'likelyDisposalType', 'accessObservations', 'duplicateGroupId', 'estimatedPhotoVolumeCubicYards', 'itemClassification', 'accessDifficulty']) {
    assert.ok(!compact.includes(`"${dropped}"`), `compact spec must not request: ${dropped}`)
  }
  // The consumed fields are all still requested.
  for (const kept of ['normalizedItems', 'estimatedVolumeCubicYards', 'estimatedQuantity', 'heavy', 'requiresDisassembly', 'imageQuality', 'estimatedTruckLoadFraction', 'estimatedTruckLoads', 'totalEstimatedVolumeCubicYards', 'totalEstimatedWeightPounds', 'detectedConditions', 'hazardousMaterialPossible', 'concreteOrSoilPossible', 'crewSize', 'likelyMinutes', 'additionalQuestions', 'reviewRequired', 'reviewReasons']) {
    assert.ok(compact.includes(`"${kept}"`), `compact spec must still request: ${kept}`)
  }
})

// ── Equivalence across every consumer ────────────────────────────────────────

test('pricing inputs are identical: fraction, volume, weight, loads', () => {
  const a = normalizeAnalysis(V1_RESPONSE, ctx)
  const b = normalizeAnalysis(COMPACT_RESPONSE, ctx)
  assert.deepEqual(b.estimatedTruckLoadFraction, a.estimatedTruckLoadFraction)
  assert.deepEqual(b.totalEstimatedVolumeCubicYards, a.totalEstimatedVolumeCubicYards)
  assert.deepEqual(b.totalEstimatedWeightPounds, a.totalEstimatedWeightPounds)
  assert.deepEqual(b.estimatedTruckLoads, a.estimatedTruckLoads)
})

test('the quote decision, price and range are identical', () => {
  const v1 = priceIt(V1_RESPONSE)
  const compact = priceIt(COMPACT_RESPONSE)
  assert.equal(compact.decision.decision, v1.decision.decision)
  assert.equal(compact.decision.recommendedUsd, v1.decision.recommendedUsd)
  assert.deepEqual(compact.decision.rangeUsd, v1.decision.rangeUsd)
  assert.deepEqual(compact.decision.reviewReasons, v1.decision.reviewReasons)
  assert.deepEqual(compact.decision.breakdown.costLines, v1.decision.breakdown.costLines)
})

test('the consistency monitor reaches the same verdict', () => {
  const v1 = priceIt(V1_RESPONSE)
  const compact = priceIt(COMPACT_RESPONSE)
  assert.equal(compact.monitor.forceReview, v1.monitor.forceReview)
  assert.equal(compact.monitor.confidencePenalty, v1.monitor.confidencePenalty)
  assert.deepEqual(compact.monitor.concerns.map(c => c.code), v1.monitor.concerns.map(c => c.code))
})

test('safety-relevant conditions and confidence survive intact', () => {
  const a = normalizeAnalysis(V1_RESPONSE, ctx)
  const b = normalizeAnalysis(COMPACT_RESPONSE, ctx)
  assert.deepEqual(b.detectedConditions, a.detectedConditions)
  assert.equal(b.confidence.overall, a.confidence.overall)
  assert.equal(b.confidence.volume, a.confidence.volume)
  assert.equal(b.reviewRequired, a.reviewRequired)
})

test('follow-up question selection is identical', () => {
  const a = normalizeAnalysis(V1_RESPONSE, ctx)
  const b = normalizeAnalysis(COMPACT_RESPONSE, ctx)
  const pick = (an: typeof a) => selectFollowUpQuestions({ serviceFamily: 'junk', analysis: an }).map(q => q.id)
  assert.deepEqual(pick(b), pick(a))
})

test('the customer-visible item list is identical', () => {
  const a = normalizeAnalysis(V1_RESPONSE, ctx)
  const b = normalizeAnalysis(COMPACT_RESPONSE, ctx)
  const view = (an: typeof a) => an.normalizedItems.map(i => ({
    label: i.label, category: i.category, quantity: i.estimatedQuantity, confidence: i.confidence,
  }))
  assert.deepEqual(view(b), view(a))
  assert.deepEqual(b.additionalQuestions, a.additionalQuestions)
})

test('the critic receives the same summary', () => {
  const a = normalizeAnalysis(V1_RESPONSE, ctx)
  const b = normalizeAnalysis(COMPACT_RESPONSE, ctx)
  // Mirrors the summary junk-critic builds — the reviewer must be unable to tell
  // which spec produced the estimate it is auditing.
  const summary = (an: typeof a) => ({
    items: an.normalizedItems.map(i => ({ label: i.label, qty: i.estimatedQuantity, cuYd: i.estimatedVolumeCubicYards, heavy: i.heavy })),
    totalVolumeCuYd: an.totalEstimatedVolumeCubicYards.likely,
    truckLoadFraction: an.estimatedTruckLoadFraction.likely,
    truckLoads: an.estimatedTruckLoads.likely,
    weightLb: an.totalEstimatedWeightPounds.likely,
    conditions: an.detectedConditions,
    confidence: an.confidence.overall,
  })
  assert.deepEqual(summary(b), summary(a))
})

test('the admin audit surface still has every field it renders', () => {
  const b = normalizeAnalysis(COMPACT_RESPONSE, ctx)
  // app/admin/bookings/page.tsx renders exactly these.
  assert.ok(b.normalizedItems.every(i => typeof i.label === 'string' && i.estimatedQuantity >= 1))
  assert.equal(typeof b.totalEstimatedVolumeCubicYards.likely, 'number')
  assert.equal(typeof b.totalEstimatedWeightPounds.likely, 'number')
  assert.equal(typeof b.estimatedTruckLoadFraction.likely, 'number')
  assert.equal(b.laborEstimate.crewSize, 2)
  assert.equal(b.laborEstimate.likelyMinutes, 90)
})

// ── The dropped fields degrade to defaults, never to garbage ─────────────────

test('dropped per-item fields take their existing normalizer defaults', () => {
  const b = normalizeAnalysis(COMPACT_RESPONSE, ctx)
  for (const item of b.normalizedItems) {
    assert.equal(item.bulky, false)
    assert.equal(item.evidence, '')
    assert.equal(item.likelyDisposalType, 'unknown')
    assert.ok(item.estimatedWeightPounds.likely >= 0, 'a range object, never undefined')
  }
  // Unrequested confidence sub-scores fall back to `overall` — the documented default.
  assert.equal(b.confidence.weight, b.confidence.overall)
  assert.equal(b.confidence.itemClassification, b.confidence.overall)
  assert.equal(b.confidence.accessDifficulty, b.confidence.overall)
})

test('image quality still drives the unusable-photo review path', () => {
  const unusable = {
    ...COMPACT_RESPONSE,
    normalizedItems: [],
    photoObservations: [
      { photoUrl: 'https://blob.example.com/p1.jpg', imageQuality: 'unusable' },
      { photoUrl: 'https://blob.example.com/p2.jpg', imageQuality: 'unusable' },
    ],
  }
  const { decision } = priceIt(unusable)
  assert.equal(decision.decision, 'manual_review')
  assert.ok(decision.reviewReasons.some(r => /unusable/i.test(r)))
})

test('hazard flags still force manual review under the compact shape', () => {
  const hazardous = {
    ...COMPACT_RESPONSE,
    detectedConditions: { ...COMPACT_RESPONSE.detectedConditions, hazardousMaterialPossible: true },
  }
  const { decision } = priceIt(hazardous)
  assert.equal(decision.decision, 'manual_review')
  assert.ok(decision.reviewReasons.some(r => /hazardous/i.test(r)))
})

test('dense-material weight risk still escalates under the compact shape', () => {
  const dense = {
    ...COMPACT_RESPONSE,
    normalizedItems: [
      { category: 'construction_debris', label: 'broken concrete', estimatedQuantity: 1, estimatedVolumeCubicYards: 3, heavy: true, requiresDisassembly: false, confidence: 0.8 },
    ],
    detectedConditions: { ...COMPACT_RESPONSE.detectedConditions, concreteOrSoilPossible: true },
  }
  const { decision } = priceIt(dense)
  assert.equal(decision.decision, 'manual_review')
  assert.ok(decision.reviewReasons.some(r => /dense|concrete/i.test(r)))
})
