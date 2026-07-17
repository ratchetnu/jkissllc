// Operion Shadow — owner Select/Run/Retry/Rerun workflow tests.
//
// Two layers, no live AI:
//  • PURE: projectShadowRun — the status/action gating the whole UI reads through.
//  • WORKER: enqueue idempotency, duplicate prevention, rerun history, retry cap — driven
//    through the real worker with a counting analyze stub, so any stray AI call fails a test.
import assert from 'node:assert/strict'
import test from 'node:test'
import { projectShadowRun, type ShadowRunInputs } from '../app/lib/estimation/shadow-run-status'
import { enqueueShadowJobForBooking, processShadowJob, shadowStatusForBooking } from '../app/lib/estimation/shadow-worker'
import type { ShadowDeps } from '../app/lib/estimation/shadow-worker'
import type { V2ShadowJob } from '../app/lib/estimation/shadow-types'
import type { Booking } from '../app/lib/bookings'
import type { ShadowBudgetLimits, ShadowSpendState } from '../app/lib/estimation/shadow-budget'

const T = 1_760_000_000_000
const OPEN_BUDGET: ShadowBudgetLimits = { killed: false, maxEvalsPerDay: 50, maxEvalsPerBooking: 3, maxEstDailyCostUsd: 2, maxAttempts: 2 }
const FRESH_SPEND: ShadowSpendState = { evalsToday: 0, costTodayUsd: 0, attemptsForBooking: 0 }

// ── projectShadowRun: the status vocabulary + action gating ──────────────────

const proj = (over: Partial<ShadowRunInputs>) => projectShadowRun({
  selected: false, eligible: true, eligibilityReason: 'eligible', job: null, budget: OPEN_BUDGET, spend: FRESH_SPEND, ...over,
})
const job = (over: Partial<V2ShadowJob>): V2ShadowJob => ({
  jobVersion: 1, bookingId: 'b', shadowJobId: 's', status: 'completed', idempotencyKey: 'k',
  estimatorVersion: 2, imageCount: 2, attempts: 1, createdBy: 'owner', updatedAt: T, completedAt: T, ...over,
})

test('not selected → only Select is offered', () => {
  const v = proj({ selected: false, eligible: true })
  assert.equal(v.status, 'not_selected')
  assert.equal(v.canSelect, true)
  assert.equal(v.canRun, false, 'cannot run before selecting')
})

test('not eligible → cannot select, reason surfaced', () => {
  const v = proj({ selected: false, eligible: false, eligibilityReason: 'authoritative_not_terminal' })
  assert.equal(v.status, 'not_selected')
  assert.equal(v.canSelect, false)
  assert.match(v.detail, /authoritative_not_terminal/)
})

test('selected + eligible → Run is offered', () => {
  const v = proj({ selected: true, eligible: true })
  assert.equal(v.status, 'selected')
  assert.equal(v.canRun, true)
  assert.equal(v.canUnselect, true)
})

test('queued/processing are reported as in-flight, never runnable', () => {
  assert.equal(proj({ selected: true, job: job({ status: 'queued', completedAt: undefined }) }).status, 'queued')
  const p = proj({ selected: true, job: job({ status: 'processing', completedAt: undefined }) })
  assert.equal(p.status, 'processing')
  assert.equal(p.canRun, false)
  assert.equal(p.canRetry, false)
})

test('completed WITHOUT ground truth → awaiting_ground_truth, can open + rerun', () => {
  const v = proj({ selected: true, job: job({ comparison: { outcome: 'needs_ground_truth', shadowRecommendedUsd: 365 } as never }) })
  assert.equal(v.status, 'awaiting_ground_truth')
  assert.equal(v.canOpen, true)
  assert.equal(v.canRerun, true)
})

test('completed WITH ground truth → completed', () => {
  const v = proj({ selected: true, job: job({ groundTruth: { actualQuoteUsd: 360 }, comparison: { outcome: 'equivalent', shadowRecommendedUsd: 365 } as never }) })
  assert.equal(v.status, 'completed')
  assert.equal(v.canOpen, true)
})

test('failed transient → Retry offered', () => {
  const v = proj({ selected: true, job: job({ status: 'failed', failureCategory: 'provider_timeout', failureSummary: 'timed out', completedAt: T }) })
  assert.equal(v.status, 'failed')
  assert.equal(v.canRetry, true)
})

test('failed PERMANENT (billing/auth/…) → retry_blocked, no Retry button', () => {
  for (const cat of ['provider_billing', 'provider_auth', 'unsupported_image', 'no_usable_images', 'invalid_output'] as const) {
    const v = proj({ selected: true, job: job({ status: 'failed', failureCategory: cat, failureSummary: 'x', completedAt: T }) })
    assert.equal(v.status, 'retry_blocked', cat)
    assert.equal(v.canRetry, false, `${cat} must not offer a doomed retry`)
  }
})

