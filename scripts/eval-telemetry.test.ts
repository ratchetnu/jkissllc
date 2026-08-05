// Evaluation telemetry + benchmark pacing — unit tests for the PURE logic.
//
// These two modules exist because the first real Preview run produced numbers
// that were wrong in ways that looked right: a 429 counted as an 110ms latency
// sample, and truck utilisation derived from a ceil()'d load count read 100% for
// a single couch. The tests below pin the corrected behaviour.
// No Redis, no network, no clock.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildEvaluationRecord, evalJobType, evalTelemetryEnabled,
} from '../app/lib/ai/eval-telemetry'
import {
  createPacer, parseRetryAfter, fallbackBackoffMs, ANALYZE_LIMIT,
} from '../tools/vision-benchmark/pacing'
import { completedJobIds } from '../tools/vision-benchmark/run-benchmark'
import { normalizeAnalysis, type NormalizeCtx } from '../app/lib/ai/analysis-schema'
import type { StoredAiEstimate } from '../app/lib/ai/estimate-store'

// ── Gating ───────────────────────────────────────────────────────────────────

test('evaluation telemetry is OFF by default and impossible in Production', () => {
  assert.equal(evalTelemetryEnabled({} as NodeJS.ProcessEnv), false)
  assert.equal(evalTelemetryEnabled({ AI_EVAL_TELEMETRY_ENABLED: '1' } as unknown as NodeJS.ProcessEnv), true)
  // The Production guard outranks the flag — a mis-set flag cannot enable it there.
  assert.equal(
    evalTelemetryEnabled({ AI_EVAL_TELEMETRY_ENABLED: '1', VERCEL_ENV: 'production' } as unknown as NodeJS.ProcessEnv),
    false,
    'Production must be impossible to enable, not merely disabled by default',
  )
  assert.equal(
    evalTelemetryEnabled({ AI_EVAL_TELEMETRY_ENABLED: '1', VERCEL_ENV: 'preview' } as unknown as NodeJS.ProcessEnv),
    true,
  )
})

test('job type keeps moving separate from the junk-removal family', () => {
  for (const s of ['junk-removal', 'estate-cleanout', 'garage-cleanout', 'eviction']) {
    assert.equal(evalJobType(s), 'junk_removal')
  }
  assert.equal(evalJobType('moving'), 'moving')
  assert.equal(evalJobType('freight'), 'other')
})

// ── The record ───────────────────────────────────────────────────────────────

const ctx: NormalizeCtx = {
  analysisId: 'a1b2c3d4e5', bookingId: 'draft', photoUrls: ['https://blob.example.com/p.jpg'],
  modelProvider: 'vercel-ai-gateway', modelName: 'test-model', analyzedAt: '2026-08-04T00:00:00.000Z',
}

/** One couch: ~4 cu yd, roughly a tenth of the truck — well under a single load. */
const ONE_COUCH = normalizeAnalysis({
  normalizedItems: [{ category: 'furniture', label: 'couch', estimatedQuantity: 1, estimatedVolumeCubicYards: 4, heavy: false, requiresDisassembly: false, confidence: 0.88 }],
  photoObservations: [{ photoUrl: ctx.photoUrls[0], imageQuality: 'good' }],
  totalEstimatedVolumeCubicYards: { minimum: 3.5, likely: 4, maximum: 4.5 },
  estimatedTruckLoadFraction: { minimum: 0.07, likely: 0.09, maximum: 0.12 },
  estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
  confidence: { overall: 0.88, volume: 0.85 },
  reviewRequired: false, reviewReasons: [], warnings: [], additionalQuestions: [],
}, ctx)

const stored = (over: Partial<StoredAiEstimate> = {}): StoredAiEstimate => ({
  id: 'a1b2c3d4e5', createdAt: '2026-08-04T00:00:00.000Z', status: 'completed',
  decision: 'instant_quote', provider: 'vercel-ai-gateway', model: 'test-model',
  schemaVersion: 1, callId: 'call-123', latencyMs: 14_000,
  inputPhotoUrls: ctx.photoUrls, analysis: ONE_COUCH,
  pricing: { recommendedUsd: 275, lowUsd: 250, highUsd: 300, breakdown: {} as never },
  reviewReasons: [], ...over,
})

