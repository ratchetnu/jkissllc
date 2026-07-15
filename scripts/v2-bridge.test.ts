// Deterministic tests for the V2 BRIDGE (Phase 3 Pass C/D/E + Phase 6 gating).
// Pure functions only — no Redis, no AI provider. Mock JunkPhotoAnalysisV2 objects
// in, deterministic estimates out. The central invariant under test: PRICING and
// VOLUME come from the deterministic engine + priceJob, and the model's volumeHint
// NEVER overrides them.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { JunkPhotoAnalysisV2, UnifiedObject } from '../app/lib/ai/analysis-schema-v2'
import { ANALYSIS_V2_VERSION } from '../app/lib/ai/analysis-schema-v2'
import { estimateFromV2, inventoryFromV2 } from '../app/lib/estimation/v2-bridge'
import { LOAD_TIERS, loadTierFor, LOAD_TIER_VERSION } from '../app/lib/estimation/load-tier'
import { computeConfidence, CONFIDENCE_VERSION } from '../app/lib/estimation/confidence'
import { estimateVolume } from '../app/lib/estimation/volume-engine'
import { DEFAULT_DISPOSAL, priceJob } from '../app/lib/disposal'

// ── Mock builders ─────────────────────────────────────────────────────────────
const obj = (over: Partial<UnifiedObject> = {}): UnifiedObject => ({
  objectId: 'object_001',
  category: 'furniture',
  description: 'sofa',
  quantity: 1,
  minQuantity: 1,
  maxQuantity: 1,
  sourceImageIds: ['img_1'],
  weightClass: 'medium',
  disposalClass: 'landfill',
  specialHandling: [],
  confidence: 'high',
  ...over,
})

const v2Of = (over: Partial<JunkPhotoAnalysisV2> = {}): JunkPhotoAnalysisV2 => ({
  schemaVersion: ANALYSIS_V2_VERSION,
  bookingId: 'b1',
  analyzedAt: '2026-07-15T00:00:00Z',
  model: 'anthropic/claude',
  promptVersion: 'v2-1',
  imageCountReceived: 2,
  imageCountUsable: 2,
  imageQualityResults: [
    { imageId: 'img_1', quality: 'good', warnings: [] },
    { imageId: 'img_2', quality: 'good', warnings: [] },
  ],
  perImageObservations: [],
  unifiedInventory: [],
  sceneSummary: 'garage with furniture',
  accessAssessment: { stairs: false, elevator: false, longCarry: false, narrowAccess: false, parkingRestricted: false, outdoorDistance: false, multipleRoomsOrAreas: false, notes: [] },
  laborAssessment: { estimatedCrewSize: 2, disassemblyRequired: false, heavyLifting: false, oversizedItems: false, applianceHandling: false, ppeRequired: [], potentialSecondTrip: false },
  disposalAssessment: { surchargeItems: [], hazardousPossible: false, specialtyItems: [] },
  volumeHint: {},
  confidence: 'high',
  confidenceScore: 0.85,
  uncertaintyReasons: [],
  missingInformation: [],
  recommendedCustomerQuestions: [],
  manualReviewRequired: false,
  manualReviewReasons: [],
  customerSafeSummary: 'ok',
  internalOwnerSummary: 'ok',
  ...over,
})

// ── 1. 2 sofas + fridge → deterministic band + a load tier, priced via priceJob ─
test('2 sofas + fridge → deterministic volume band, a load tier, and priceJob pricing', () => {
  const v2 = v2Of({
    unifiedInventory: [
      obj({ objectId: 'o1', category: 'furniture', description: 'sofa', quantity: 2, minQuantity: 2, maxQuantity: 2, sourceImageIds: ['img_1', 'img_2'] }),
      obj({ objectId: 'o2', category: 'appliance', description: 'refrigerator', quantity: 1, minQuantity: 1, maxQuantity: 1, weightClass: 'heavy', disposalClass: 'appliance-refrigerant', sourceImageIds: ['img_1'] }),
    ],
    // A deliberately wrong model hint — must be ignored for the authoritative volume.
    volumeHint: { likelyCubicYards: 40 },
  })

  const r = estimateFromV2(v2)

  // Deterministic volume band: 2 sofas (1.2 ea) + 1 fridge (1.0) = 3.4 cu yd expected.
  assert.equal(r.volume.cubicYards.expected, 3.4, 'volume must be the taxonomy sum, not the model hint')
  assert.ok(r.volume.cubicYards.low < r.volume.cubicYards.expected)
  assert.ok(r.volume.cubicYards.high > r.volume.cubicYards.expected)

  // A load tier is attached, from the deterministic fraction (3.4 / 44 ≈ 0.077 → 1/8).
  assert.equal(r.v2.loadTier.key, 'eighth')
  assert.equal(r.v2.loadTierVersion, LOAD_TIER_VERSION)

  // ── The price must TRACE to priceJob seeded with the DETERMINISTIC fraction,
  //    NOT the model's volumeHint (40 cu yd). Recompute priceJob independently.
  const detFraction = r.volume.truckFraction.expected
  const expected = priceJob({
    settings: DEFAULT_DISPOSAL,
    category: 'general',
    loadSize: 'few-items',       // 0.077 → few-items bucket
    fillPctOverride: detFraction,
    photoAdjusted: true,
  })
  const round5 = (n: number) => Math.round(n / 5) * 5
  const expectedRecommendedUsd = Math.max(expected.low, round5((expected.low + expected.high) / 2))
  assert.equal(r.pricing.rangeCents.low, Math.round(expected.low * 100), 'low price must equal priceJob low')
  assert.equal(r.pricing.recommendedCents, Math.round(expectedRecommendedUsd * 100), 'recommended must equal priceJob recommended')

  // Prove the hint would have produced a WILDLY different price (multi-load) — so
  // if the bridge had used it, the price would differ. It does not.
  const hintPriced = priceJob({ settings: DEFAULT_DISPOSAL, category: 'general', fillPctOverride: 40 / 44 })
  assert.notEqual(r.pricing.rangeCents.low, Math.round(hintPriced.low * 100), 'price must NOT trace to the model volumeHint')
})

