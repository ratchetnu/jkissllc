// Operion Shadow Analytics — pure evaluation engine tests.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeShadowAnalytics, detectDisagreements, modelScorecards, readinessScore,
  timeSeriesRollup, DEFAULT_READINESS_THRESHOLDS,
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
    groundTruth: over.groundTruth,
    completedAt: over.completedAt ?? 1000,
  }
}

const GT = { actualQuoteUsd: 300 }

test('computeShadowAnalytics: agreement / auto-quote / confidence distribution', () => {
  const jobs = [
    job({ groundTruth: GT, comparison: { outcome: 'equivalent', shadowManualReview: false, shadowConfidenceBand: 'medium' } }),
    job({ groundTruth: GT, comparison: { outcome: 'better_than_authoritative', shadowManualReview: false, shadowConfidenceBand: 'high' } }),
    job({ groundTruth: GT, comparison: { outcome: 'worse', shadowManualReview: true, shadowConfidenceBand: 'low', manualReviewDiffers: true } }),
    job({ status: 'queued', comparison: undefined }),  // not evaluated
  ]
  const a = computeShadowAnalytics(jobs)
  assert.equal(a.total, 4)
  assert.equal(a.evaluated, 3)
  assert.equal(a.groundTruthEvaluated, 3)
  assert.equal(a.awaitingGroundTruth, 0)
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
  const good = (n: number) => Array.from({ length: n }, (_, i) => job({ bookingId: `b${i}`, groundTruth: GT, comparison: { outcome: 'equivalent', shadowManualReview: false } }))
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


// ── Ground-truth semantics (the JK-B-1019 regression) ────────────────────────

test('awaiting ground truth is UNJUDGED, never a disagreement', () => {
  // The exact production shape: V2 $365 vs V1 $360 (Δ1.4%), no owner benchmark yet.
  // Before this fix the dashboard read agreement 0% / disagreement 100% while listing
  // ZERO disagreements — a self-contradicting verdict on a near-perfect result.
  const jobs = [job({
    comparison: {
      outcome: 'needs_ground_truth', shadowManualReview: false,
      authoritativeRecommendedUsd: 360, shadowRecommendedUsd: 365, quoteDeltaUsd: 5, quoteDeltaPct: 1.4,
    },
  })]
  const a = computeShadowAnalytics(jobs)
  assert.equal(a.evaluated, 1)
  assert.equal(a.groundTruthEvaluated, 0)
  assert.equal(a.awaitingGroundTruth, 1)
  assert.equal(a.disagreementPct, 0, 'MUST NOT report 100% disagreement on an unjudged evaluation')
  assert.equal(a.agreementPct, 0, '0 of 0 — no verdicts yet, not "0% agreement"')
  assert.equal(detectDisagreements(jobs).length, 0, 'headline and list must not contradict each other')
  assert.equal(a.avgV1ErrorPct, null)
  assert.equal(a.avgV2ErrorPct, null)
})

test('mixed ground-truth: only the benchmarked evaluations form the denominator', () => {
  const jobs = [
    job({ bookingId: 'g1', groundTruth: GT, comparison: { outcome: 'equivalent', shadowManualReview: false } }),
    job({ bookingId: 'g2', groundTruth: GT, comparison: { outcome: 'worse', shadowManualReview: false } }),
    job({ bookingId: 'a1', comparison: { outcome: 'needs_ground_truth', shadowManualReview: false } }),
    job({ bookingId: 'a2', comparison: { outcome: 'needs_ground_truth', shadowManualReview: false } }),
  ]
  const a = computeShadowAnalytics(jobs)
  assert.equal(a.evaluated, 4)
  assert.equal(a.groundTruthEvaluated, 2)
  assert.equal(a.awaitingGroundTruth, 2)
  assert.equal(a.agreementPct, 50, '1 of the 2 JUDGED agree — the 2 unjudged are not in the denominator')
  assert.equal(a.disagreementPct, 50)
  assert.equal(a.autoQuoteRate, 100, 'auto-quote rate still spans ALL evaluated — it needs no benchmark')
})

test('V1/V2 error vs ground truth is the head-to-head the owner cares about', () => {
  const jobs = [job({
    groundTruth: { actualQuoteUsd: 400 },
    comparison: { outcome: 'equivalent', authoritativeRecommendedUsd: 360, shadowRecommendedUsd: 380 },
  })]
  const a = computeShadowAnalytics(jobs)
  assert.equal(a.avgV1ErrorPct, 10)   // |360-400|/400
  assert.equal(a.avgV2ErrorPct, 5)    // |380-400|/400 → V2 is closer to reality
})

test('a zero/absent ground-truth quote is not usable ground truth', () => {
  for (const gt of [{ actualQuoteUsd: 0 }, { notes: 'no number yet' }, undefined]) {
    const a = computeShadowAnalytics([job({ groundTruth: gt, comparison: { outcome: 'needs_ground_truth' } })])
    assert.equal(a.groundTruthEvaluated, 0, `${JSON.stringify(gt)} must not count`)
  }
  // actualFinalUsd is an acceptable fallback benchmark.
  assert.equal(computeShadowAnalytics([job({ groundTruth: { actualFinalUsd: 300 }, comparison: { outcome: 'equivalent' } })]).groundTruthEvaluated, 1)
})

test('readiness ignores evaluations the owner has not benchmarked', () => {
  const noGt = Array.from({ length: 200 }, (_, i) => job({ bookingId: `n${i}`, comparison: { outcome: 'needs_ground_truth', shadowManualReview: false } }))
  const r = readinessScore(noGt)
  assert.equal(r.tier, 'NEEDS_MORE_DATA', '200 evaluations but 0 verified ⇒ still cannot judge the model')
  assert.equal(r.score, 0)
  assert.match(r.reasons.join(' '), /awaiting ground truth/)
})

test('rollup agreement shares the ground-truth denominator', () => {
  const now = 1_000_000_000
  const jobs = [
    job({ bookingId: 'g', groundTruth: GT, completedAt: now - 3_600_000, comparison: { outcome: 'equivalent', shadowManualReview: false } }),
    job({ bookingId: 'a', completedAt: now - 3_600_000, comparison: { outcome: 'needs_ground_truth', shadowManualReview: false } }),
  ]
  const buckets = timeSeriesRollup(jobs, '24h', now)
  const b = buckets.find((x: { count: number }) => x.count > 0)!
  assert.equal(b.count, 2, 'both are evaluations')
  assert.equal(b.groundTruthCount, 1, 'only one is benchmarked')
  assert.equal(b.agreementPct, 100, '1 of the 1 judged agrees — the unjudged one must not drag it to 50%')
})
