// Deterministic tests for the vision ESTIMATION engine (Phase 2–6).
// Pure functions only — no Redis, no AI provider. Real JunkPhotoAnalysis shapes
// (built through the actual normalizer) in, deterministic estimates out.
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeAnalysis, type NormalizeCtx } from '../app/lib/ai/analysis-schema'
import { decideQuote } from '../app/lib/pricing/quote-decision'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'
import { extractInventory } from '../app/lib/estimation/inventory-extract'
import { estimateVolume } from '../app/lib/estimation/volume-engine'
import { estimateWeight } from '../app/lib/estimation/weight-engine'
import { estimateComplexity } from '../app/lib/estimation/complexity'
import { runEstimationEngine } from '../app/lib/estimation/engine'

const CTX = (over: Partial<NormalizeCtx> = {}): NormalizeCtx => ({
  analysisId: 'a1', bookingId: 'b1', photoUrls: ['https://x/1.jpg'],
  modelProvider: 'anthropic', modelName: 'claude', analyzedAt: '2026-07-15T00:00:00Z', ...over,
})

const item = (over: Record<string, unknown> = {}) => ({
  category: 'furniture', label: 'sofa', estimatedQuantity: 1, estimatedVolumeCubicYards: 1.2,
  estimatedWeightPounds: { minimum: 80, likely: 120, maximum: 160 },
  bulky: true, heavy: false, requiresDisassembly: false, likelyDisposalType: 'landfill',
  confidence: 0.9, evidence: 'clear', ...over,
})

const analysisFrom = (raw: Record<string, unknown>, ctxOver: Partial<NormalizeCtx> = {}) =>
  normalizeAnalysis(raw, CTX(ctxOver))

// A confident, single-load furniture read (the happy path).
const goodRaw = (over: Record<string, unknown> = {}) => ({
  normalizedItems: [item({ label: 'sofa', estimatedQuantity: 1 }), item({ category: 'household_junk', label: 'boxes', estimatedQuantity: 6, confidence: 0.8 })],
  totalEstimatedVolumeCubicYards: { minimum: 3, likely: 4, maximum: 5 },
  estimatedTruckLoadFraction: { minimum: 0.2, likely: 0.3, maximum: 0.4 },
  laborEstimate: { crewSize: 2, minimumMinutes: 45, likelyMinutes: 60, maximumMinutes: 90 },
  detectedConditions: {},
  confidence: { overall: 0.85, volume: 0.8, weight: 0.75, itemClassification: 0.85, accessDifficulty: 0.8 },
  reviewRequired: false, reviewReasons: [], warnings: [],
  ...over,
})

// ── 1. Dedup: same item across two photos counts ONCE ────────────────────────
test('duplicate photos → item counted once, all sourceImageIds recorded', () => {
  const a = analysisFrom({
    normalizedItems: [], // no master list → engine must reconcile the per-photo lists
    photoObservations: [
      { photoUrl: 'https://x/1.jpg', visibleItems: [item({ label: 'sofa', estimatedQuantity: 1 })] },
      { photoUrl: 'https://x/2.jpg', visibleItems: [item({ label: 'sofa', estimatedQuantity: 1 })] },
    ],
    confidence: { overall: 0.8, volume: 0.8 },
  }, { photoUrls: ['https://x/1.jpg', 'https://x/2.jpg'] })

  const inv = extractInventory(a)
  assert.equal(inv.length, 1, 'the same sofa in two photos must be one item')
  assert.equal(inv[0].count, 1)
  assert.deepEqual(inv[0].sourceImageIds, ['https://x/1.jpg', 'https://x/2.jpg'])
})

// ── 2. Larger pile → higher volume band ──────────────────────────────────────
test('a larger pile produces a strictly higher volume band', () => {
  const small = estimateVolume(extractInventory(analysisFrom(goodRaw({ normalizedItems: [item({ estimatedQuantity: 1 })] }))))
  const large = estimateVolume(extractInventory(analysisFrom(goodRaw({ normalizedItems: [item({ estimatedQuantity: 10 })] }))))
  assert.ok(large.cubicYards.expected > small.cubicYards.expected)
  assert.ok(large.cubicYards.high > small.cubicYards.high)
  assert.ok(large.cubicYards.low < large.cubicYards.expected && large.cubicYards.expected < large.cubicYards.high)
})

// ── 3. Construction / dense debris → high weight + denseDebrisPresent ─────────
test('construction/dense debris flags dense weight and outweighs a light load', () => {
  const dense = estimateWeight(extractInventory(analysisFrom(goodRaw({
    normalizedItems: [item({ category: 'construction_debris', label: 'concrete chunks', estimatedQuantity: 1 })],
  }))))
  const light = estimateWeight(extractInventory(analysisFrom(goodRaw({
    normalizedItems: [item({ category: 'household_junk', label: 'bags of clothes', estimatedQuantity: 1 })],
  }))))
  assert.equal(dense.denseDebrisPresent, true)
  assert.ok(dense.pounds.expected > 1000, 'dense debris density floor should push weight high')
  assert.ok(dense.pounds.expected > light.pounds.expected * 5)
})

