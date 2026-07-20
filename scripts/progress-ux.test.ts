// Calibrated progress-UX (Option A) — unit tests for the PURE logic: the stage
// state machine + honesty invariants, the timed driver (fake clock), the telemetry
// calibration, and the instrumentation aggregation. No network, no Redis, no React.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  STAGE_KEYS, STAGE_DEFS, ANALYZING_INDEX, LAST_INDEX, MSG, DEFAULT_ANALYZE_P50_MS,
  runningState, revealState, settledState, settleFrames, analyzingFraction, isOverrun,
  createTimedDriver, type ProgressState, type BackendOutcome,
} from '../app/lib/ai/progress-stages'
import {
  median, clampP50, computeCalibration, MIN_SAMPLES, MIN_P50_MS, MAX_P50_MS,
} from '../app/lib/ai/progress-calibration'
import type { AiCallRecord } from '../app/lib/ai/telemetry'
import {
  sanitizeMetric, metricFields, summarizeProgressMetrics, decodeHash,
} from '../app/lib/ai/progress-metrics'

const statusOf = (s: ProgressState, key: string) => s.stages.find(x => x.key === key)!.status

// ── State machine + honesty invariants ───────────────────────────────────────

test('stage model: six stages, first two are pre-completed', () => {
  assert.equal(STAGE_DEFS.length, 6)
  assert.deepEqual(STAGE_KEYS.slice(0, 2), ['photos-uploaded', 'preparing-images'])
  assert.equal(STAGE_DEFS[0].pre, true)
  assert.equal(STAGE_DEFS[1].pre, true)
  assert.equal(STAGE_DEFS[ANALYZING_INDEX].key, 'ai-analyzing')
})

test('runningState: pre-stages complete, AI active, rest pending, never settled', () => {
  const s = runningState(0, 5000)
  assert.equal(statusOf(s, 'photos-uploaded'), 'complete')
  assert.equal(statusOf(s, 'preparing-images'), 'complete')
  assert.equal(statusOf(s, 'ai-analyzing'), 'active')
  assert.equal(statusOf(s, 'calculating-volume'), 'pending')
  assert.equal(statusOf(s, 'generating-quote'), 'pending')
  assert.equal(statusOf(s, 'finalizing-estimate'), 'pending')
  assert.equal(s.activeIndex, ANALYZING_INDEX)
  assert.equal(s.settled, false)
  assert.equal(s.phase, 'running')
})

test('overrun copy kicks in past p50 × 1.5', () => {
  assert.equal(isOverrun(6000, 5000), false)          // 6000 < 7500
  assert.equal(isOverrun(8000, 5000), true)           // 8000 > 7500
  assert.equal(runningState(8000, 5000).message, MSG.overrun)
  assert.equal(runningState(1000, 5000).message, MSG.running)
})

test('analyzingFraction is eased, monotonic, and CAPPED below 1 while running', () => {
  assert.equal(analyzingFraction(0, 5000), 0)
  const a = analyzingFraction(2500, 5000)
  const b = analyzingFraction(5000, 5000)
  assert.ok(b > a && a > 0)
  // Never reaches 1 no matter how long it runs — nothing looks complete early.
  assert.ok(analyzingFraction(10_000_000, 5000) <= 0.97)
})

test('settledState success → all six complete', () => {
  const s = settledState({ kind: 'success', decision: 'instant_quote' })
  assert.ok(s.stages.every(x => x.status === 'complete'))
  assert.equal(s.settled, true)
  assert.equal(s.phase, 'success')
  assert.equal(s.message, MSG.success)
})

test('settledState review → stops at AI Analyzing; volume/quote/finalize NEVER complete', () => {
  const s = settledState({ kind: 'review' })
  assert.equal(statusOf(s, 'ai-analyzing'), 'complete')
  assert.equal(statusOf(s, 'calculating-volume'), 'pending')
  assert.equal(statusOf(s, 'generating-quote'), 'pending')
  assert.equal(statusOf(s, 'finalizing-estimate'), 'pending')
  assert.equal(s.phase, 'review')
  // Honesty: no stage past the analysis is ever shown complete for a review.
  assert.ok(!s.stages.slice(ANALYZING_INDEX + 1).some(x => x.status === 'complete'))
})

test('settledState error → AI stage failed, nothing beyond it', () => {
  const s = settledState({ kind: 'error' })
  assert.equal(statusOf(s, 'photos-uploaded'), 'complete')
  assert.equal(statusOf(s, 'preparing-images'), 'complete')
  assert.equal(statusOf(s, 'ai-analyzing'), 'failed')
  assert.ok(s.stages.slice(ANALYZING_INDEX + 1).every(x => x.status === 'pending'))
  assert.equal(s.phase, 'error')
})