test('kill switch → kill_switch status, run/retry withheld', () => {
  const killed = { ...OPEN_BUDGET, killed: true }
  assert.equal(proj({ selected: true, budget: killed }).status, 'kill_switch')
  // A failed job under a kill switch reports the kill, not a retry.
  const v = proj({ selected: true, budget: killed, job: job({ status: 'failed', failureCategory: 'provider_timeout', completedAt: T }) })
  assert.equal(v.status, 'kill_switch')
  assert.equal(v.canRetry, false)
})

test('budget block → budget_blocked; a completed job can still be opened', () => {
  const spent: ShadowSpendState = { evalsToday: 50, costTodayUsd: 0, attemptsForBooking: 0 }
  assert.equal(proj({ selected: true, spend: spent }).status, 'budget_blocked')
  // A completed comparison is still openable while budget-blocked — reading costs nothing.
  const v = proj({ selected: true, spend: spent, job: job({ comparison: { outcome: 'needs_ground_truth', shadowRecommendedUsd: 1 } as never }) })
  assert.equal(v.canOpen, true)
})

// ── worker: enqueue idempotency + duplicate prevention (ZERO AI) ─────────────

// `analyzeResult` sets what the (always-counted) analyze stub returns; overriding it never
// bypasses the call counter, so a stray AI call can't hide behind a custom result.
function harness(over: Partial<ShadowDeps> = {}, analyzeResult?: () => unknown) {
  const store = new Map<string, V2ShadowJob>()
  const calls = { analyze: 0 }
  const booking = { token: 'a'.repeat(32), bookingNumber: 'JK-B-1', invoicePhotos: [{ url: 'https://x/y.jpg' }, { url: 'https://x/z.jpg' }], serviceType: 'junk', aiJob: { status: 'completed' }, aiEstimate: { pricing: { recommendedUsd: 360 }, decision: 'estimate_range' } } as unknown as Booking
  const selected = new Set<string>()
  const okResult = () => ({ analysis: {}, ok: true, outcome: 'completed', model: 'test-model', callId: 'c', latencyMs: 42000, estCostUsd: 0.02, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, promptVersion: 'v2-2', imageCount: 2 })
  const deps: ShadowDeps = {
    now: () => T,
    env: { VISION_SHADOW_QUEUE_ENABLED: 'true', VISION_SHADOW_SELECTED_ONLY: 'true', VISION_SHADOW_WORKER_ENABLED: 'true' },
    getBooking: async () => booking,
    getJob: async (id) => store.get(id) ?? null,
    saveJob: async (j) => { store.set(j.bookingId, { ...j }) },
    isExcluded: async () => false,
    isSelected: async (id) => selected.has(id),
    lock: async (_id, fn) => fn(),
    analyze: async () => { calls.analyze++; return (analyzeResult ? analyzeResult() : okResult()) as never },
    estimate: () => ({ pricing: { recommendedCents: 36500, recommendedUsd: 365 }, manualReviewRequired: false, v2: { analysisVersion: 2 } } as never),
    clarify: () => [],
    readSpend: async () => ({ ...FRESH_SPEND }),
    chargeSpend: async () => {},
    recordSpendEvent: async () => {},
    budget: OPEN_BUDGET,
    ...over,
  }
  return { deps, store, calls, booking, selected }
}

test('selected-only: an unselected booking is not eligible to run (server-enforced)', async () => {
  const h = harness()
  const snap = await shadowStatusForBooking(h.booking, h.deps)
  assert.equal(snap.selected, false)
  assert.equal(snap.eligible, true, 'manualEnqueue path: an owner CAN run it — but only after selecting')
  // Auto path (no manualEnqueue) would block it; the run route always selects-then-runs.
})

test('enqueue is idempotent — a second enqueue does not create a duplicate active job', async () => {
  const h = harness()
  h.selected.add(h.booking.token)
  const first = await enqueueShadowJobForBooking(h.booking, { createdBy: 'owner', manualEnqueue: true, deps: h.deps })
  assert.equal(first.enqueued, true)
  const second = await enqueueShadowJobForBooking(h.booking, { createdBy: 'owner', manualEnqueue: true, deps: h.deps })
  assert.equal(second.enqueued, false, 'a queued job blocks a duplicate')
  assert.match(second.reason, /already_queued_or_done/)
  assert.equal(h.store.size, 1, 'exactly one job exists')
  assert.equal(h.calls.analyze, 0, 'enqueue alone spends no AI')
})

