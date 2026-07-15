// Estimation Phases 8–10 — shadow comparison, metrics, clarification.
// Runs pure functions against minimal mock EstimationResult objects (no Redis, no
// network, no model). Asserts:
//   • buildShadowComparison computes delta + deltaPct (null when no current)
//   • recordShadowComparison never throws + never emits customer PII (safe keys only)
//   • computeEstimationMetrics returns nulls without data, correct MAPE/underquote with
//   • clarificationsFor returns targeted questions (each with a reason, ≤4) for
//     low-confidence / specific-uncertainty inputs, and [] when confidence is high
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildShadowComparison, recordShadowComparison, SHADOW_LOG_SAFE_KEYS } from '../app/lib/estimation/shadow'
import { computeEstimationMetrics, type EstimationSample } from '../app/lib/estimation/metrics'
import { clarificationsFor } from '../app/lib/estimation/clarify'
import type { EstimationResult, InventoryItem, Band } from '../app/lib/estimation/types'

// ── Mock builders (minimal, against the type) ────────────────────────────────
const band = (expected: number, low = expected, high = expected): Band => ({ low, expected, high })

function mockItem(over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    taxonomyId: 'furniture',
    category: 'furniture',
    itemName: 'Sofa',
    count: 1,
    countConfidence: 0.9,
    sourceImageIds: ['img1'],
    ...over,
  }
}

function mockResult(over: Partial<EstimationResult> = {}): EstimationResult {
  return {
    engineVersion: 1,
    schemaVersion: 1,
    taxonomyVersion: 1,
    pricingRuleVersion: 'v1',
    imageCount: 3,
    inventory: [mockItem()],
    volume: {
      cubicFeet: band(200),
      cubicYards: band(7.4),
      truckFraction: band(0.4),
      truckLoads: band(1),
      recommendedTruckType: 'box',
    },
    weight: { pounds: band(800), heavyItems: [], denseDebrisPresent: false },
    complexity: {
      level: 'low',
      recommendedCrewSize: 2,
      recommendedTruckType: 'box',
      laborHours: band(2),
      loadMinutes: band(40),
      recommendedEquipment: [],
      ppeRequirements: [],
      accessFactors: ['ground-floor'],
      factors: [],
    },
    pricing: {
      pricingRuleVersion: 'v1',
      baseChargeCents: 15000,
      adjustments: [],
      minimumChargeApplied: false,
      marginEstimateCents: 5000,
      recommendedCents: 42000,
      rangeCents: { low: 38000, high: 46000 },
      assumptions: [],
    },
    riskLevel: 'low',
    restrictedItems: [],
    confidenceScore: 0.9,
    confidenceByDimension: { inventory: 0.9, volume: 0.9, access: 0.9 },
    clarificationRequired: false,
    clarificationQuestions: [],
    manualReviewRequired: false,
    manualReviewReasons: [],
    ...over,
  }
}

// ── shadow: buildShadowComparison ────────────────────────────────────────────
test('buildShadowComparison computes deltaCents + deltaPct against a current estimate', () => {
  const cmp = buildShadowComparison(mockResult(), { recommendedUsd: 400, decision: 'auto' })
  assert.equal(cmp.newRecommendedCents, 42000)
  assert.equal(cmp.currentRecommendedCents, 40000)
  assert.equal(cmp.deltaCents, 2000)
  assert.equal(cmp.deltaPct, 5)                 // 2000/40000 = 5%
  assert.equal(cmp.currentDecision, 'auto')
  assert.equal(cmp.newDecision, 'auto')
  assert.equal(cmp.volumeCubicYards, 7.4)
  assert.equal(cmp.truckLoads, 1)
  assert.equal(cmp.engineVersion, 1)
})

test('buildShadowComparison → deltaPct null when there is no current estimate', () => {
  const cmp = buildShadowComparison(mockResult())
  assert.equal(cmp.currentRecommendedCents, undefined)
  assert.equal(cmp.deltaCents, 0)
  assert.equal(cmp.deltaPct, null)
})