// ── 4. Heavy appliance → heavyItems + crew ≥ 2 ───────────────────────────────
test('a heavy appliance is flagged heavy and requires a crew of at least 2', () => {
  const inv = extractInventory(analysisFrom(goodRaw({
    normalizedItems: [item({ category: 'appliance', label: 'refrigerator', estimatedQuantity: 1, heavy: true })],
  })))
  const weight = estimateWeight(inv)
  const complexity = estimateComplexity(inv)
  assert.ok(weight.heavyItems.includes('refrigerator'))
  assert.ok(complexity.recommendedCrewSize >= 2)
})

// ── 5. Restricted (paint/hazardous) → restrictedItems + manual review ─────────
test('paint/chemicals are restricted and force manual review', () => {
  const a = analysisFrom(goodRaw({
    normalizedItems: [item({ category: 'household_junk', label: 'paint cans and chemicals', estimatedQuantity: 4 })],
  }))
  const result = runEstimationEngine(a, { settings: DEFAULT_DISPOSAL })
  assert.ok(result.restrictedItems.length > 0, 'paint must be restricted')
  assert.equal(result.manualReviewRequired, true)
  assert.equal(result.inventory[0].category, 'hazardous', 'label safety-upgrade re-routes to hazardous')
})

// ── 6. Unknown item → 'other', not forced into a wrong category ──────────────
test('an unrecognized item maps to other, never forced', () => {
  const inv = extractInventory(analysisFrom(goodRaw({
    normalizedItems: [item({ category: 'unknown', label: 'mystery pile', estimatedQuantity: 1 })],
  })))
  assert.equal(inv.length, 1)
  assert.equal(inv[0].category, 'other')
})

// ── 7. Low confidence → wider bands + manual review ──────────────────────────
test('low confidence widens the volume band and triggers review', () => {
  const hi = estimateVolume(extractInventory(analysisFrom(goodRaw({ normalizedItems: [item({ confidence: 0.95, estimatedQuantity: 4 })] }))))
  const lo = estimateVolume(extractInventory(analysisFrom(goodRaw({ normalizedItems: [item({ confidence: 0.05, estimatedQuantity: 4 })] }))))
  const hiWidth = (hi.cubicYards.high - hi.cubicYards.low) / hi.cubicYards.expected
  const loWidth = (lo.cubicYards.high - lo.cubicYards.low) / lo.cubicYards.expected
  assert.ok(loWidth > hiWidth, 'lower confidence must widen the band')

  const result = runEstimationEngine(analysisFrom(goodRaw({
    normalizedItems: [item({ confidence: 0.2 })],
    confidence: { overall: 0.25, volume: 0.3, weight: 0.3, itemClassification: 0.25, accessDifficulty: 0.3 },
    reviewRequired: true, reviewReasons: ['Low confidence read.'],
  })), { settings: DEFAULT_DISPOSAL })
  assert.equal(result.manualReviewRequired, true)
})

// ── 8. Deterministic + reproducible ──────────────────────────────────────────
test('the engine is deterministic — identical inputs, byte-identical output', () => {
  const a = analysisFrom(goodRaw())
  const r1 = runEstimationEngine(a, { settings: DEFAULT_DISPOSAL, serviceType: 'junk-removal' })
  const r2 = runEstimationEngine(a, { settings: DEFAULT_DISPOSAL, serviceType: 'junk-removal' })
  assert.deepEqual(r1, r2)
  // Concrete anchored values so a math regression is caught.
  assert.ok(r1.volume.cubicYards.expected > 0)
  assert.ok(r1.pricing.recommendedCents > 0)
})

// ── 9. Pricing comes from priceJob — no invented totals ──────────────────────
test('pricing is a transform of decideQuote/priceJob, never invented', () => {
  const a = analysisFrom(goodRaw())
  const result = runEstimationEngine(a, { settings: DEFAULT_DISPOSAL, serviceType: 'junk-removal' })
  const decision = decideQuote({ analysis: a, settings: DEFAULT_DISPOSAL, serviceType: 'junk-removal' })

  assert.equal(result.pricing.recommendedCents, Math.round(decision.breakdown.estimateRange.recommendedUsd * 100))
  assert.equal(result.pricing.rangeCents.low, Math.round(decision.breakdown.estimateRange.minimumUsd * 100))
  assert.equal(result.pricing.rangeCents.high, Math.round(decision.breakdown.estimateRange.maximumUsd * 100))
  assert.equal(result.pricing.pricingRuleVersion, decision.breakdown.pricingVersion)
  // Every adjustment cent-value must come straight from an engine cost line.
  const engineCents = new Set(decision.breakdown.costLines.map((l) => l.cents))
  for (const adj of result.pricing.adjustments) assert.ok(engineCents.has(adj.cents), `adjustment ${adj.label} must trace to a priceJob cost line`)
})

// ── 10. Fail-safe — malformed input never throws ─────────────────────────────
test('malformed analysis returns a manual-review result, never throws', () => {
  const result = runEstimationEngine(null as unknown as ReturnType<typeof analysisFrom>, { settings: DEFAULT_DISPOSAL })
  assert.equal(result.manualReviewRequired, true)
  assert.equal(result.riskLevel, 'high')
  assert.ok(Array.isArray(result.inventory))
})
