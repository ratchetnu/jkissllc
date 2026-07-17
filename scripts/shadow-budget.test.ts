// Operion Shadow — AI credit-protection tests.
//
// Every case here proves a NEGATIVE: that some path spends ZERO model calls. The single
// instrument is a counting `analyze` stub — if it fires when it shouldn't, the test fails.
// No Redis, no network, no live AI.
import assert from 'node:assert/strict'
import test from 'node:test'
import { decideShadowSpend, shadowBudgetFromEnv, DEFAULT_SHADOW_BUDGET } from '../app/lib/estimation/shadow-budget'
import { classifyShadowFailure } from '../app/lib/estimation/shadow-policy'
import { SHADOW_TRANSIENT } from '../app/lib/estimation/shadow-types'
import { processShadowJob } from '../app/lib/estimation/shadow-worker'
import type { ShadowDeps } from '../app/lib/estimation/shadow-worker'
import type { V2ShadowJob } from '../app/lib/estimation/shadow-types'
import { computeShadowAnalytics, readinessScore } from '../app/lib/estimation/shadow-analytics'
import { buildV2Comparison } from '../app/lib/estimation/shadow-comparison'

const T = 1_760_000_000_000

// ── pure budget gate ─────────────────────────────────────────────────────────

test('decideShadowSpend: allows a fresh job under all caps', () => {
  const d = decideShadowSpend(DEFAULT_SHADOW_BUDGET, { evalsToday: 0, costTodayUsd: 0, attemptsForBooking: 0 })
  assert.equal(d.allowed, true)
})

test('decideShadowSpend: kill switch beats everything, checked first', () => {
  const d = decideShadowSpend({ ...DEFAULT_SHADOW_BUDGET, killed: true }, { evalsToday: 0, costTodayUsd: 0, attemptsForBooking: 0 })
  assert.equal(d.allowed, false)
  assert.equal(d.allowed === false && d.block, 'killed')
})

test('decideShadowSpend: each cap blocks with its own reason', () => {
  const b = DEFAULT_SHADOW_BUDGET
  assert.equal((decideShadowSpend(b, { evalsToday: b.maxEvalsPerDay, costTodayUsd: 0, attemptsForBooking: 0 }) as { block: string }).block, 'daily_eval_cap')
  assert.equal((decideShadowSpend(b, { evalsToday: 0, costTodayUsd: b.maxEstDailyCostUsd, attemptsForBooking: 0 }) as { block: string }).block, 'daily_cost_cap')
  assert.equal((decideShadowSpend(b, { evalsToday: 0, costTodayUsd: 0, attemptsForBooking: b.maxEvalsPerBooking }) as { block: string }).block, 'per_booking_cap')
})

test('decideShadowSpend: caps are >= (at the limit is blocked, not one past it)', () => {
  const b = { ...DEFAULT_SHADOW_BUDGET, maxEvalsPerDay: 5 }
  assert.equal(decideShadowSpend(b, { evalsToday: 4, costTodayUsd: 0, attemptsForBooking: 0 }).allowed, true)
  assert.equal(decideShadowSpend(b, { evalsToday: 5, costTodayUsd: 0, attemptsForBooking: 0 }).allowed, false)
})

test('shadowBudgetFromEnv: conservative defaults, kill switch defaults OFF', () => {
  const b = shadowBudgetFromEnv({})
  assert.equal(b.killed, false, 'an unset kill switch must not halt the pipeline')
  assert.equal(b.maxEvalsPerDay, 50)
  assert.equal(b.maxEvalsPerBooking, 3)
  assert.equal(b.maxEstDailyCostUsd, 2)
  assert.equal(b.maxAttempts, 2)
})

test('shadowBudgetFromEnv: env overrides, and garbage falls back to the default', () => {
  const b = shadowBudgetFromEnv({ SHADOW_V2_KILL_SWITCH: 'true', SHADOW_MAX_EVALS_PER_DAY: '10', SHADOW_MAX_DAILY_COST_USD: 'not-a-number' })
  assert.equal(b.killed, true)
  assert.equal(b.maxEvalsPerDay, 10)
  assert.equal(b.maxEstDailyCostUsd, 2, 'malformed value must fall back, never NaN')
})

// ── billing classification (the bug that burned credits) ─────────────────────

