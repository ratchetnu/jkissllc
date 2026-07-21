// OPERION AI pipeline observability — unit tests. Exercises the whole stage-timing
// substrate with an in-memory Redis fake and a deterministic injected clock: the live
// Trace accumulation math, idempotent + fail-soft persistence, the read-side per-stage
// percentile aggregation (including the notify-trace partition and sub-stage share
// exclusion), and the flag-gated + nesting-safe runWithTrace lifecycle. No network,
// no Redis, no AI.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  Trace, runWithTrace, timeStage, markStage, markStageFailure, markTraceOutcome, activeTrace,
  PIPELINE_STAGES, PIPELINE_SUBSTAGES, isSubStage, NOTIFY_FEATURE,
  type PipelineTraceRecord,
} from '../app/lib/observability/pipeline-trace'
import {
  recordTrace, getTrace, listTraces, type PipelineTraceStore,
} from '../app/lib/observability/pipeline-metrics'
import {
  aggregatePipeline, percentile,
} from '../app/lib/observability/pipeline-read'

// ── In-memory Redis fake (the PipelineTraceStore surface) ─────────────────────
function memStore(): PipelineTraceStore & { setThrows?: boolean } {
  const kv = new Map<string, string>()
  const z = new Map<string, Map<string, number>>()
  const nx = new Set<string>()
  const slice = (arr: string[], start: number, stop: number) => arr.slice(start, stop < 0 ? undefined : stop + 1)
  const store: PipelineTraceStore & { setThrows?: boolean } = {
    async get(k) { return kv.has(k) ? kv.get(k)! : null },
    async set(k, v) { if (store.setThrows) throw new Error('redis down'); kv.set(k, v) },
    async del(k) { kv.delete(k) },
    async zadd(k, score, member) { let m = z.get(k); if (!m) { m = new Map(); z.set(k, m) } m.set(member, score) },
    async zrevrange(k, start, stop) { const m = z.get(k); if (!m) return []; return slice([...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]), start, stop) },
    async zrange(k, start, stop) { const m = z.get(k); if (!m) return []; return slice([...m.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]), start, stop) },
    async zrem(k, member) { z.get(k)?.delete(member) },
    async zcard(k) { return z.get(k)?.size ?? 0 },
    async setNxPx(k) { if (nx.has(k)) return false; nx.add(k); return true },
  }
  return store
}

const ON = { AI_PIPELINE_OBSERVABILITY_ENABLED: '1' }

// A trace record builder for the read-side tests.
const traceRec = (over: Partial<PipelineTraceRecord> = {}): PipelineTraceRecord => ({
  id: 'srv-t1', at: 1000, tenantId: 'default', feature: 'book-now-ai',
  bookingId: 'bk-1', startedAt: 1000, completedAt: 1500, durationMs: 500,
  status: 'completed', stages: {}, ...over,
})

// ── 1. Live Trace accumulation math ───────────────────────────────────────────
test('Trace accumulates stage totals, counts, and worst occurrence', () => {
  let t = 1000
  const tr = new Trace({ requestId: 'r1', feature: 'book-now-ai', bookingId: 'bk' }, 'default', () => t)
  tr.add('database', 30)
  tr.add('database', 50)          // second write → count 2, max 50
  tr.add('provider', 200)
  tr.add('queue', -5)             // negative clamps to 0
  const rec = ((): PipelineTraceRecord => { t = 1400; return tr.toRecord() })()
  assert.equal(rec.stages.database!.totalMs, 80)
  assert.equal(rec.stages.database!.count, 2)
  assert.equal(rec.stages.database!.maxMs, 50)
  assert.equal(rec.stages.provider!.totalMs, 200)
  assert.equal(rec.stages.queue!.totalMs, 0)
  assert.equal(rec.durationMs, 400)   // completedAt 1400 − startedAt 1000
  assert.equal(rec.id, 'r1')
  assert.equal(rec.bookingId, 'bk')
})

// ── Provider fast-fail sub-stage (structural completeness on a provider failure) ──

