// Operion AI Learning — pure analytics engine tests. No I/O, no AI, fixed `now`.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  evalErrorFor, evalErrors, learningOverview, leaderboards, categoryHeatmap,
  learningReadiness, learningRecommendations, learningTrends, applyLearningFilter,
  evalErrorsToCsv, isLearningCategory, LEARNING_CATEGORIES,
} from '../app/lib/estimation/shadow-learning'
import type { V2ShadowJob, V2Comparison, GroundTruthSource } from '../app/lib/estimation/shadow-types'
import type { EstimationResultV2 } from '../app/lib/estimation/v2-bridge'

const NOW = 1_760_000_000_000
const DAY = 86_400_000

// A completed evaluation: V1, V2, ground truth, optional confidence + categories.
function ev(over: {
  id?: string; v1?: number; v2: number; gt?: number; at?: number; confidence?: number
  categories?: string[]; model?: string; promptVersion?: number; status?: V2ShadowJob['status']; source?: GroundTruthSource
}): V2ShadowJob {
  const comparison: V2Comparison = {
    comparisonVersion: 1, shadowRecommendedUsd: over.v2, shadowDecision: 'auto',
    authoritativeRecommendedUsd: over.v1, authoritativeDecision: 'estimate_range',
    shadowManualReview: false, shadowInventoryCount: 3, outcome: 'needs_ground_truth', outcomeReasons: [],
  }
  return {
    jobVersion: 1, bookingId: over.id ?? Math.random().toString(36).slice(2, 12).padEnd(16, '0'),
    bookingNumber: `JK-${over.id ?? 'x'}`, shadowJobId: 's', status: over.status ?? 'completed',
    idempotencyKey: 'k', estimatorVersion: 2, imageCount: 2, attempts: 1, createdBy: 'owner',
    model: over.model ?? 'anthropic/claude-sonnet-4-6', promptVersion: over.promptVersion ?? 2,
    updatedAt: over.at ?? NOW, completedAt: over.at ?? NOW,
    result: { estimate: { confidenceScore: over.confidence ?? 0.6 } as unknown as EstimationResultV2, questions: [], ok: true },
    comparison,
    groundTruth: over.gt != null ? { actualQuoteUsd: over.gt, source: over.source } : undefined,
    learningCategories: over.categories,
  }
}

// ── evalErrorFor: the head-to-head reduction ─────────────────────────────────

test('evalErrorFor: computes V1/V2 error, winner, improvement', () => {
  const e = evalErrorFor(ev({ v1: 300, v2: 360, gt: 400, confidence: 0.8 }))!
  assert.equal(e.groundTruthUsd, 400)
  assert.equal(e.v1ErrorUsd, 100)   // |300-400|
  assert.equal(e.v2ErrorUsd, 40)    // |360-400|
  assert.equal(e.v1ErrorPct, 25)
  assert.equal(e.v2ErrorPct, 10)
  assert.equal(e.winner, 'v2', 'V2 is closer to reality')
  assert.equal(e.improvementPct, 15) // 25 - 10
  assert.equal(e.confidence, 0.8)
})

test('evalErrorFor: a near-equal pair inside the tie band is a tie, not a win', () => {
  const e = evalErrorFor(ev({ v1: 398, v2: 402, gt: 400 }))!
  assert.equal(e.winner, 'tie', 'within $5 of each other')
})

test('evalErrorFor: V1 closer → V1 wins, improvement negative', () => {
  const e = evalErrorFor(ev({ v1: 405, v2: 460, gt: 400 }))!
  assert.equal(e.winner, 'v1')
  assert.ok((e.improvementPct as number) < 0)
})

test('evalErrorFor: no ground truth → null (excluded from accuracy math)', () => {
  assert.equal(evalErrorFor(ev({ v2: 360 })), null)
  assert.equal(evalErrorFor(ev({ v2: 360, gt: 0 })), null, 'a zero benchmark is not usable ground truth')
})

test('evalErrors excludes non-evaluated + un-benchmarked jobs', () => {
  const jobs = [
    ev({ id: 'a', v2: 360, gt: 400 }),
    ev({ id: 'b', v2: 360 }),                          // no ground truth
    ev({ id: 'c', v2: 360, gt: 400, status: 'queued' }), // not completed
  ]
  assert.equal(evalErrors(jobs).length, 1)
})

// ── overview ─────────────────────────────────────────────────────────────────