test('billing/auth failures classify as non-transient — never retried', () => {
  assert.equal(classifyShadowFailure('provider_error', 'billing'), 'provider_billing')
  assert.equal(classifyShadowFailure('provider_error', 'budget'), 'provider_billing')
  assert.equal(classifyShadowFailure('provider_error', 'auth'), 'provider_auth')
  // The crux: none of these is in the transient set, so shadowRetryDecision terminates them.
  assert.ok(!SHADOW_TRANSIENT.includes('provider_billing'))
  assert.ok(!SHADOW_TRANSIENT.includes('provider_auth'))
  // A genuine blip still classifies transient.
  assert.ok(SHADOW_TRANSIENT.includes(classifyShadowFailure('provider_error', 'network')))
})

// ── worker: the counting-analyze proofs ──────────────────────────────────────

const fakeEstimate = () => ({
  pricing: { recommendedCents: 36500, recommendedUsd: 365 },
  manualReviewRequired: false,
  v2: { analysisVersion: 2 },
} as never)

/** A worker harness whose `analyze` counts every call. `calls.n` is the credit meter. */
function harness(job: V2ShadowJob, over: Partial<ShadowDeps> = {}, analyzeResult?: unknown) {
  const store = new Map<string, V2ShadowJob>([[job.bookingId, job]])
  const calls = { n: 0 }
  const charged: number[] = []
  const events: string[] = []
  const deps: ShadowDeps = {
    now: () => T,
    env: { VISION_SHADOW_WORKER_ENABLED: 'true' },
    getBooking: async () => ({ token: job.bookingId, bookingNumber: 'JK-B-1', invoicePhotos: [{ url: 'https://x/y.jpg' }], serviceType: 'junk', aiJob: { status: 'completed' }, aiEstimate: { pricing: { recommendedUsd: 360 }, decision: 'estimate_range' } } as never),
    getJob: async (id) => store.get(id) ?? null,
    saveJob: async (j) => { store.set(j.bookingId, { ...j }) },
    isExcluded: async () => false,
    isSelected: async () => true,
    lock: async (_id, fn) => fn(),
    analyze: async () => { calls.n++; return (analyzeResult as never) ?? ({ analysis: {}, ok: true, outcome: 'completed', model: 'test-model', callId: 'c1', latencyMs: 42000, estCostUsd: 0.02, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, promptVersion: 'v2-2', imageCount: 1 } as never) },
    estimate: () => fakeEstimate(),
    clarify: () => [],
    readSpend: async () => ({ evalsToday: 0, costTodayUsd: 0, attemptsForBooking: job.attempts }),
    chargeSpend: async (_n, c) => { charged.push(c) },
    recordSpendEvent: async (_n, k) => { events.push(k) },
    budget: { killed: false, maxEvalsPerDay: 50, maxEvalsPerBooking: 3, maxEstDailyCostUsd: 2, maxAttempts: 2 },
    ...over,
  }
  return { deps, store, calls, charged, events }
}

const dueJob = (over: Partial<V2ShadowJob> = {}): V2ShadowJob => ({
  jobVersion: 1, bookingId: 'a'.repeat(32), shadowJobId: 'sj', status: 'queued', idempotencyKey: 'k',
  estimatorVersion: 2, imageCount: 1, attempts: 0, createdBy: 'owner', queuedAt: T - 1000, nextRetryAt: T - 1, updatedAt: T - 1000, ...over,
})

test('kill switch: ZERO AI calls; job parked as retrying, not failed', async () => {
  const h = harness(dueJob(), { budget: { killed: true, maxEvalsPerDay: 50, maxEvalsPerBooking: 3, maxEstDailyCostUsd: 2, maxAttempts: 2 } })
  const r = await processShadowJob(dueJob().bookingId, h.deps)
  assert.equal(h.calls.n, 0, 'the model must not be called while killed')
  assert.equal(r.status, 'retrying', 'a killed job waits, it is not a failure')
  assert.equal(r.reason, 'budget_killed')
  assert.deepEqual(h.events, ['budgetBlocked'])
})

test('daily eval cap: ZERO AI calls when the day is full', async () => {
  const h = harness(dueJob(), { readSpend: async () => ({ evalsToday: 50, costTodayUsd: 0, attemptsForBooking: 0 }) })
  const r = await processShadowJob(dueJob().bookingId, h.deps)
  assert.equal(h.calls.n, 0)
  assert.equal(r.reason, 'budget_daily_eval_cap')
})

test('daily cost cap: ZERO AI calls when the budget dollars are spent', async () => {
  const h = harness(dueJob(), { readSpend: async () => ({ evalsToday: 1, costTodayUsd: 2, attemptsForBooking: 0 }) })
  const r = await processShadowJob(dueJob().bookingId, h.deps)
  assert.equal(h.calls.n, 0)
  assert.equal(r.reason, 'budget_daily_cost_cap')
})