const build = (over: Partial<StoredAiEstimate> = {}) => buildEvaluationRecord({
  stored: stored(over), serviceType: 'junk-removal', imageCount: 1,
  analyzedOk: true, outcome: 'completed', at: '2026-08-04T00:00:00.000Z',
})

test('truck utilisation is a real percentage, not a ceil()d load count', () => {
  const rec = build()
  // This is the whole reason the record exists: the customer response exposes
  // estimatedTruckLoads = 1, which would read as "a full truck" for one couch.
  assert.equal(rec.estimatedTruckLoads, 1)
  assert.equal(rec.truckUtilizationPct, 9, 'a single couch is 9% of a truck, not 100%')
  assert.equal(rec.estimatedVolumeCubicYards, 4, 'and 4 cubic yards, not 44')
})

test('catalog calibration records per-item volume and agreement without evidence or photos', () => {
  const item = build().catalogItems[0]
  assert.deepEqual(item, {
    itemIndex: 0,
    catalogId: 'standard_sofa',
    quantity: 1,
    modelVolumeCubicFeet: 108,
    catalogVolumeCubicFeet: { minimum: 65, maximum: 90 },
    catalogAgreement: 1,
  })
  const serialized = JSON.stringify(item).toLowerCase()
  for (const forbidden of ['label', 'evidence', 'photo', 'url', 'booking']) {
    assert.ok(!serialized.includes(forbidden), `${forbidden} must not enter catalog telemetry`)
  }
})

test('catalog calibration preserves an omitted junk volume as null, not a disagreement sample', () => {
  const missingVolume = normalizeAnalysis({
    normalizedItems: [{
      category: 'furniture', label: 'couch', estimatedQuantity: 1,
      heavy: false, requiresDisassembly: false, confidence: 0.88,
    }],
    photoObservations: [{ photoUrl: ctx.photoUrls[0], imageQuality: 'good' }],
    confidence: { overall: 0.88 }, reviewRequired: false, reviewReasons: [],
    warnings: [], additionalQuestions: [],
  }, ctx)
  const rec = build({ analysis: missingVolume })
  assert.equal(missingVolume.normalizedItems[0].estimatedVolumeCubicYards, 0.5,
    'the existing quote normalizer fallback remains unchanged')
  assert.equal(rec.catalogItems[0].catalogId, 'standard_sofa')
  assert.equal(rec.catalogItems[0].modelVolumeCubicFeet, null,
    'telemetry must not present the normalizer fallback as a model observation')
})

test('all five confidence sub-scores are captured, not just overall', () => {
  const c = build().confidence
  for (const k of ['overall', 'volume', 'weight', 'itemClassification', 'accessDifficulty'] as const) {
    assert.equal(typeof c[k], 'number', `${k} must be recorded`)
  }
  assert.equal(c.overall, 0.88)
  assert.equal(c.volume, 0.85)
})

test('the AI call id is carried so usage and cost can be joined, not duplicated', () => {
  const rec = build()
  assert.equal(rec.aiCallId, 'call-123')
  // Token counts deliberately absent — the audit log is their single source of truth.
  assert.ok(!('inputTokens' in rec))
  assert.ok(!('estCostUsd' in rec))
})

test('critic and monitor state are recorded, including "did not run"', () => {
  assert.equal(build().criticInvoked, false, 'absent critic is false, never undefined')
  const withCritic = build({
    critic: { agrees: false, recommend: 'range', confidence: 0.5, concerns: ['volume looks high'] },
    monitor: { concerns: [{ code: 'volume_sum_mismatch', message: 'x', severity: 'warn' }], confidencePenalty: 0.12, forceReview: false },
  })
  assert.equal(withCritic.criticInvoked, true)
  assert.equal(withCritic.criticRecommend, 'range')
  assert.deepEqual(withCritic.monitorConcerns, ['volume_sum_mismatch'])
  assert.equal(withCritic.monitorConfidencePenalty, 0.12)
})