test('settleFrames: success cascades trailing stages, ends at complete/settled', () => {
  const frames = settleFrames({ kind: 'success', decision: 'estimate_range' })
  assert.equal(frames.length, LAST_INDEX - ANALYZING_INDEX + 1) // reveal 2..5
  const last = frames[frames.length - 1]
  assert.ok(last.settled && last.phase === 'success' && last.stages.every(x => x.status === 'complete'))
  // review/error is a single truthful terminal (no cascade).
  assert.equal(settleFrames({ kind: 'review' }).length, 1)
  assert.equal(settleFrames({ kind: 'error' }).length, 1)
})

test('revealState never marks the final stage complete until through===LAST_INDEX', () => {
  const mid = revealState(ANALYZING_INDEX) // through=2
  assert.equal(mid.settled, false)
  assert.equal(statusOf(mid, 'finalizing-estimate'), 'pending')
  const end = revealState(LAST_INDEX)
  assert.equal(end.settled, true)
})

// ── Timed driver (Option A) with an injected fake clock ───────────────────────

function makeScheduler() {
  let now = 0
  let id = 1
  const intervals = new Map<number, { fn: () => void; ms: number; next: number }>()
  const timeouts = new Map<number, { fn: () => void; at: number }>()
  return {
    now: () => now,
    setInterval: (fn: () => void, ms: number) => { const i = id++; intervals.set(i, { fn, ms, next: now + ms }); return i },
    clearInterval: (h: unknown) => { intervals.delete(h as number) },
    setTimeout: (fn: () => void, ms: number) => { const i = id++; timeouts.set(i, { fn, at: now + ms }); return i },
    clearTimeout: (h: unknown) => { timeouts.delete(h as number) },
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        let at = Infinity, kind: 'to' | 'iv' | null = null, key = -1
        for (const [k, v] of timeouts) if (v.at <= target && v.at < at) { at = v.at; kind = 'to'; key = k }
        for (const [k, v] of intervals) if (v.next <= target && v.next < at) { at = v.next; kind = 'iv'; key = k }
        if (kind === null) break
        now = at
        if (kind === 'to') { const t = timeouts.get(key)!; timeouts.delete(key); t.fn() }
        else { const iv = intervals.get(key)!; iv.next += iv.ms; iv.fn() }
      }
      now = target
    },
  }
}

function driverWith(sched: ReturnType<typeof makeScheduler>, extra: Record<string, unknown> = {}) {
  return createTimedDriver({
    analyzeP50Ms: 4000, tickMs: 100, cascadeStepMs: 50,
    now: sched.now, setInterval: sched.setInterval, clearInterval: sched.clearInterval,
    setTimeout: sched.setTimeout, clearTimeout: sched.clearTimeout, ...extra,
  })
}

test('timed driver emits running synchronously, then cascades to success', () => {
  const sched = makeScheduler()
  const states: ProgressState[] = []
  const d = driverWith(sched)
  d.start(s => states.push(s))
  assert.equal(states.length, 1)
  assert.equal(states[0].phase, 'running')
  sched.advance(300) // 3 ticks, still running
  assert.ok(states[states.length - 1].phase === 'running')
  d.settle({ kind: 'success', decision: 'instant_quote' })
  sched.advance(500) // let the cascade play out
  const last = states[states.length - 1]
  assert.ok(last.settled && last.phase === 'success' && last.stages.every(x => x.status === 'complete'))
  d.dispose()
})

test('timed driver: reduced motion jumps straight to the terminal (no cascade)', () => {
  const sched = makeScheduler()
  const states: ProgressState[] = []
  const d = driverWith(sched, { reducedMotion: true })
  d.start(s => states.push(s))
  d.settle({ kind: 'review' })
  const last = states[states.length - 1]
  assert.equal(last.phase, 'review')
  assert.equal(statusOf(last, 'generating-quote'), 'pending')
  d.dispose()
})

test('timed driver: settle is idempotent and stops further running emits', () => {
  const sched = makeScheduler()
  const states: ProgressState[] = []
  const d = driverWith(sched)
  d.start(s => states.push(s))
  d.settle({ kind: 'error' })
  d.settle({ kind: 'success', decision: 'instant_quote' }) // ignored — already done
  sched.advance(1000)
  const last = states[states.length - 1]
  assert.equal(last.phase, 'error') // first settle won; no running ticks after
  d.dispose()
})

// ── Calibration ──────────────────────────────────────────────────────────────