// ── 2. Overlapping merged object counted once ────────────────────────────────
test('a merged object seen across images is counted once (not per-image)', () => {
  const v2 = v2Of({
    unifiedInventory: [
      obj({ objectId: 'o1', description: 'sofa', quantity: 1, minQuantity: 1, maxQuantity: 1, sourceImageIds: ['img_1', 'img_2'], duplicateReasoning: 'same sofa from two angles' }),
    ],
  })
  const inv = inventoryFromV2(v2)
  assert.equal(inv.length, 1, 'one unified object → one inventory item')
  assert.equal(inv[0].count, 1, 'counted once despite two source images')
  assert.deepEqual(inv[0].sourceImageIds, ['img_1', 'img_2'])

  const r = estimateFromV2(v2)
  assert.equal(r.volume.cubicYards.expected, 1.2, 'volume reflects one sofa, not two')
})

// ── 3. Hazardous item → surcharge/review path + manual review ────────────────
test('hazardous item → manual review + restricted-item surfacing', () => {
  const v2 = v2Of({
    unifiedInventory: [
      obj({ objectId: 'o1', category: 'paint cans', description: 'paint and solvents', disposalClass: 'hazardous', weightClass: 'light' }),
    ],
    disposalAssessment: { surchargeItems: ['hazardous'], hazardousPossible: true, specialtyItems: [] },
    perImageObservations: [{
      imageId: 'img_1', sceneDescription: 'garage', locationType: 'garage', items: [],
      hazardousConcern: true, electronicWaste: false, refrigerantAppliance: false, mattressOrBoxSpring: false,
      tire: false, paintOrChemical: true, constructionDebris: false, yardWaste: false, looseDebris: false, baggedMaterial: false,
      stairsVisible: false, elevatorVisible: false, doorwayLimitation: false, narrowHallway: false, longCarryIndication: false,
      disassemblyLikely: false, uncertainObservations: [], imageQuality: 'good', confidence: 'high',
    }],
  })
  const r = estimateFromV2(v2)
  assert.equal(r.manualReviewRequired, true, 'hazardous must force manual review')
  assert.equal(r.v2.confidence.band, 'low', 'hazard caps confidence at low')
  assert.ok(r.restrictedItems.length > 0, 'hazardous item is surfaced as restricted')
  assert.equal(r.v2.decision, 'manual_review', 'pricing decision routes to a human')
  assert.equal(r.riskLevel, 'high')
})

// ── 4. Low-confidence V2 → 'low' band, wider range, manual review ────────────
test('low-confidence / wide-count V2 → low band + wider volume band + manual review', () => {
  const narrow = v2Of({
    unifiedInventory: [obj({ description: 'chairs', quantity: 4, minQuantity: 4, maxQuantity: 4, confidence: 'high' })],
    confidenceScore: 0.85,
  })
  const wide = v2Of({
    imageCountReceived: 3, imageCountUsable: 1,
    imageQualityResults: [
      { imageId: 'img_1', quality: 'good', warnings: [] },
      { imageId: 'img_2', quality: 'unusable', warnings: ['blurry'] },
      { imageId: 'img_3', quality: 'unusable', warnings: ['dark'] },
    ],
    unifiedInventory: [obj({ description: 'chairs', quantity: 4, minQuantity: 2, maxQuantity: 10, confidence: 'low' })],
    confidenceScore: 0.3,
    missingInformation: ['How many rooms?'],
  })

  const rNarrow = estimateFromV2(narrow)
  const rWide = estimateFromV2(wide)

  const widthNarrow = rNarrow.volume.cubicYards.high - rNarrow.volume.cubicYards.low
  const widthWide = rWide.volume.cubicYards.high - rWide.volume.cubicYards.low
  // Same likely count, but the wide min/max spread + low confidence widen the band.
  assert.ok(widthWide > widthNarrow, 'uncertain counts must widen the deterministic band')
  assert.equal(rWide.v2.confidence.band, 'low')
  assert.equal(rWide.manualReviewRequired, true)
  assert.ok(rNarrow.v2.confidence.band !== 'low', 'the confident read is not forced to low')
})