test('learningOverview: win/loss/tie percentages + coverage', () => {
  const jobs = [
    ev({ id: '1', v1: 300, v2: 400, gt: 400 }),   // V2 exact → V2 win
    ev({ id: '2', v1: 400, v2: 300, gt: 400 }),   // V1 exact → V1 win
    ev({ id: '3', v1: 399, v2: 401, gt: 400 }),   // tie
    ev({ id: '4', v2: 360 }),                     // completed, no GT (coverage denominator)
  ]
  const o = learningOverview(jobs)
  assert.equal(o.totalEvaluations, 4)
  assert.equal(o.groundTruthsRecorded, 3)
  assert.equal(o.groundTruthCoverage, 75)
  assert.equal(o.v2WinPct, 33.3)
  assert.equal(o.v1WinPct, 33.3)
  assert.equal(o.tiePct, 33.3)
  assert.equal(o.medianErrorPct, 0.3, 'sorted errors 0, 0.25→0.3, 25 → median 0.3')
})

test('learningOverview: empty set is all nulls/zeros, never a crash', () => {
  const o = learningOverview([])
  assert.equal(o.totalEvaluations, 0)
  assert.equal(o.avgV2ErrorPct, null)
  assert.equal(o.v2WinPct, null)
  assert.deepEqual(o.confidenceDistribution, { high: 0, medium: 0, low: 0 })
})

// ── leaderboard ──────────────────────────────────────────────────────────────

test('leaderboards: ranked by lowest error, per prompt version', () => {
  const jobs = [
    ...Array.from({ length: 5 }, (_, i) => ev({ id: `good${i}`, v1: 300, v2: 400, gt: 400, promptVersion: 3 })),   // 0% error
    ...Array.from({ length: 5 }, (_, i) => ev({ id: `bad${i}`, v1: 300, v2: 300, gt: 400, promptVersion: 2 })),    // 25% error
  ]
  const board = leaderboards(jobs).byPromptVersion
  assert.equal(board.length, 2)
  assert.equal(board[0].label, 'Prompt v3', 'best (lowest error) first')
  assert.equal(board[0].avgErrorPct, 0)
  assert.equal(board[0].sampleSize, 5)
  assert.equal(board[0].winRatePct, 100)
  assert.equal(board[1].label, 'Prompt v2')
  assert.equal(board[1].avgErrorPct, 25)
})

// ── category heatmap ─────────────────────────────────────────────────────────

test('categoryHeatmap: groups by owner category, worst error first', () => {
  const jobs = [
    ev({ id: '1', v1: 300, v2: 300, gt: 400, categories: ['construction_debris'] }),  // 25% err
    ev({ id: '2', v1: 300, v2: 300, gt: 400, categories: ['construction_debris'] }),
    ev({ id: '3', v1: 400, v2: 405, gt: 400, categories: ['furniture'] }),            // ~1% err
  ]
  const h = categoryHeatmap(jobs)
  assert.equal(h[0].category, 'construction_debris', 'worst first')
  assert.equal(h[0].count, 2)
  assert.equal(h[0].avgErrorPct, 25)
  assert.equal(h.find((c) => c.category === 'furniture')!.count, 1)
})

test('categoryHeatmap: an evaluation with multiple categories counts in each', () => {
  const h = categoryHeatmap([ev({ v1: 300, v2: 300, gt: 400, categories: ['appliances', 'heavy'] })])
  // 'heavy' is not a real category but is stored verbatim; the heatmap groups by whatever tags exist.
  assert.equal(h.length, 2)
})

// ── readiness ────────────────────────────────────────────────────────────────

test('learningReadiness: below pilot sample → NOT_READY', () => {
  const r = learningReadiness([ev({ v1: 300, v2: 400, gt: 400 })])
  assert.equal(r.tier, 'NOT_READY')
  assert.match(r.reasons.join(' '), /not enough/)
})

test('learningReadiness: a high failure rate is a hard blocker', () => {
  const good = Array.from({ length: 30 }, (_, i) => ev({ id: `g${i}`, v1: 300, v2: 400, gt: 400 }))
  const failed = Array.from({ length: 10 }, (_, i) => ({ ...ev({ id: `f${i}`, v2: 0 }), status: 'failed' as const, comparison: undefined }))
  const r = learningReadiness([...good, ...failed])
  assert.ok(r.blockers.some((b) => /Failure rate/.test(b)))
  assert.equal(r.tier, 'NOT_READY', 'blocked despite a large accurate sample')
  assert.equal(r.score, 0)
})

test('learningReadiness: sufficient sample + improvement → at least PILOT_READY', () => {
  const jobs = Array.from({ length: 25 }, (_, i) => ev({ id: `g${i}`, v1: 300, v2: 400, gt: 400, confidence: 0.8 }))
  const r = learningReadiness(jobs)
  assert.notEqual(r.tier, 'NOT_READY')
  assert.ok((r.avgImprovementPct ?? 0) > 0)
  assert.ok(r.score > 0)
})

test('learningReadiness: V2 not beating V1 blocks promotion', () => {
  const jobs = Array.from({ length: 30 }, (_, i) => ev({ id: `g${i}`, v1: 400, v2: 300, gt: 400 }))  // V1 always wins
  const r = learningReadiness(jobs)
  assert.ok(r.blockers.some((b) => /not yet beating V1/.test(b)))
})

