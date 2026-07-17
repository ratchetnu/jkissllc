// Operion Shadow Analytics — pure evaluation engine tests.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeShadowAnalytics, detectDisagreements, modelScorecards, readinessScore,
  DEFAULT_READINESS_THRESHOLDS,
} from '../app/lib/estimation/shadow-analytics'
import type { V2ShadowJob, V2Comparison } from '../app/lib/estimation/shadow-types'
import type { EstimationResultV2 } from '../app/lib/estimation/v2-bridge'

// Minimal job builder — only the fields the analytics read.
const BASE_COMPARISON: V2Comparison = {
  comparisonVersion: 1, shadowRecommendedUsd: 300, shadowDecision: 'estimate_range',
  shadowManualReview: false, shadowInventoryCount: 3, outcome: 'equivalent', outcomeReasons: [],
}
function job(over: Partial<Omit<V2ShadowJob, 'comparison'>> & { comparison?: Partial<V2Comparison> }): V2ShadowJob {
  return {
    jobVersion: 1, bookingId: over.bookingId ?? 'b', shadowJobId: 's', status: over.status ?? 'completed',
    idempotencyKey: 'k', estimatorVersion: over.estimatorVersion ?? 2, imageCount: 1, attempts: 1,
    createdBy: 'auto', updatedAt: 1, model: over.model ?? 'anthropic/claude-sonnet-4-6', promptVersion: over.promptVersion ?? 2,
    latencyMs: over.latencyMs ?? 40000, estimatedCostUsd: over.estimatedCostUsd ?? 0.02,
    result: over.result ?? { estimate: { confidenceScore: 0.6, manualReviewReasons: [] } as unknown as EstimationResultV2, questions: [], ok: true },
    comparison: over.comparison ? { ...BASE_COMPARISON, ...over.comparison } : undefined,
    completedAt: over.completedAt ?? 1000,
  }
}

test('computeShadowAnalytics: agreement / auto-quote / confidence distribution', () => {
  const jobs = [
    job({ comparison: { outcome: 'equivalent', shadowManualReview: false, shadowConfidenceBand: 'medium' } }),
    job({ comparison: { outcome: 'better_than_authoritative', shadowManualReview: false, shadowConfidenceBand: 'high' } }),
    job({ comparison: { outcome: 'worse', shadowManualReview: true, shadowConfidenceBand: 'low', manualReviewDiffers: true } }),
    job({ status: 'queued', comparison: undefined }),  // not evaluated
  ]
  const a = computeShadowAnalytics(jobs)
  assert.equal(a.total, 4)
  assert.equal(a.evaluated, 3)
  assert.equal(a.agreementPct, 66.7)          // 2 of 3 agree
  assert.equal(a.autoQuoteRate, 66.7)         // 2 of 3 auto-quote
  assert.equal(a.manualReviewRate, 33.3)
  assert.deepEqual(a.confidenceDistribution, { high: 1, medium: 1, low: 1 })
})

test('detectDisagreements: FN ranks above FP; large price flagged; sorted by severity', () => {
  const jobs = [
    job({ bookingId: 'fn', comparison: { shadowManualReview: false, authoritativeDecision: 'manual_review' } }),   // FALSE NEGATIVE (high)
    job({ bookingId: 'fp', comparison: { shadowManualReview: true, authoritativeDecision: 'estimate_range' } }),   // false positive (medium)
    job({ bookingId: 'price', comparison: { shadowManualReview: false, authoritativeDecision: 'estimate_range', authoritativeRecommendedUsd: 300, quoteDeltaUsd: 400, quoteDeltaPct: 130 } }), // large price (high — >2x)
  ]
  const d = detectDisagreements(jobs)
  assert.ok(d.length >= 3)
  assert.equal(d[0].severity, 'high')
  assert.ok(d.some((x) => x.kind === 'possible_false_negative'))
  assert.ok(d.some((x) => x.kind === 'possible_false_positive'))
  assert.ok(d.some((x) => x.kind === 'large_price_difference'))
})

test('readinessScore: BLOCKED on any false negative (overrides everything)', () => {
  const jobs = [job({ comparison: { shadowManualReview: false, authoritativeDecision: 'manual_review' } })]
  const r = readinessScore(jobs)
  assert.equal(r.tier, 'BLOCKED')
  assert.ok(r.blockers[0].includes('false-negative'))
})

test('readinessScore: NEEDS_MORE_DATA under the minimum sample', () => {
  const jobs = Array.from({ length: 5 }, () => job({ comparison: { outcome: 'equivalent', shadowManualReview: false } }))
  const r = readinessScore(jobs)
  assert.equal(r.tier, 'NEEDS_MORE_DATA')
})

test('readinessScore: tiers scale with sample + agreement', () => {
  const good = (n: number) => Array.from({ length: n }, (_, i) => job({ bookingId: `b${i}`, comparison: { outcome: 'equivalent', shadowManualReview: false } }))
  assert.equal(readinessScore(good(50)).tier, 'READY_FOR_EXPANDED_SHADOW')
  assert.equal(readinessScore(good(120)).tier, 'READY_FOR_LIMITED_ROLLOUT')      // ≥100 + agreement 100%
  assert.equal(readinessScore(good(350)).tier, 'READY_FOR_CUSTOMER_ROLLOUT')     // ≥300 + agreement ≥95%
  assert.equal(DEFAULT_READINESS_THRESHOLDS.maxFalseNegatives, 0)
})

test('modelScorecards: grouped by model×prompt, sorted by count', () => {
  const jobs = [
    job({ model: 'm1', promptVersion: 2, comparison: { outcome: 'equivalent', shadowManualReview: false } }),
    job({ model: 'm1', promptVersion: 2, comparison: { outcome: 'equivalent', shadowManualReview: false } }),
    job({ model: 'm2', promptVersion: 1, comparison: { outcome: 'worse', shadowManualReview: true } }),
  ]
  const cards = modelScorecards(jobs)
  assert.equal(cards.length, 2)
  assert.equal(cards[0].model, 'm1')
  assert.equal(cards[0].count, 2)
  assert.equal(cards[0].autoQuotePct, 100)
})