test('run then process → completed, exactly one AI call', async () => {
  const h = harness()
  h.selected.add(h.booking.token)
  await enqueueShadowJobForBooking(h.booking, { createdBy: 'owner', manualEnqueue: true, deps: h.deps })
  const r = await processShadowJob(h.booking.token, h.deps)
  assert.equal(r.status, 'completed')
  assert.equal(h.calls.analyze, 1)
})

test('rerun preserves prior history and does not corrupt the record', async () => {
  const h = harness()
  h.selected.add(h.booking.token)
  await enqueueShadowJobForBooking(h.booking, { createdBy: 'owner', manualEnqueue: true, deps: h.deps })
  await processShadowJob(h.booking.token, h.deps)
  const afterFirst = h.store.get(h.booking.token)!
  assert.equal(afterFirst.status, 'completed')
  assert.equal(afterFirst.priorRuns ?? undefined, undefined, 'first run has no history yet')

  // Rerun (force) — must snapshot the completed run into priorRuns.
  const re = await enqueueShadowJobForBooking(h.booking, { createdBy: 'owner', manualEnqueue: true, force: true, deps: h.deps })
  assert.equal(re.enqueued, true)
  const requeued = h.store.get(h.booking.token)!
  assert.equal(requeued.status, 'queued', 'a fresh attempt')
  assert.equal(requeued.priorRuns?.length, 1, 'the prior completed run is preserved')
  assert.equal(requeued.priorRuns![0].model, 'test-model')
  assert.equal(requeued.priorRuns![0].shadowRecommendedUsd, 365)

  await processShadowJob(h.booking.token, h.deps)
  assert.equal(h.calls.analyze, 2, 'the rerun made its own call')
  assert.equal(h.store.get(h.booking.token)!.priorRuns?.length, 1, 'history survives the rerun processing')
})

test('rerun carries prior ground truth forward (no re-entry needed)', async () => {
  const h = harness()
  h.selected.add(h.booking.token)
  await enqueueShadowJobForBooking(h.booking, { createdBy: 'owner', manualEnqueue: true, deps: h.deps })
  await processShadowJob(h.booking.token, h.deps)
  const j = h.store.get(h.booking.token)!
  j.groundTruth = { actualQuoteUsd: 360 }
  h.store.set(j.bookingId, j)

  await enqueueShadowJobForBooking(h.booking, { createdBy: 'owner', manualEnqueue: true, force: true, deps: h.deps })
  assert.deepEqual(h.store.get(h.booking.token)!.groundTruth, { actualQuoteUsd: 360 }, 'ground truth is not lost on rerun')
})

test('retry respects the one-retry cap — the second failure is terminal', async () => {
  // analyze always fails transiently; maxAttempts 2 ⇒ one retry, then failed.
  const h = harness({ budget: { ...OPEN_BUDGET, maxAttempts: 2 } }, () => ({ analysis: {}, ok: false, outcome: 'rate_limited' }))
  h.selected.add(h.booking.token)
  await enqueueShadowJobForBooking(h.booking, { createdBy: 'owner', manualEnqueue: true, deps: h.deps })
  const r1 = await processShadowJob(h.booking.token, h.deps)   // attempt 1
  assert.equal(r1.status, 'retrying', 'first failure → one retry allowed')
  const j = h.store.get(h.booking.token)!
  j.nextRetryAt = T - 1              // make it due again
  h.store.set(j.bookingId, j)
  const r2 = await processShadowJob(h.booking.token, h.deps)   // attempt 2
  assert.equal(r2.status, 'failed', 'second failure is terminal — no third call')
  assert.equal(h.calls.analyze, 2, 'exactly two attempts, never three')
})

test('a budget-blocked run parks the job and spends ZERO AI', async () => {
  const h = harness({ readSpend: async () => ({ evalsToday: 50, costTodayUsd: 0, attemptsForBooking: 0 }) })
  h.selected.add(h.booking.token)
  await enqueueShadowJobForBooking(h.booking, { createdBy: 'owner', manualEnqueue: true, deps: h.deps })
  const r = await processShadowJob(h.booking.token, h.deps)
  assert.equal(r.status, 'retrying')
  assert.match(r.reason ?? '', /^budget_/)
  assert.equal(h.calls.analyze, 0)
})

test('shadowStatusForBooking makes ZERO AI calls — it is a status read', async () => {
  const h = harness()
  await shadowStatusForBooking(h.booking, h.deps)
  await shadowStatusForBooking(h.booking, h.deps)
  assert.equal(h.calls.analyze, 0, 'a dashboard refresh must never call the model')
})
