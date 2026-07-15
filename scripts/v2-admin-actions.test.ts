// V2 ADMIN CORRECTIONS (Phase 8) — deterministic, owner-only corrections to a stashed
// V2 shadow estimate. Pure functions only: no Redis, no AI provider, no network. A mock
// EstimationResultV2 (built by the real bridge from a mock analysis) goes in; corrected
// estimates + audit summaries come out. The invariant under test: the MODEL NEVER
// RE-PRICES — item/tier edits re-run only the governed volume/weight/tier math and leave
// the deterministic price alone; the dollar figure moves ONLY through the explicit owner
// surcharge / override actions. Corrections are admin-only. Run:
//   tsx scripts/v2-admin-actions.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'

import type { JunkPhotoAnalysisV2, UnifiedObject } from '../app/lib/ai/analysis-schema-v2'
import { ANALYSIS_V2_VERSION } from '../app/lib/ai/analysis-schema-v2'
import { estimateFromV2 } from '../app/lib/estimation/v2-bridge'
import { LOAD_TIERS } from '../app/lib/estimation/load-tier'
import {
  canCorrectV2, v2ObjectId, v2IndexOf, isLoadTierKey,
  correctItemQuantity, markDuplicate, setLoadTier, setSurcharge, buildV2Override,
} from '../app/lib/estimation/v2-corrections'

// ── Mock builders (mirror v2-bridge.test.ts) ─────────────────────────────────
const obj = (over: Partial<UnifiedObject> = {}): UnifiedObject => ({
  objectId: 'object_001', category: 'furniture', description: 'sofa',
  quantity: 1, minQuantity: 1, maxQuantity: 1, sourceImageIds: ['img_1'],
  weightClass: 'medium', disposalClass: 'landfill', specialHandling: [], confidence: 'high', ...over,
})

const v2Of = (over: Partial<JunkPhotoAnalysisV2> = {}): JunkPhotoAnalysisV2 => ({
  schemaVersion: ANALYSIS_V2_VERSION, bookingId: 'b1', analyzedAt: '2026-07-15T00:00:00Z',
  model: 'anthropic/claude', promptVersion: 'v2-1', imageCountReceived: 2, imageCountUsable: 2,
  imageQualityResults: [{ imageId: 'img_1', quality: 'good', warnings: [] }],
  perImageObservations: [], unifiedInventory: [], sceneSummary: 'garage',
  accessAssessment: { stairs: false, elevator: false, longCarry: false, narrowAccess: false, parkingRestricted: false, outdoorDistance: false, multipleRoomsOrAreas: false, notes: [] },
  laborAssessment: { estimatedCrewSize: 2, disassemblyRequired: false, heavyLifting: false, oversizedItems: false, applianceHandling: false, ppeRequired: [], potentialSecondTrip: false },
  disposalAssessment: { surchargeItems: [], hazardousPossible: false, specialtyItems: [] },
  volumeHint: {}, confidence: 'high', confidenceScore: 0.85, uncertaintyReasons: [],
  missingInformation: [], recommendedCustomerQuestions: [], manualReviewRequired: false,
  manualReviewReasons: [], customerSafeSummary: 'ok', internalOwnerSummary: 'ok', ...over,
})

// A 2-object estimate: 1 sofa + 1 fridge.
function baseEstimate() {
  return estimateFromV2(v2Of({
    unifiedInventory: [
      obj({ objectId: 'o1', category: 'furniture', description: 'sofa', quantity: 1, minQuantity: 1, maxQuantity: 1 }),
      obj({ objectId: 'o2', category: 'appliance', description: 'refrigerator', quantity: 1, minQuantity: 1, maxQuantity: 1, weightClass: 'heavy', disposalClass: 'appliance-refrigerant' }),
    ],
  }))
}

// ── objectId ↔ index round-trip ──────────────────────────────────────────────
test('v2ObjectId / v2IndexOf round-trip and reject bad ids', () => {
  const est = baseEstimate()
  assert.equal(v2ObjectId(0), 'object_001')
  assert.equal(v2ObjectId(1), 'object_002')
  assert.equal(v2IndexOf(est, 'object_001'), 0)
  assert.equal(v2IndexOf(est, 'object_002'), 1)
  assert.equal(v2IndexOf(est, 'object_999'), -1, 'out-of-range id resolves to -1')
  assert.equal(v2IndexOf(est, 'nope'), -1, 'non-numeric id resolves to -1')
})

// ── 1. correct-item updates quantity + recomputes volume/tier deterministically ─
test('v2-correct-item raises quantity → volume + tier recompute deterministically', () => {
  const est = baseEstimate()
  const beforeVol = est.volume.cubicYards.expected
  const beforeTier = est.v2.loadTier.key
  const beforePrice = est.pricing.recommendedCents

  const r = correctItemQuantity(est, 'object_001', 10) // 1 sofa → 10 sofas
  assert.equal(r.ok, true)
  assert.equal(r.estimate.inventory[0].count, 10, 'quantity is updated')
  assert.ok(r.estimate.volume.cubicYards.expected > beforeVol, 'volume grows deterministically')
  assert.notEqual(r.estimate.v2.loadTier.key, beforeTier, 'load tier re-buckets on the bigger fill')
  assert.equal(r.estimate.v2.truckFraction.expected, r.estimate.volume.truckFraction.expected, 'truck fraction tracks the recomputed volume')
  assert.ok(r.summary.length > 0, 'produces an audit summary')

  // MODEL NEVER RE-PRICES: an item edit leaves the deterministic price untouched.
  assert.equal(r.estimate.pricing.recommendedCents, beforePrice, 'item quantity edit does NOT change the price')

  // Determinism: same input → byte-identical volume/tier.
  const r2 = correctItemQuantity(baseEstimate(), 'object_001', 10)
  assert.deepEqual(r2.estimate.volume.cubicYards, r.estimate.volume.cubicYards)
  assert.equal(r2.estimate.v2.loadTier.key, r.estimate.v2.loadTier.key)

  // Unknown object → fail-soft, original unchanged.
  const bad = correctItemQuantity(est, 'object_999', 5)
  assert.equal(bad.ok, false)
  assert.equal(bad.estimate.volume.cubicYards.expected, beforeVol)
})

