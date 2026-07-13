// Deterministic tests for the AI junk-estimating pipeline (Phase 17).
// Pure functions only — no Redis, no AI provider. Mocked model JSON in, validated
// analysis + priced decision out.
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeAnalysis, reviewFallbackAnalysis, type NormalizeCtx } from '../app/lib/ai/analysis-schema'
import { decideQuote, DEFAULT_QUOTE_THRESHOLDS } from '../app/lib/pricing/quote-decision'
import { monitorAnalysis, applyMonitor } from '../app/lib/ai/analysis-monitor'
import { reconcileWithCritic, type CriticVerdict } from '../app/lib/ai/junk-critic'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'

const ctx = (): NormalizeCtx => ({
  analysisId: 'a1', bookingId: 'b1', photoUrls: ['https://x/1.jpg', 'https://x/2.jpg'],
  modelProvider: 'anthropic', modelName: 'claude', analyzedAt: '2026-07-13T00:00:00Z',
})

const goodRaw = (over: Record<string, unknown> = {}) => ({
  normalizedItems: [
    { category: 'furniture', label: 'sofa', estimatedQuantity: 1, estimatedVolumeCubicYards: 3, estimatedWeightPounds: { minimum: 80, likely: 120, maximum: 160 }, bulky: true, heavy: false, requiresDisassembly: false, likelyDisposalType: 'landfill', confidence: 0.9, evidence: 'clear' },
    { category: 'household_junk', label: 'boxes', estimatedQuantity: 6, estimatedVolumeCubicYards: 0.5, estimatedWeightPounds: { minimum: 10, likely: 20, maximum: 30 }, bulky: false, heavy: false, requiresDisassembly: false, likelyDisposalType: 'landfill', confidence: 0.8, evidence: 'stacked' },
  ],
  totalEstimatedVolumeCubicYards: { minimum: 5, likely: 7, maximum: 9 },
  totalEstimatedWeightPounds: { minimum: 200, likely: 300, maximum: 400 },
  estimatedTruckLoadFraction: { minimum: 0.2, likely: 0.3, maximum: 0.4 },
  estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
  laborEstimate: { crewSize: 2, minimumMinutes: 45, likelyMinutes: 60, maximumMinutes: 90 },
  detectedConditions: {},
  confidence: { overall: 0.85, volume: 0.8, weight: 0.7, itemClassification: 0.85, accessDifficulty: 0.8 },
  additionalQuestions: ['Is everything at ground level?'],
  warnings: [], reviewRequired: false, reviewReasons: [],
  ...over,
})

// ── analysis normalizer ──────────────────────────────────────────────────────
test('valid model output normalizes without forcing review', () => {
  const a = normalizeAnalysis(goodRaw(), ctx())
  assert.equal(a.normalizedItems.length, 2)
  assert.equal(a.reviewRequired, false)
  assert.ok(a.estimatedTruckLoadFraction.likely > 0)
})

test('confidence values are clamped into 0..1', () => {
  const a = normalizeAnalysis(goodRaw({ confidence: { overall: 5, volume: -2, weight: 0.5, itemClassification: 0.5, accessDifficulty: 0.5 } }), ctx())
  assert.ok(a.confidence.overall <= 1 && a.confidence.overall >= 0)
  assert.ok(a.confidence.volume >= 0)
})

test('malformed / empty output → review required, never throws', () => {
  const a = normalizeAnalysis('not json', ctx())
  assert.equal(a.normalizedItems.length, 0)
  assert.equal(a.reviewRequired, true)
})

test('missing item fields are defaulted, not fatal', () => {
  const a = normalizeAnalysis({ normalizedItems: [{ label: 'mystery pile' }], confidence: { overall: 0.8, volume: 0.8 } }, ctx())
  assert.equal(a.normalizedItems[0].estimatedQuantity, 1)
  assert.equal(a.normalizedItems[0].category, 'unknown')
})

test('hazard flag forces review', () => {
  const a = normalizeAnalysis(goodRaw({ detectedConditions: { paintOrChemicalPossible: true } }), ctx())
  assert.equal(a.reviewRequired, true)
  assert.ok(a.reviewReasons.some(r => /hazard/i.test(r)))
})

test('reviewFallback is always review-required', () => {
  const a = reviewFallbackAnalysis(ctx(), ['provider down'])
  assert.equal(a.reviewRequired, true)
  assert.equal(a.normalizedItems.length, 0)
})

// ── pricing decision (deterministic engine) ──────────────────────────────────
const S = DEFAULT_DISPOSAL

test('$75 per-trip disposal minimum is applied (single trip)', () => {
  const a = normalizeAnalysis(goodRaw(), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'junk-removal' })
  assert.equal(d.breakdown.disposalTrips, 1)
  assert.ok(d.breakdown.disposalCents >= S.minDisposalFeePerTripCents, 'disposal >= $75')
})

test('confident single-load job → instant_quote', () => {
  const a = normalizeAnalysis(goodRaw(), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'junk-removal' })
  assert.equal(d.decision, 'instant_quote')
  assert.ok(d.recommendedUsd >= Math.round(S.serviceMinimumCents / 100), 'never below service minimum')
})

test('low confidence → estimate_range not instant', () => {
  const a = normalizeAnalysis(goodRaw({ confidence: { overall: 0.5, volume: 0.4, weight: 0.5, itemClassification: 0.5, accessDifficulty: 0.5 } }), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'junk-removal' })
  assert.notEqual(d.decision, 'instant_quote')
})