test('buildShadowComparison → deltaPct null when current is zero (no divide-by-zero)', () => {
  const cmp = buildShadowComparison(mockResult(), { recommendedUsd: 0 })
  assert.equal(cmp.currentRecommendedCents, 0)
  assert.equal(cmp.deltaPct, null)
})

test('buildShadowComparison → newDecision reflects manual review', () => {
  const cmp = buildShadowComparison(mockResult({ manualReviewRequired: true }))
  assert.equal(cmp.newDecision, 'manual_review')
  assert.equal(cmp.manualReviewRequired, true)
})

// ── shadow: recordShadowComparison (fail-soft + no PII) ──────────────────────
test('recordShadowComparison never throws and emits only SAFE, non-PII keys', () => {
  const cmp = buildShadowComparison(
    mockResult({ bookingId: 'BK-1001' }),
    { recommendedUsd: 400, decision: 'auto' },
  )
  let captured: Record<string, unknown> | null = null
  assert.doesNotThrow(() =>
    recordShadowComparison(cmp, {
      correlationId: 'corr-1',
      tenantId: 'jkiss',
      sink: (_msg, fields) => { captured = fields },
    }),
  )
  assert.ok(captured, 'sink should have been called')
  const payload = captured as Record<string, unknown>

  // Every emitted key must be in the safe allow-list (proves no PII/customer data).
  for (const k of Object.keys(payload)) {
    assert.ok(
      (SHADOW_LOG_SAFE_KEYS as readonly string[]).includes(k),
      `unexpected (potentially unsafe) log key: ${k}`,
    )
  }
  // Positively assert no customer-authored / item content leaked.
  const serialized = JSON.stringify(payload)
  assert.ok(!/Sofa|itemName|inventory|address|uncertaintyNotes/i.test(serialized), 'no item/customer content')
  assert.equal(payload.event, 'vision:shadow-comparison')
  assert.equal(payload.deltaCents, 2000)
})

test('recordShadowComparison is fail-soft even when the sink throws', () => {
  const cmp = buildShadowComparison(mockResult())
  assert.doesNotThrow(() =>
    recordShadowComparison(cmp, { sink: () => { throw new Error('sink boom') } }),
  )
})

// ── metrics: nulls without data ──────────────────────────────────────────────
test('computeEstimationMetrics returns nulls (no fabrication) when ground truth is absent', () => {
  const samples: EstimationSample[] = [
    { predictedItemCount: 5, predictedVolumeCubicYards: 7, recommendedCents: 40000 },
    { predictedItemCount: 3, recommendedCents: 30000 },
  ]
  const m = computeEstimationMetrics(samples)
  assert.equal(m.sampleCount, 2)
  assert.equal(m.priceMape, null)
  assert.equal(m.volumeMape, null)
  assert.equal(m.underquoteRate, null)
  assert.equal(m.overquoteRate, null)
  assert.equal(m.inventoryAccuracy, null)
  assert.equal(m.countAccuracy, null)
  assert.equal(m.manualReviewRate, null)
  assert.equal(m.customerCorrectionRate, null)
  assert.equal(m.avgConfidence, null)
  assert.equal(m.avgLatencyMs, null)
})

test('computeEstimationMetrics on an empty set is all-null but does not throw', () => {
  const m = computeEstimationMetrics([])
  assert.equal(m.sampleCount, 0)
  assert.equal(m.priceMape, null)
  assert.equal(m.underquoteRate, null)
})

// ── metrics: correct MAPE / underquote when data present ─────────────────────
test('computeEstimationMetrics computes priceMape + under/overquote when ground truth present', () => {
  const samples: EstimationSample[] = [
    // predicted 40000, actual 50000 → |Δ|/actual = 20% ; underquote
    { recommendedCents: 40000, actualCents: 50000 },
    // predicted 60000, actual 50000 → 20% ; overquote
    { recommendedCents: 60000, actualCents: 50000 },
  ]
  const m = computeEstimationMetrics(samples)
  assert.equal(m.priceMape, 20)          // mean of 20% and 20%
  assert.equal(m.underquoteRate, 0.5)    // one of two under
  assert.equal(m.overquoteRate, 0.5)     // one of two over
})

