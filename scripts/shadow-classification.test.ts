// Operion Shadow — owner evaluation actions (pure) + time-series rollup tests.
import assert from 'node:assert/strict'
import test from 'node:test'
import { applyShadowAction, isClassification, CLASSIFICATIONS } from '../app/lib/estimation/shadow-classification'
import { timeSeriesRollup } from '../app/lib/estimation/shadow-analytics'
import type { V2ShadowJob, V2Comparison } from '../app/lib/estimation/shadow-types'

const job = (over: Partial<V2ShadowJob> = {}): V2ShadowJob => ({
  jobVersion: 1, bookingId: 'bk1', shadowJobId: 'vs_bk1', status: 'completed', idempotencyKey: 'k',
  estimatorVersion: 2, imageCount: 1, attempts: 1, createdBy: 'auto', updatedAt: 1, ...over,
})

test('isClassification accepts the 6 valid values only', () => {
  assert.equal(CLASSIFICATIONS.length, 6)
  for (const c of CLASSIFICATIONS) assert.equal(isClassification(c), true)
  assert.equal(isClassification('nonsense'), false)
  assert.equal(isClassification(undefined), false)
})

test('classify sets classification + attribution + audit intent', () => {
  const r = applyShadowAction(job(), { type: 'classify', classification: 'false_negative' }, 'owner', 1000)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.job.classification, 'false_negative')
  assert.equal(r.job.classifiedBy, 'owner')
  assert.equal(r.job.classifiedAt, 1000)
  assert.equal(r.priorStatus, undefined)
  assert.equal(r.newStatus, 'false_negative')
})

test('classify rejects an invalid value', () => {
  const r = applyShadowAction(job(), { type: 'classify', classification: 'bogus' as never }, 'owner', 1)
  assert.equal(r.ok, false)
})

test('clear_classification removes it (with prior in audit)', () => {
  const r = applyShadowAction(job({ classification: 'ignored' }), { type: 'clear_classification' }, 'owner', 2)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.job.classification, undefined)
  assert.equal(r.priorStatus, 'ignored')
})

test('assign + note (notes accumulate, attributed, capped)', () => {
  let j = job()
  const a = applyShadowAction(j, { type: 'assign', assignee: '  Dana  ' }, 'owner', 3)
  assert.ok(a.ok && a.job.assignee === 'Dana')
  if (a.ok) j = a.job
  const n1 = applyShadowAction(j, { type: 'note', note: 'looks like a real fridge' }, 'owner', 4)
  assert.ok(n1.ok && n1.job.ownerNotes?.length === 1)
  if (n1.ok) j = n1.job
  const n2 = applyShadowAction(j, { type: 'note', note: 'confirmed' }, 'manager', 5)
  assert.ok(n2.ok && n2.job.ownerNotes?.length === 2 && n2.job.ownerNotes[1].by === 'manager')
  const empty = applyShadowAction(j, { type: 'note', note: '   ' }, 'owner', 6)
  assert.equal(empty.ok, false)
})

// ── rollups ──
const evalJob = (t: number, agree: boolean, auto: boolean): V2ShadowJob => job({
  bookingId: `b${t}`, completedAt: t, latencyMs: 40000,
  result: { estimate: { confidenceScore: 0.6 } as never, questions: [], ok: true },
  comparison: { comparisonVersion: 1, shadowRecommendedUsd: 300, shadowDecision: 'x', shadowManualReview: !auto, shadowInventoryCount: 1, outcome: agree ? 'equivalent' : 'worse', outcomeReasons: [] } as V2Comparison,
})

test('timeSeriesRollup: buckets by window; agreement/auto within each bucket', () => {
  const now = 100 * 3_600_000                // t=100h
  const jobs = [
    evalJob(now - 30 * 60_000, true, true),  // 30m ago
    evalJob(now - 90 * 60_000, false, false),// 90m ago
    evalJob(now - 26 * 3_600_000, true, true), // 26h ago — outside the 24h window
  ]
  const r = timeSeriesRollup(jobs, '24h', now)
  assert.equal(r.length, 24)                 // hourly buckets over 24h
  const inWindow = r.reduce((s, b) => s + b.count, 0)
  assert.equal(inWindow, 2)                   // the 26h-ago one is excluded
  const last = r[r.length - 1]               // most-recent bucket has the 30m-ago job
  assert.ok(last.count >= 1 && last.agreementPct === 100 && last.autoQuotePct === 100)
})