// ── 5. Empty V2 → minimum, manual review, no throw ───────────────────────────
test('empty V2 → safe minimum + manual review (never throws)', () => {
  const r = estimateFromV2(v2Of({ unifiedInventory: [] }))
  assert.equal(r.inventory.length, 0)
  assert.equal(r.volume.cubicYards.expected, 0)
  assert.equal(r.manualReviewRequired, true, 'no items → manual review')
  // Still priced at (at least) the service minimum via priceJob — never 0/negative.
  assert.ok(r.pricing.rangeCents.low >= DEFAULT_DISPOSAL.serviceMinimumCents, 'floored at the service minimum')
})

test('malformed V2 input → failsafe manual-review shell, never throws', () => {
  // @ts-expect-error deliberately passing junk
  const r = estimateFromV2(null)
  assert.equal(r.manualReviewRequired, true)
  assert.equal(r.v2.confidence.band, 'low')
  assert.equal(r.riskLevel, 'high')
})

// ── 6. Load-tier boundaries map correctly ────────────────────────────────────
test('load-tier catalog is ordered, contiguous, and boundaries resolve', () => {
  // Contiguity: each tier's high equals the next tier's low.
  for (let i = 0; i < LOAD_TIERS.length - 1; i++) {
    assert.equal(LOAD_TIERS[i].fractionHigh, LOAD_TIERS[i + 1].fractionLow, 'tiers must be contiguous')
  }
  assert.equal(LOAD_TIERS[0].fractionLow, 0)
  assert.equal(LOAD_TIERS[LOAD_TIERS.length - 1].fractionHigh, Infinity)

  assert.equal(loadTierFor(0).key, 'minimum_pickup')
  assert.equal(loadTierFor(0.125).key, 'eighth')
  assert.equal(loadTierFor(0.25).key, 'quarter')
  assert.equal(loadTierFor(0.5).key, 'half')
  assert.equal(loadTierFor(0.75).key, 'three_quarter')
  assert.equal(loadTierFor(1.0).key, 'full')
  assert.equal(loadTierFor(1.5).key, 'more_than_one_load')
  assert.equal(loadTierFor(4).key, 'on_site_required')
  // Boundary is inclusive-low / exclusive-high.
  assert.equal(loadTierFor(0.0625).key, 'eighth')
  assert.equal(loadTierFor(-5).key, 'minimum_pickup', 'negative clamps to the first tier')
})

// ── 7. Confidence bands are deterministic + volumeHint never overrides volume ──
test('computeConfidence is deterministic and idempotent', () => {
  const v2 = v2Of({ unifiedInventory: [obj({ quantity: 2, minQuantity: 2, maxQuantity: 2 })] })
  const vol = estimateVolume(inventoryFromV2(v2))
  const a = computeConfidence(v2, vol)
  const b = computeConfidence(v2, vol)
  assert.deepEqual(a, b, 'same inputs → identical confidence result')
  assert.equal(CONFIDENCE_VERSION, 1)
  assert.ok(a.score >= 0 && a.score <= 1, 'score is an internal 0..1 (no false precision)')
  assert.ok(['high', 'medium', 'low'].includes(a.band))
})

test('a large model volumeHint does NOT change the deterministic volume', () => {
  const items = [obj({ description: 'sofa', quantity: 1, minQuantity: 1, maxQuantity: 1 })]
  const withHint = estimateFromV2(v2Of({ unifiedInventory: items, volumeHint: { likelyCubicYards: 99, maxCubicYards: 120 } }))
  const noHint = estimateFromV2(v2Of({ unifiedInventory: items, volumeHint: {} }))
  assert.deepEqual(withHint.volume, noHint.volume, 'volumeHint must not alter the deterministic volume')
  assert.deepEqual(withHint.pricing.rangeCents, noHint.pricing.rangeCents, 'volumeHint must not alter pricing')
  // The hint is still recorded for audit + divergence, but it is advisory only.
  assert.equal(withHint.v2.volumeHintCubicYards, 99)
  assert.ok((withHint.v2.volumeHintDivergence ?? 0) > 0.5, 'divergence is measured but not acted on for volume/price')
})