// ── recommendations (deterministic, no AI) ───────────────────────────────────

test('learningRecommendations: too few evaluations → asks for more, no false claims', () => {
  const recs = learningRecommendations([ev({ v1: 300, v2: 400, gt: 400 })])
  assert.equal(recs.length, 1)
  assert.match(recs[0].message, /record more ground truth/i)
})

test('learningRecommendations: flags a systematically underpriced category', () => {
  const jobs = Array.from({ length: 10 }, (_, i) => ev({ id: `b${i}`, v1: 300, v2: 280, gt: 400, categories: ['brush'] }))  // ~30% err
  const recs = learningRecommendations(jobs)
  assert.ok(recs.some((r) => /brush/i.test(r.message) && r.severity === 'action'))
  // Every recommendation carries evidence — no bare assertions.
  for (const r of recs) assert.ok(r.evidence.length > 0)
})

test('learningRecommendations: detects a systematic under-estimation bias', () => {
  const jobs = Array.from({ length: 12 }, (_, i) => ev({ id: `u${i}`, v1: 380, v2: 340, gt: 400 }))  // V2 ~15% under
  const recs = learningRecommendations(jobs)
  assert.ok(recs.some((r) => /UNDER-estimates/.test(r.message)))
})

// ── trends ───────────────────────────────────────────────────────────────────

test('learningTrends: buckets evaluations into weekly/monthly periods', () => {
  const jobs = [
    ev({ id: 'recent', v1: 300, v2: 400, gt: 400, at: NOW - 2 * DAY }),
    ev({ id: 'old', v1: 300, v2: 300, gt: 400, at: NOW - 40 * DAY }),
  ]
  const t = learningTrends(jobs, NOW)
  assert.equal(t.weekly.length, 8)
  assert.equal(t.monthly.length, 6)
  assert.equal(t.rolling30d.length, 8)
  const lastWeek = t.weekly[t.weekly.length - 1]
  assert.equal(lastWeek.count, 1, 'the 2-day-old evaluation lands in the last weekly bucket')
})

// ── explorer filter ──────────────────────────────────────────────────────────

test('applyLearningFilter: each dimension narrows; search spans notes+categories', () => {
  const errs = evalErrors([
    ev({ id: 'a', v1: 300, v2: 400, gt: 400, promptVersion: 3, categories: ['furniture'], source: 'customer_quote' }),
    ev({ id: 'b', v1: 400, v2: 300, gt: 400, promptVersion: 2, categories: ['appliances'], source: 'completed_job' }),
  ])
  assert.equal(applyLearningFilter(errs, { promptVersion: 3 }).length, 1)
  assert.equal(applyLearningFilter(errs, { category: 'appliances' }).length, 1)
  assert.equal(applyLearningFilter(errs, { outcome: 'v2' }).length, 1)
  assert.equal(applyLearningFilter(errs, { groundTruthSource: 'completed_job' }).length, 1)
  assert.equal(applyLearningFilter(errs, { q: 'furniture' }).length, 1)
  assert.equal(applyLearningFilter(errs, {}).length, 2)
})

test('applyLearningFilter: confidence range', () => {
  const errs = evalErrors([
    ev({ id: 'lo', v1: 300, v2: 400, gt: 400, confidence: 0.3 }),
    ev({ id: 'hi', v1: 300, v2: 400, gt: 400, confidence: 0.9 }),
  ])
  assert.equal(applyLearningFilter(errs, { minConfidence: 0.5 }).length, 1)
  assert.equal(applyLearningFilter(errs, { maxConfidence: 0.45 }).length, 1)
})

// ── export ───────────────────────────────────────────────────────────────────

test('evalErrorsToCsv: stable headers, escaped cells, one row per evaluation', () => {
  const csv = evalErrorsToCsv(evalErrors([ev({ id: 'x', v1: 300, v2: 400, gt: 400, categories: ['furniture', 'mixed_load'] })]))
  const lines = csv.split('\n')
  assert.match(lines[0], /^bookingNumber,at,model,promptVersion,groundTruthUsd/)
  assert.equal(lines.length, 2)
  assert.match(lines[1], /furniture; mixed_load/)
})

// ── category vocabulary ──────────────────────────────────────────────────────

test('LEARNING_CATEGORIES: the spec set is present and validated', () => {
  assert.equal(LEARNING_CATEGORIES.length, 18)
  for (const c of ['underestimated_volume', 'mixed_load', 'hazardous_items', 'other']) assert.ok(isLearningCategory(c))
  assert.equal(isLearningCategory('not_a_category'), false)
  assert.equal(isLearningCategory(42), false)
})