test('multi-truckload → manual_review', () => {
  const a = normalizeAnalysis(goodRaw({ estimatedTruckLoadFraction: { minimum: 2, likely: 2.5, maximum: 3 }, estimatedTruckLoads: { minimum: 2, likely: 3, maximum: 3 } }), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'junk-removal' })
  assert.equal(d.decision, 'manual_review')
})

test('multiple loads charge multiple disposal trips', () => {
  const a = normalizeAnalysis(goodRaw({ estimatedTruckLoadFraction: { minimum: 1.6, likely: 1.8, maximum: 2 } }), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'junk-removal' })
  assert.ok(d.breakdown.disposalTrips >= 2, 'two loads → ≥2 trips')
  assert.ok(d.breakdown.disposalCents >= 2 * S.minDisposalFeePerTripCents)
})

test('hazard in analysis → manual_review', () => {
  const a = normalizeAnalysis(goodRaw({ detectedConditions: { hazardousMaterialPossible: true } }), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'junk-removal' })
  assert.equal(d.decision, 'manual_review')
})

test('thresholds are honored (tight cap forces range)', () => {
  const a = normalizeAnalysis(goodRaw(), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'junk-removal', thresholds: { maxInstantQuoteUsd: 1 } })
  assert.notEqual(d.decision, 'instant_quote')
})

test('DEFAULT_QUOTE_THRESHOLDS are sane', () => {
  assert.ok(DEFAULT_QUOTE_THRESHOLDS.instantConfidenceMin > 0 && DEFAULT_QUOTE_THRESHOLDS.instantConfidenceMin <= 1)
  assert.ok(DEFAULT_QUOTE_THRESHOLDS.maxInstantLoads >= 1)
})

// ── consistency monitor ──────────────────────────────────────────────────────
test('monitor is clean on a consistent analysis', () => {
  const a = normalizeAnalysis(goodRaw(), ctx())
  const m = monitorAnalysis(a)
  assert.equal(m.forceReview, false)
})

test('monitor flags fraction-vs-volume contradiction', () => {
  const a = normalizeAnalysis(goodRaw({
    totalEstimatedVolumeCubicYards: { minimum: 25, likely: 30, maximum: 35 },
    estimatedTruckLoadFraction: { minimum: 0.08, likely: 0.1, maximum: 0.12 },
  }), ctx())
  const m = monitorAnalysis(a)
  assert.ok(m.concerns.some(c => c.code === 'fraction_volume_mismatch'))
  assert.ok(m.confidencePenalty > 0)
  const adj = applyMonitor(a, m)
  assert.ok(adj.confidence.overall < a.confidence.overall, 'confidence penalized')
})

test('monitor blocks a dense load with no dense flag (weight risk)', () => {
  const a = normalizeAnalysis(goodRaw({
    totalEstimatedVolumeCubicYards: { minimum: 6, likely: 7, maximum: 8 },
    totalEstimatedWeightPounds: { minimum: 6500, likely: 7000, maximum: 7500 },
    detectedConditions: {},
  }), ctx())
  const m = monitorAnalysis(a)
  assert.equal(m.forceReview, true)
  const adj = applyMonitor(a, m)
  assert.equal(adj.reviewRequired, true)
})

// ── second-opinion reviewer reconciliation ───────────────────────────────────
test("critic 'review' verdict forces manual review", () => {
  const a = normalizeAnalysis(goodRaw(), ctx())
  const v: CriticVerdict = { agrees: false, recommend: 'review', confidence: 0.4, concerns: ['photos hide the back of the pile'] }
  const r = reconcileWithCritic(a, v)
  assert.equal(r.reviewRequired, true)
  // The route passes forceReview when the reviewer says 'review'.
  const d = decideQuote({ analysis: r, settings: DEFAULT_DISPOSAL, serviceType: 'junk-removal', forceReview: v.recommend === 'review' })
  assert.equal(d.decision, 'manual_review')
})

test('monitor block forces manual_review via forceReview', () => {
  const a = normalizeAnalysis(goodRaw({
    totalEstimatedVolumeCubicYards: { minimum: 6, likely: 7, maximum: 8 },
    totalEstimatedWeightPounds: { minimum: 6500, likely: 7000, maximum: 7500 },
  }), ctx())
  const m = monitorAnalysis(a)
  const d = decideQuote({ analysis: applyMonitor(a, m), settings: DEFAULT_DISPOSAL, serviceType: 'junk-removal', forceReview: m.forceReview })
  assert.equal(d.decision, 'manual_review')
})

test("critic 'range' verdict drops it out of instant", () => {
  const a = normalizeAnalysis(goodRaw(), ctx())
  const v: CriticVerdict = { agrees: true, recommend: 'range', confidence: 0.6, concerns: [] }
  const r = reconcileWithCritic(a, v)
  const d = decideQuote({ analysis: r, settings: DEFAULT_DISPOSAL, serviceType: 'junk-removal' })
  assert.notEqual(d.decision, 'instant_quote')
})

test('critic disagreeing on size widens the range and lowers confidence', () => {
  const a = normalizeAnalysis(goodRaw(), ctx())   // fraction likely ~0.3
  const v: CriticVerdict = { agrees: false, recommend: 'accept', adjustedTruckLoadFraction: 0.9, confidence: 0.7, concerns: [] }
  const r = reconcileWithCritic(a, v)
  assert.ok(r.estimatedTruckLoadFraction.maximum >= 0.9)
  assert.ok(r.confidence.overall <= 0.6)
})
