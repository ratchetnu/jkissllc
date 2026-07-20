import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareOptimizationOutcome, aggregateOptEval, type OptEvalSample,
} from '../app/lib/estimation/image-opt-eval'

const base: OptEvalSample = {
  itemCount: 5,
  totalVolumeCuYd: 12,
  truckLoadFraction: 0.5,
  confidence: 0.8,
  detectedLabels: ['couch', 'mattress', 'tv', 'boxes', 'chair'],
  latencyMs: 4000,
  bytes: 3_000_000,
  estTokens: 8000,
  costUsd: 0.02,
}

test('an accurate + cheaper derivative is safe to promote', () => {
  const derivative: OptEvalSample = {
    ...base,
    totalVolumeCuYd: 12.3,       // +2.5%
    truckLoadFraction: 0.51,
    confidence: 0.79,            // -0.01
    latencyMs: 2600,             // faster
    bytes: 600_000,             // -80%
    estTokens: 2200,            // -72.5%
    costUsd: 0.006,
  }
  const r = compareOptimizationOutcome(base, derivative)
  assert.equal(r.accuracyRegression, false)
  assert.equal(r.measurableBenefit, true)
  assert.equal(r.verdict, 'safe_to_promote')
  assert.ok(r.tokenReductionPct > 50)
  assert.ok(r.latencyImprovedPct > 0)
})

test('a volume shift beyond tolerance is an accuracy regression (never promoted)', () => {
  const derivative: OptEvalSample = { ...base, totalVolumeCuYd: 15, estTokens: 2000, bytes: 500_000 }
  const r = compareOptimizationOutcome(base, derivative) // +25% volume
  assert.equal(r.accuracyRegression, true)
  assert.equal(r.verdict, 'accuracy_regression')
  assert.ok(r.reasons.some(x => x.startsWith('volume_shift')))
})

test('dropping a detected object breaches the object-overlap floor', () => {
  const derivative: OptEvalSample = {
    ...base,
    detectedLabels: ['couch', 'mattress'], // lost 3 of 5 → jaccard 0.4
    itemCount: 2,
    estTokens: 2000,
  }
  const r = compareOptimizationOutcome(base, derivative)
  assert.equal(r.accuracyRegression, true)
  assert.ok(r.reasons.some(x => x.startsWith('object_overlap')))
})

test('a confidence collapse is caught', () => {
  const derivative: OptEvalSample = { ...base, confidence: 0.6, estTokens: 2000 } // -0.2 > 0.1
  const r = compareOptimizationOutcome(base, derivative)
  assert.equal(r.accuracyRegression, true)
  assert.ok(r.reasons.some(x => x.startsWith('confidence_drop')))
})

test('accuracy preserved but no saving → no_regression_no_benefit', () => {
  const derivative: OptEvalSample = { ...base } // identical, no reduction
  const r = compareOptimizationOutcome(base, derivative)
  assert.equal(r.accuracyRegression, false)
  assert.equal(r.measurableBenefit, false)
  assert.equal(r.verdict, 'no_regression_no_benefit')
})

test('label sets that are both empty count as full overlap', () => {
  const o: OptEvalSample = { ...base, detectedLabels: [], itemCount: 0 }
  const d: OptEvalSample = { ...base, detectedLabels: [], itemCount: 0, estTokens: 2000 }
  const r = compareOptimizationOutcome(o, d)
  assert.equal(r.labelJaccard, 1)
  assert.equal(r.accuracyRegression, false)
})

test('aggregate recommends promotion only under the regression-rate + saving bars', () => {
  const good = compareOptimizationOutcome(base, { ...base, estTokens: 2000, bytes: 500_000, latencyMs: 2000 })
  const results = Array.from({ length: 50 }, () => good)
  const agg = aggregateOptEval(results)
  assert.equal(agg.regressions, 0)
  assert.equal(agg.regressionRate, 0)
  assert.ok(agg.meanTokenReductionPct >= 15)
  assert.equal(agg.recommendPromotion, true)
})

test('aggregate blocks promotion when regressions exceed the rate', () => {
  const good = compareOptimizationOutcome(base, { ...base, estTokens: 2000 })
  const bad = compareOptimizationOutcome(base, { ...base, totalVolumeCuYd: 20 })
  // 10% regression rate, above the 2% default bar.
  const results = [...Array(9).fill(good), bad]
  const agg = aggregateOptEval(results)
  assert.ok(agg.regressionRate > 0.02)
  assert.equal(agg.recommendPromotion, false)
})

test('empty aggregate is inert', () => {
  const agg = aggregateOptEval([])
  assert.equal(agg.samples, 0)
  assert.equal(agg.recommendPromotion, false)
})