// ── 2. mark-duplicate removes the object + recomputes ────────────────────────
test('v2-mark-duplicate drops the object and shrinks the deterministic volume', () => {
  const est = baseEstimate()
  const beforeVol = est.volume.cubicYards.expected
  const beforeLen = est.inventory.length

  const r = markDuplicate(est, 'object_002') // remove the fridge
  assert.equal(r.ok, true)
  assert.equal(r.estimate.inventory.length, beforeLen - 1, 'object removed')
  assert.ok(!r.estimate.inventory.some((i) => /refrigerator/i.test(i.itemName)), 'the fridge is gone')
  assert.ok(r.estimate.volume.cubicYards.expected < beforeVol, 'volume shrinks')
  assert.ok(r.summary.length > 0)

  const bad = markDuplicate(est, 'object_999')
  assert.equal(bad.ok, false)
})

// ── 3. set-tier changes the recommended load tier ────────────────────────────
test('v2-set-tier overrides the load tier (valid keys only)', () => {
  const est = baseEstimate()
  assert.equal(isLoadTierKey('half'), true)
  assert.equal(isLoadTierKey('nope'), false)

  const r = setLoadTier(est, 'half')
  assert.equal(r.ok, true)
  assert.equal(r.estimate.v2.loadTier.key, 'half')
  assert.equal(r.estimate.v2.loadTier.label, LOAD_TIERS.find((t) => t.key === 'half')!.label)
  assert.ok(r.summary.length > 0)

  const bad = setLoadTier(est, 'not_a_tier')
  assert.equal(bad.ok, false)
  assert.equal(bad.estimate.v2.loadTier.key, est.v2.loadTier.key, 'invalid tier leaves it unchanged')
})

// ── 4. set-surcharge is the ONLY item path that moves the deterministic $ ─────
test('v2-set-surcharge add/remove adjusts recommended + range deterministically', () => {
  const est = baseEstimate()
  const beforeRec = est.pricing.recommendedCents
  const beforeAdj = est.pricing.adjustments.length

  const added = setSurcharge(est, 'Mattress fee', 3500, true)
  assert.equal(added.ok, true)
  assert.equal(added.estimate.pricing.recommendedCents, beforeRec + 3500, 'surcharge adds to recommended')
  assert.equal(added.estimate.pricing.rangeCents.high, est.pricing.rangeCents.high + 3500)
  assert.equal(added.estimate.pricing.adjustments.length, beforeAdj + 1)
  assert.match(added.estimate.pricing.adjustments.at(-1)!.reason, /owner surcharge/i, 'stamped as an owner surcharge')

  const removed = setSurcharge(added.estimate, 'Mattress fee', 0, false)
  assert.equal(removed.ok, true)
  assert.equal(removed.estimate.pricing.recommendedCents, beforeRec, 'removing restores the price')
  assert.equal(removed.estimate.pricing.adjustments.length, beforeAdj)

  assert.equal(setSurcharge(est, '', 100, true).ok, false, 'empty label rejected')
  assert.equal(setSurcharge(est, 'X', 0, true).ok, false, 'zero add rejected')
  assert.equal(setSurcharge(est, 'ghost', 0, false).ok, false, 'removing a missing surcharge rejected')
})

// ── 5. override sets the quote + reason, and is admin-only ────────────────────
test('v2-override requires a price + reason, and corrections are admin-only', () => {
  // Admin gate — only the owner may correct.
  assert.equal(canCorrectV2('admin'), true)
  assert.equal(canCorrectV2('manager'), false, 'manager rejected')
  assert.equal(canCorrectV2('crew'), false, 'crew rejected')
  assert.equal(canCorrectV2(undefined), false, 'no role rejected')

  const ok = buildV2Override(450, 'Bulky piano surcharge, phone-confirmed', 'owner@jkiss', '2026-07-15T00:00:00Z')
  assert.equal(ok.ok, true)
  assert.equal(ok.override!.overriddenUsd, 450)
  assert.equal(ok.override!.reason, 'Bulky piano surcharge, phone-confirmed')
  assert.equal(ok.override!.by, 'owner@jkiss')
  assert.ok(ok.summary.includes('450'), 'audit summary carries the amount')

  assert.equal(buildV2Override(0, 'x', 'o', 't').ok, false, 'zero price rejected')
  assert.equal(buildV2Override(-5, 'x', 'o', 't').ok, false, 'negative price rejected')
  assert.equal(buildV2Override(100, '   ', 'o', 't').ok, false, 'blank reason rejected')
})

// ── 6. every mutating correction yields an auditable summary + meta ──────────
test('every correction returns a non-empty audit summary + meta (timeline evidence)', () => {
  const est = baseEstimate()
  const results = [
    correctItemQuantity(est, 'object_001', 3),
    markDuplicate(est, 'object_001'),
    setLoadTier(est, 'quarter'),
    setSurcharge(est, 'Stairs fee', 2500, true),
  ]
  for (const r of results) {
    assert.equal(r.ok, true)
    assert.ok(r.summary.length > 0, 'has an audit summary')
    assert.ok(r.meta && typeof r.meta === 'object' && Object.keys(r.meta).length > 0, 'has structured audit meta')
  }
})