test('Trace.add records a failed stage with status/reason/retryable + duration', () => {
  const tr = new Trace({ requestId: 'rf1', feature: 'book-now-ai' }, 'default', () => 0)
  tr.add('provider', 715, { status: 'failed', failureReason: 'provider_unavailable', retryable: true })
  const st = tr.toRecord().stages.provider!
  assert.equal(st.totalMs, 715)
  assert.equal(st.count, 1)
  assert.equal(st.status, 'failed')
  assert.equal(st.failureReason, 'provider_unavailable')
  assert.equal(st.retryable, true)
})

test('markStageFailure emits the provider stage even on an instant (0ms) fast-fail', async () => {
  let captured: PipelineTraceRecord | null = null
  const store = memStore()
  await runWithTrace(
    { requestId: 'rf2', feature: 'book-now-ai', bookingId: 'bk2' },
    async () => { markStageFailure('provider', undefined, 'network', true) },
    { store, env: { AI_PIPELINE_OBSERVABILITY_ENABLED: 'true' } },
  )
  captured = await getTrace('rf2', store)
  const st = captured!.stages.provider!
  assert.equal(st.status, 'failed')
  assert.equal(st.failureReason, 'network')
  assert.equal(st.retryable, true)
  assert.equal(st.totalMs, 0)     // instant fail → 0ms, but the stage IS present
  assert.equal(st.count, 1)
})

test('markStageFailure is a no-op with no active trace (flag off / non-worker path)', () => {
  assert.doesNotThrow(() => markStageFailure('provider', 100, 'auth', false))
})

test('schema compat: a legacy stage record (no failure fields) aggregates unchanged', () => {
  // Old records lack status/failureReason/retryable — the read layer must ignore them.
  const legacy: PipelineTraceRecord = {
    id: 'leg1', at: 0, tenantId: 'default', feature: 'book-now-ai',
    startedAt: 0, completedAt: 100, durationMs: 100,
    stages: { provider: { totalMs: 50, count: 1, maxMs: 50 } }, // no failure fields
  }
  const failed: PipelineTraceRecord = {
    id: 'fail1', at: 0, tenantId: 'default', feature: 'book-now-ai',
    startedAt: 0, completedAt: 10, durationMs: 10,
    stages: { provider: { totalMs: 0, count: 1, maxMs: 0, status: 'failed', failureReason: 'provider_unavailable', retryable: true } },
  }
  const agg = aggregatePipeline([legacy, failed])
  const provider = agg.stages.find(s => s.stage === 'provider')!
  assert.equal(provider.occurrences, 2)  // both provider occurrences fold in regardless of failure fields
  assert.ok(provider.count >= 1)
})

test('Trace.time records the wrapped work wall-clock and returns its value', async () => {
  let t = 0
  const tr = new Trace({ requestId: 'r2', feature: 'book-now-ai' }, 'default', () => t)
  const out = await tr.time('ai', async () => { t += 250; return 'done' })
  assert.equal(out, 'done')
  assert.equal(tr.toRecord().stages.ai!.totalMs, 250)
})

test('Trace.time still records when the wrapped work throws', async () => {
  let t = 0
  const tr = new Trace({ requestId: 'r3', feature: 'book-now-ai' }, 'default', () => t)
  await assert.rejects(tr.time('pricing', async () => { t += 40; throw new Error('boom') }))
  assert.equal(tr.toRecord().stages.pricing!.totalMs, 40)
})

test('Trace.setStatus stamps status + outcome onto the record', () => {
  const tr = new Trace({ requestId: 'r4', feature: 'book-now-ai' }, 'default', () => 0)
  tr.setStatus('manual_review', 'deadline')
  const rec = tr.toRecord()
  assert.equal(rec.status, 'manual_review')
  assert.equal(rec.outcome, 'deadline')
})

test('sub-stage set is provider + image_preprocess and they are valid stages', () => {
  assert.deepEqual([...PIPELINE_SUBSTAGES].sort(), ['image_preprocess', 'provider'])
  assert.equal(isSubStage('provider'), true)
  assert.equal(isSubStage('ai'), false)
  for (const s of PIPELINE_SUBSTAGES) assert.ok(PIPELINE_STAGES.includes(s))
})