test('computeEstimationMetrics computes accuracy + rates over mixed ground truth', () => {
  const samples: EstimationSample[] = [
    {
      predictedItemCount: 5, actualItemCount: 5, inventoryMatch: true,
      predictedVolumeCubicYards: 8, actualVolumeCubicYards: 10,   // 20% err
      manualReviewRequired: false, customerCorrected: false, confidence: 0.8,
      latencyMs: 100, costUsd: 0.01,
    },
    {
      predictedItemCount: 4, actualItemCount: 6, inventoryMatch: false,
      predictedVolumeCubicYards: 12, actualVolumeCubicYards: 10,  // 20% err
      manualReviewRequired: true, customerCorrected: true, confidence: 0.6,
      latencyMs: 300, costUsd: 0.03,
    },
  ]
  const m = computeEstimationMetrics(samples)
  assert.equal(m.inventoryAccuracy, 0.5)
  assert.equal(m.countAccuracy, 0.5)          // first exact, second not
  assert.equal(m.countMeanAbsError, 1)        // (0 + 2)/2
  assert.equal(m.volumeMape, 20)
  assert.equal(m.manualReviewRate, 0.5)
  assert.equal(m.customerCorrectionRate, 0.5)
  assert.equal(m.avgConfidence, 0.7)
  assert.equal(m.avgLatencyMs, 200)
  assert.equal(m.avgCostUsd, 0.02)
})

// ── clarify: targeted questions for uncertainty, [] when confident ───────────
test('clarificationsFor returns [] when the estimate is confident and unambiguous', () => {
  const qs = clarificationsFor(mockResult())
  assert.deepEqual(qs, [])
})

test('clarificationsFor asks about a hidden pile when count confidence is low', () => {
  const qs = clarificationsFor(mockResult({
    inventory: [mockItem({ itemName: 'Debris pile', category: 'household_trash', taxonomyId: 'household_trash', count: 8, countConfidence: 0.4 })],
    confidenceByDimension: { inventory: 0.5, volume: 0.6, access: 0.9 },
  }))
  assert.ok(qs.length >= 1 && qs.length <= 4)
  assert.ok(qs.some(q => q.id === 'hidden_items'))
  for (const q of qs) assert.ok(q.reason && q.reason.length > 0, 'each question carries a reason')
})

test('clarificationsFor asks about appliance disconnect + sectional sections + stairs', () => {
  const qs = clarificationsFor(mockResult({
    inventory: [
      mockItem({ itemName: 'Sectional couch', category: 'furniture', taxonomyId: 'furniture', dimensionConfidence: 0.4 }),
      mockItem({ itemName: 'Refrigerator', category: 'appliance', taxonomyId: 'appliance', dimensionConfidence: 0.4 }),
    ],
    weight: { pounds: band(1500), heavyItems: ['Refrigerator'], denseDebrisPresent: true },
    complexity: {
      level: 'high', recommendedCrewSize: 3, recommendedTruckType: 'box',
      laborHours: band(4), loadMinutes: band(90), recommendedEquipment: [], ppeRequirements: [],
      accessFactors: [], factors: [],
    },
    confidenceByDimension: { inventory: 0.5, volume: 0.6, access: 0.4 },
  }))
  assert.ok(qs.length <= 4, 'never more than 4 questions')
  const ids = qs.map(q => q.id)
  assert.ok(ids.includes('sectional_sections'))
  assert.ok(ids.includes('appliances_connected'))
  assert.ok(ids.includes('items_upstairs'))     // dense/heavy + no access info + low access conf
  for (const q of qs) {
    assert.ok(q.reason && q.reason.length > 0)
    assert.ok(q.question && q.question.length > 0)
  }
})