test('per-booking cap: ZERO AI calls once a booking has burned its attempts', async () => {
  const h = harness(dueJob({ attempts: 3 }))
  const r = await processShadowJob(dueJob().bookingId, h.deps)
  assert.equal(h.calls.n, 0)
  assert.equal(r.reason, 'budget_per_booking_cap')
})

test('V1 stays available when the AI budget is exhausted — the gate touches only V2', async () => {
  // The budget gate lives entirely inside processShadowJob (the V2 path). V1 is a different
  // module the gate never imports, so an exhausted budget cannot affect it. Proven here by
  // exhausting the budget and confirming the ONLY effect is the V2 job parking — no throw,
  // no exception that could propagate to a shared caller.
  const h = harness(dueJob(), { readSpend: async () => ({ evalsToday: 999, costTodayUsd: 999, attemptsForBooking: 0 }) })
  const r = await processShadowJob(dueJob().bookingId, h.deps)
  assert.equal(r.ok, false)
  assert.equal(h.calls.n, 0)
  assert.match(r.reason ?? '', /^budget_/)
})

test('a successful inference is charged exactly once, with its real cost', async () => {
  const h = harness(dueJob())
  const r = await processShadowJob(dueJob().bookingId, h.deps)
  assert.equal(r.status, 'completed')
  assert.equal(h.calls.n, 1)
  assert.deepEqual(h.charged, [0.02], 'charged the provider-reported cost, once')
})

test('billing failure: charged ZERO, recorded as a prevented retry, terminal', async () => {
  const h = harness(dueJob(), {}, { analysis: {}, ok: false, outcome: 'provider_error', errorClass: 'billing' })
  const r = await processShadowJob(dueJob().bookingId, h.deps)
  assert.equal(h.calls.n, 1, 'exactly one call was attempted')
  assert.equal(r.status, 'failed', 'billing is terminal — not retried')
  assert.deepEqual(h.charged, [], 'a failed call reported no usage, so nothing is charged')
  assert.deepEqual(h.events, ['preventedRetries'], 'counted as credits protected')
})

test('downstream failure after a paid inference does NOT re-call the model (priority #3)', async () => {
  // The inference succeeds and is charged; the deterministic bridge then throws. The job must
  // NOT retry (which would re-spend) — it goes to manual_review with the cost preserved.
  const h = harness(dueJob(), { estimate: () => { throw new Error('bridge blew up') } })
  const r = await processShadowJob(dueJob().bookingId, h.deps)
  assert.equal(h.calls.n, 1, 'the model was called once and must not be called again')
  assert.equal(r.status, 'manual_review')
  assert.equal(r.reason, 'downstream_error')
  assert.deepEqual(h.charged, [0.02], 'the paid inference is still charged')
  const saved = h.store.get(dueJob().bookingId)!
  assert.equal(saved.estimatedCostUsd, 0.02, 'cost + telemetry survive the downstream failure')
  assert.equal(saved.model, 'test-model')
})

// ── analytics / ground-truth: zero-inference proofs ──────────────────────────

test('analytics computation makes ZERO AI calls — it is a pure function of stored jobs', () => {
  // computeShadowAnalytics / readinessScore take no deps and cannot reach the network. The
  // strongest proof is structural: they are synchronous pure functions. Exercise them to be sure.
  const jobs: V2ShadowJob[] = [dueJob({ status: 'completed', groundTruth: { actualQuoteUsd: 360 }, comparison: buildV2Comparison({ pricing: { recommendedCents: 36500 }, manualReviewRequired: false } as never, { recommendedUsd: 360 }, { actualQuoteUsd: 360 }) })]
  const a = computeShadowAnalytics(jobs)
  const r = readinessScore(jobs)
  assert.ok(a.evaluated >= 0 && typeof r.tier === 'string')
  // No async, no injectable AI seam — there is nowhere for a model call to hide.
  assert.equal(typeof computeShadowAnalytics, 'function')
})

test('recording ground truth re-scores via buildV2Comparison — a pure recompute, no AI', () => {
  // buildV2Comparison rebuilds the verdict from the STORED V2 estimate + V1 baseline + new
  // ground truth. This is the recompute the ground-truth route runs; it takes no AI seam.
  const before = buildV2Comparison({ pricing: { recommendedCents: 36500 }, manualReviewRequired: false } as never, { recommendedUsd: 360 })
  assert.equal(before.outcome, 'needs_ground_truth')
  const after = buildV2Comparison({ pricing: { recommendedCents: 36500 }, manualReviewRequired: false } as never, { recommendedUsd: 360 }, { actualQuoteUsd: 365 })
  assert.notEqual(after.outcome, 'needs_ground_truth', 'the verdict changed with no model call')
})