// ── 2. Persist + read round-trip, idempotency, fail-soft ──────────────────────
test('recordTrace persists and getTrace/listTraces read it back', async () => {
  const s = memStore()
  await recordTrace(traceRec({ id: 'a1', at: 100 }), s)
  await recordTrace(traceRec({ id: 'a2', at: 200 }), s)
  const back = await getTrace('a1', s)
  assert.ok(back)
  assert.equal(back!.bookingId, 'bk-1')
  const all = await listTraces(100, s)
  assert.deepEqual(all.map(r => r.id), ['a2', 'a1'])   // newest first
})

test('recordTrace is idempotent on a duplicate run id', async () => {
  const s = memStore()
  await recordTrace(traceRec({ id: 'dup', durationMs: 111 }), s)
  await recordTrace(traceRec({ id: 'dup', durationMs: 999 }), s)   // same id → skipped
  const all = await listTraces(100, s)
  assert.equal(all.filter(r => r.id === 'dup').length, 1)
  assert.equal((await getTrace('dup', s))!.durationMs, 111)        // first writer won
})

test('recordTrace swallows a store failure (metrics never throw)', async () => {
  const s = memStore(); s.setThrows = true
  await assert.doesNotReject(recordTrace(traceRec({ id: 'x' }), s))
})

// ── 3. Read-side aggregation ──────────────────────────────────────────────────
test('percentile uses nearest-rank and handles the empty sample', () => {
  assert.equal(percentile([], 95), 0)
  assert.equal(percentile([10, 20, 30, 40, 50], 50), 30)
  assert.equal(percentile([10, 20, 30, 40, 50], 100), 50)
  assert.equal(percentile([5], 95), 5)
})

test('aggregatePipeline computes per-stage percentiles, overall latency, and shares', () => {
  const recs = [
    traceRec({ id: 'j1', at: 0, startedAt: 0, completedAt: 1000, durationMs: 1000, stages: { queue: st(100), ai: st(600), provider: st(500), pricing: st(200), database: st(100) } }),
    traceRec({ id: 'j2', at: 60_000, startedAt: 60_000, completedAt: 63_000, durationMs: 3000, stages: { queue: st(300), ai: st(1800), provider: st(1600), pricing: st(600), database: st(300) } }),
  ]
  const agg = aggregatePipeline(recs)
  assert.equal(agg.traces, 2)
  // end-to-end p50 (nearest-rank over [1000,3000] at p50 = index ceil(.5*2)-1 = 0 → 1000)
  assert.equal(agg.overall.p50, 1000)
  assert.equal(agg.overall.maxMs, 3000)
  const ai = agg.stages.find(s => s.stage === 'ai')!
  assert.equal(ai.count, 2)
  assert.equal(ai.p95, 1800)
  assert.equal(ai.isSubStage, false)
  assert.ok(ai.shareOfTotalPct > 0)
  // provider is a sub-stage → excluded from the share breakdown (share 0) but still measured
  const provider = agg.stages.find(s => s.stage === 'provider')!
  assert.equal(provider.isSubStage, true)
  assert.equal(provider.shareOfTotalPct, 0)
  assert.equal(provider.p95, 1600)
  // Top-level shares (queue+ai+pricing+database) sum to ~100, provider excluded
  const topShare = agg.stages.filter(s => !s.isSubStage).reduce((sum, s) => sum + s.shareOfTotalPct, 0)
  assert.ok(Math.abs(topShare - 100) < 0.5, `top shares should sum to ~100, got ${topShare}`)
  // throughput: 2 runs over a 63s window ≈ 1.9/min
  assert.ok(agg.throughputPerMin > 0)
})

test('aggregatePipeline partitions notify traces out of end-to-end but folds their stage in', () => {
  const recs = [
    traceRec({ id: 'j1', feature: 'book-now-ai', durationMs: 1000, status: 'completed', stages: { ai: st(800) } }),
    traceRec({ id: 'n1', feature: NOTIFY_FEATURE, durationMs: 40, status: 'completed', bookingId: 'bk-1', stages: { notification: st(40) } }),
  ]
  const agg = aggregatePipeline(recs)
  assert.equal(agg.traces, 1)                        // only the job run counts as a "run"
  assert.equal(agg.overall.count, 1)
  assert.equal(agg.slowest.length, 1)                // notify trace excluded from slowest
  assert.equal(agg.slowest[0].id, 'j1')
  const notif = agg.stages.find(s => s.stage === 'notification')!
  assert.equal(notif.count, 1)                       // …but its stage still aggregates
  assert.equal(notif.p95, 40)
  // status breakdown counts job runs only (1 completed), not the notify trace
  assert.equal(agg.statusBreakdown.reduce((n, s) => n + s.count, 0), 1)
})