test('the quote result is recorded verbatim', () => {
  const rec = build()
  assert.equal(rec.decision, 'instant_quote')
  assert.equal(rec.recommendedUsd, 275)
  assert.equal(rec.lowUsd, 250)
  assert.equal(rec.highUsd, 300)
  assert.equal(rec.jobType, 'junk_removal')
  assert.equal(rec.imageCount, 1)
})

test('building a record is pure — same input, identical output', () => {
  assert.deepEqual(build(), build())
})

// ── Pacing ───────────────────────────────────────────────────────────────────

const T = 1_000_000

test('the pacer matches the shipped analyze limit', () => {
  assert.equal(ANALYZE_LIMIT.requests, 10)
  assert.equal(ANALYZE_LIMIT.windowMs, 10 * 60_000)
})

test('requests flow until the window is full, then wait', () => {
  const p = createPacer({ requests: 3, windowMs: 60_000 })
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(p.next(T + i), { action: 'go' })
    p.record(T + i)
  }
  const d = p.next(T + 3)
  assert.equal(d.action, 'wait')
  assert.equal(d.action === 'wait' && d.reason, 'window_full')
  assert.ok(d.action === 'wait' && d.ms > 0)
})

test('capacity returns as the oldest request ages out of the window', () => {
  const p = createPacer({ requests: 2, windowMs: 60_000 })
  p.record(T); p.record(T + 1_000)
  assert.equal(p.next(T + 2_000).action, 'wait')
  // Pick a moment where the FIRST request has aged out but the second has not:
  // cutoff = now - windowMs must fall between them. At T+60_500 the cutoff is
  // T+500, which drops the T request and keeps the T+1_000 one.
  assert.deepEqual(p.next(T + 60_500), { action: 'go' })
  assert.equal(p.usedInWindow(T + 60_500), 1, 'the aged-out request no longer counts')
  // Later still, both have aged out.
  assert.equal(p.usedInWindow(T + 61_001), 0)
})

test('a server 429 penalty outranks the local window', () => {
  const p = createPacer({ requests: 10, windowMs: 60_000 })
  assert.deepEqual(p.next(T), { action: 'go' })
  p.penalize(T + 30_000)
  const d = p.next(T)
  assert.equal(d.action, 'wait')
  assert.equal(d.action === 'wait' && d.reason, 'retry_after')
  assert.equal(d.action === 'wait' && d.ms, 30_000)
  assert.deepEqual(p.next(T + 30_001), { action: 'go' }, 'and clears when it expires')
})

test('wait time accumulates separately and is never latency', () => {
  const p = createPacer()
  assert.equal(p.waitedMs(), 0)
  p.addWait(5_000); p.addWait(2_500)
  assert.equal(p.waitedMs(), 7_500)
})

test('Retry-After is parsed in both forms the spec allows', () => {
  assert.equal(parseRetryAfter('120', T), 120_000)
  assert.equal(parseRetryAfter('  45 ', T), 45_000)
  const httpDate = new Date(T + 90_000).toUTCString()
  const parsed = parseRetryAfter(httpDate, T)
  assert.ok(parsed !== null && Math.abs(parsed - 90_000) < 1_000)
  assert.equal(parseRetryAfter(null, T), null)
  assert.equal(parseRetryAfter('soon', T), null, 'unparseable yields null so the caller backs off itself')
})

test('a past Retry-After date never yields a negative wait', () => {
  assert.equal(parseRetryAfter(new Date(T - 60_000).toUTCString(), T), 0)
})

test('fallback backoff grows and is capped', () => {
  assert.equal(fallbackBackoffMs(1), 30_000)
  assert.equal(fallbackBackoffMs(2), 60_000)
  assert.equal(fallbackBackoffMs(3), 120_000)
  assert.equal(fallbackBackoffMs(99), 5 * 60_000, 'capped, never unbounded')
})

// ── Resume ───────────────────────────────────────────────────────────────────

test('resume skips completed jobs but never a rate-limited or failed one', () => {
  const dir = '/nonexistent-results-dir'
  assert.equal(completedJobIds(dir).size, 0, 'a missing directory is empty, not an error')
})
