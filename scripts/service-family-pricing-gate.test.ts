// ── Service-family pricing gate ──────────────────────────────────────────────
// priceJob is the DISPOSAL engine — landfill trips, dump fees, debris weight. A
// moving job has none of those. Running it anyway does not yield a rough price;
// it yields a confident wrong one in the correct shape, which nothing downstream
// can distinguish from a real quote. These tests hold that gate shut.
//
// Run: npx tsx --test scripts/service-family-pricing-gate.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeAnalysis, type NormalizeCtx } from '../app/lib/ai/analysis-schema'
import { decideQuote } from '../app/lib/pricing/quote-decision'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'
import { customerEstimateView, type StoredAiEstimate } from '../app/lib/ai/estimate-store'
import { MOVING_SERVICE_TYPES, JUNK_SERVICE_TYPES } from '../app/lib/bookings'

const S = DEFAULT_DISPOSAL

const ctx = (): NormalizeCtx => ({
  analysisId: 'a1', bookingId: 'b1', photoUrls: ['https://x/1.jpg'],
  modelProvider: 'anthropic', modelName: 'claude', analyzedAt: '2026-08-04T00:00:00Z',
})

/** A clean, confident read — the kind that WOULD auto-quote as junk removal. */
const confidentRaw = () => ({
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
  additionalQuestions: [], warnings: [], reviewRequired: false, reviewReasons: [],
})

test('the SAME confident read auto-quotes as junk and is refused as moving', () => {
  const a = normalizeAnalysis(confidentRaw(), ctx())

  const junk = decideQuote({ analysis: a, settings: S, serviceType: 'junk-removal' })
  assert.equal(junk.decision, 'instant_quote')
  assert.equal(junk.priced, true)
  assert.ok(junk.recommendedUsd > 0)

  // Identical analysis, identical settings — only the service changed.
  const moving = decideQuote({ analysis: a, settings: S, serviceType: 'moving' })
  assert.equal(moving.decision, 'manual_review')
  assert.equal(moving.priced, false)
  assert.equal(moving.recommendedUsd, 0)
  assert.deepEqual(moving.rangeUsd, { low: 0, high: 0 })
})

test('every moving-family service is gated; every junk-family service still prices', () => {
  const a = normalizeAnalysis(confidentRaw(), ctx())
  for (const t of MOVING_SERVICE_TYPES) {
    const d = decideQuote({ analysis: a, settings: S, serviceType: t })
    assert.equal(d.priced, false, `${t} must not be priced by the disposal engine`)
    assert.equal(d.decision, 'manual_review', `${t} must route to a human`)
  }
  for (const t of JUNK_SERVICE_TYPES) {
    const d = decideQuote({ analysis: a, settings: S, serviceType: t })
    assert.equal(d.priced, true, `${t} is a disposal job and must still price`)
    assert.ok(d.recommendedUsd > 0, `${t} must produce a number`)
  }
})

test('a gated job carries no disposal cost anywhere in the breakdown', () => {
  const a = normalizeAnalysis(confidentRaw(), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'moving' })
  // The failure mode: a landfill trip invented for a job that never goes to one.
  assert.equal(d.breakdown.disposalTrips, 0)
  assert.equal(d.breakdown.disposalCents, 0)
  assert.equal(d.breakdown.truckLoads, 0)
  assert.equal(d.breakdown.sellingPriceCents, 0)
  assert.equal(d.breakdown.estimateRange.recommendedUsd, 0)
  assert.equal(d.quote.landfillTrips, 0)
})

test('the refusal is explained, not silent', () => {
  const a = normalizeAnalysis(confidentRaw(), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'moving' })
  assert.ok(d.reviewReasons.some(r => /priced by a person/i.test(r)),
    'a human picking this up must be told why it arrived unpriced')
})

test('gating does NOT discard the vision read — the inventory survives', () => {
  // This is what makes the moving photo set usable for evaluation: only the
  // PRICING is refused. Items, volume and truck fill are still observed.
  const a = normalizeAnalysis(confidentRaw(), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'moving' })
  assert.equal(d.decision, 'manual_review')
  assert.equal(a.normalizedItems.length, 2, 'the analysis itself is untouched')
  assert.ok(a.estimatedTruckLoadFraction.likely > 0, 'the volume read survives the gate')
})

test('customerEstimateView distinguishes "not priced" from "priced at zero"', () => {
  const a = normalizeAnalysis(confidentRaw(), ctx())
  const d = decideQuote({ analysis: a, settings: S, serviceType: 'moving' })
  const stored = {
    id: 'e1', createdAt: '2026-08-04T00:00:00Z', status: 'review', decision: d.decision,
    provider: 'anthropic', model: 'claude', schemaVersion: a.schemaVersion,
    inputPhotoUrls: ['https://x/1.jpg'], analysis: a,
    pricing: { recommendedUsd: 0, lowUsd: 0, highUsd: 0, breakdown: d.breakdown, priced: d.priced },
    reviewReasons: d.reviewReasons,
  } as unknown as StoredAiEstimate

  const view = customerEstimateView(stored)
  assert.equal(view.priced, false)
  assert.equal(view.lowUsd, 0)

  // An older record with no `priced` field was, by definition, priced.
  const legacy = { ...stored, pricing: { ...stored.pricing, priced: undefined } } as unknown as StoredAiEstimate
  assert.equal(customerEstimateView(legacy).priced, true)
})