test('aggregatePipeline returns a well-formed empty result for no data', () => {
  const agg = aggregatePipeline([])
  assert.equal(agg.traces, 0)
  assert.equal(agg.window, null)
  assert.equal(agg.stages.length, PIPELINE_STAGES.length)
  assert.equal(agg.slowest.length, 0)
})

// ── 4. runWithTrace lifecycle: flag gate, flush, nesting ──────────────────────
test('runWithTrace OFF establishes no trace and writes nothing', async () => {
  const s = memStore()
  let sawTrace = true
  const out = await runWithTrace({ requestId: 'off1', feature: 'book-now-ai' }, async () => {
    sawTrace = activeTrace() !== undefined
    await timeStage('database', async () => {})   // no-op, no active trace
    return 42
  }, { store: s, env: {} /* flag unset → off */ })
  assert.equal(out, 42)
  assert.equal(sawTrace, false)
  assert.equal((await listTraces(10, s)).length, 0)
})

test('runWithTrace ON records stages and flushes one trace to the store', async () => {
  const s = memStore()
  let t = 1000
  const out = await runWithTrace(
    { requestId: 'on1', feature: 'book-now-ai', bookingId: 'bk-9', queuedAt: 900 },
    async () => {
      markStage('queue', 100)
      await timeStage('database', async () => { t += 50 })
      await timeStage('ai', async () => { t += 200; markStage('provider', 150) })
      markTraceOutcome('completed', 'instant_quote')
      return 'ok'
    },
    { store: s, env: ON, now: () => t },
  )
  assert.equal(out, 'ok')
  const all = await listTraces(10, s)
  assert.equal(all.length, 1)
  const rec = all[0]
  assert.equal(rec.id, 'on1')
  assert.equal(rec.bookingId, 'bk-9')
  assert.equal(rec.status, 'completed')
  assert.equal(rec.outcome, 'instant_quote')
  assert.equal(rec.stages.queue!.totalMs, 100)
  assert.equal(rec.stages.database!.totalMs, 50)
  assert.equal(rec.stages.ai!.totalMs, 200)
  assert.equal(rec.stages.provider!.totalMs, 150)   // recorded inside the ai stage
  assert.equal(rec.durationMs, 250)                 // (1000+50+200) − 1000
})

test('runWithTrace flushes even when the wrapped work throws', async () => {
  const s = memStore()
  let t = 0
  await assert.rejects(runWithTrace(
    { requestId: 'err1', feature: 'book-now-ai' },
    async () => { await timeStage('ai', async () => { t += 70 }); throw new Error('job failed') },
    { store: s, env: ON, now: () => t },
  ))
  const all = await listTraces(10, s)
  assert.equal(all.length, 1)
  assert.equal(all[0].stages.ai!.totalMs, 70)
})

test('runWithTrace reuses an already-active trace (nesting-safe, single flush)', async () => {
  const s = memStore()
  let t = 0
  await runWithTrace({ requestId: 'outer', feature: 'book-now-ai' }, async () => {
    const outer = activeTrace()
    await runWithTrace({ requestId: 'inner', feature: 'book-now-ai' }, async () => {
      assert.equal(activeTrace(), outer, 'nested call reuses the outer trace')
      await timeStage('pricing', async () => { t += 10 })
    }, { store: s, env: ON, now: () => t })
  }, { store: s, env: ON, now: () => t })
  const all = await listTraces(10, s)
  assert.equal(all.length, 1)                        // only the outer flushed
  assert.equal(all[0].id, 'outer')
  assert.equal(all[0].stages.pricing!.totalMs, 10)   // inner work landed on the outer trace
})

// helper: a stage stat literal
function st(totalMs: number, count = 1): { totalMs: number; count: number; maxMs: number } {
  return { totalMs, count, maxMs: totalMs }
}