test('median (pure)', () => {
  assert.equal(median([]), 0)
  assert.equal(median([5]), 5)
  assert.equal(median([1, 2, 3]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
})

test('clampP50 bounds and rejects garbage', () => {
  assert.equal(clampP50(0), DEFAULT_ANALYZE_P50_MS)
  assert.equal(clampP50(NaN), DEFAULT_ANALYZE_P50_MS)
  assert.equal(clampP50(500), MIN_P50_MS)
  assert.equal(clampP50(99_999), MAX_P50_MS)
  assert.equal(clampP50(4200), 4200)
})

const rec = (o: Partial<AiCallRecord>): AiCallRecord => ({
  id: 'x', at: 0, tenantId: 't', actor: 'public', role: 'public',
  feature: 'ops.junkAnalysis', taskId: 'ops.junkAnalysis', promptVersion: 1, model: 'm',
  ok: true, outcome: 'success', latencyMs: 3000, inputTokens: 0, outputTokens: 0, totalTokens: 0,
  estCostUsd: 0, requestChars: 0, responseValid: true, kind: 'primary', ...o,
})

test('computeCalibration: default below MIN_SAMPLES, measured p50 above', () => {
  const few = Array.from({ length: MIN_SAMPLES - 1 }, () => rec({ latencyMs: 3000 }))
  const d = computeCalibration(few)
  assert.equal(d.source, 'default')
  assert.equal(d.analyzeP50Ms, DEFAULT_ANALYZE_P50_MS)

  const many = [1000, 2000, 3000, 4000, 9000].map(ms => rec({ latencyMs: ms }))
  const m = computeCalibration(many)
  assert.equal(m.source, 'measured')
  assert.equal(m.analyzeP50Ms, 3000) // median of the five
  assert.equal(m.sampleSize, 5)
})

test('computeCalibration ignores non-primary / failed / other-feature / critic calls', () => {
  const recs = [
    ...[1000, 1000, 1000, 1000, 1000].map(ms => rec({ latencyMs: ms })),        // 5 valid @1000
    rec({ latencyMs: 99999, kind: 'fallback' }),                                 // critic — excluded
    rec({ latencyMs: 99999, ok: false, outcome: 'provider_error' }),             // failed — excluded
    rec({ latencyMs: 99999, feature: 'ops.command' }),                           // other feature — excluded
  ]
  const c = computeCalibration(recs)
  assert.equal(c.sampleSize, 5)
  assert.equal(c.analyzeP50Ms, 1500) // median 1000 → clamped up to MIN_P50_MS
})

// ── Instrumentation ──────────────────────────────────────────────────────────

test('sanitizeMetric: rejects unknown outcome, clamps durations, filters stages', () => {
  assert.equal(sanitizeMetric({ outcome: 'nope' }), null)
  assert.equal(sanitizeMetric(null), null)
  const m = sanitizeMetric({
    outcome: 'success', waitMs: 4200, perceivedGapMs: -5, // negative gap dropped
    stageMs: { 'ai-analyzing': 4000, 'bogus-stage': 100, 'generating-quote': 9_999_999 },
  })!
  assert.equal(m.outcome, 'success')
  assert.equal(m.waitMs, 4200)
  assert.equal(m.perceivedGapMs, undefined)             // negative → dropped
  assert.equal(m.stageMs!['ai-analyzing'], 4000)
  assert.equal((m.stageMs as Record<string, number>)['bogus-stage'], undefined)
  assert.equal(m.stageMs!['generating-quote'], 600_000) // clamped to MAX_MS
})

test('metricFields → summarize round-trips into the required measures', () => {
  const beacons = [
    { outcome: 'success' as const, waitMs: 5000, perceivedGapMs: 500, stageMs: { 'ai-analyzing': 4500 } },
    { outcome: 'success' as const, waitMs: 7000, perceivedGapMs: 700, stageMs: { 'ai-analyzing': 6500 } },
    { outcome: 'review' as const, waitMs: 6000 },
    { outcome: 'abandoned' as const, waitMs: 2000 },
  ]
  const hash: Record<string, number> = {}
  for (const b of beacons) for (const [f, by] of metricFields(b)) hash[f] = (hash[f] ?? 0) + by

  const s = summarizeProgressMetrics(hash)
  assert.equal(s.reports, 4)
  assert.equal(s.outcomes.success, 2)
  assert.equal(s.outcomes.review, 1)
  assert.equal(s.outcomes.abandoned, 1)
  assert.equal(s.abandonmentRate, 0.25)                 // 1/4
  assert.equal(s.avgWaitMs, Math.round((5000 + 7000 + 6000 + 2000) / 4))
  assert.equal(s.avgPerceivedGapMs, 600)                // (500+700)/2
  assert.equal(s.avgStageMs['ai-analyzing'], 5500)      // (4500+6500)/2
})

test('decodeHash decodes Upstash flat HGETALL output', () => {
  assert.deepEqual(decodeHash(['reports', '3', 'wait_sum_ms', '12000', 'bad', 'x']), { reports: 3, wait_sum_ms: 12000 })
})
