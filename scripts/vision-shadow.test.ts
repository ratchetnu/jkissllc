// Independent V2 shadow subsystem — hermetic tests. No Redis, no AI, no clock: every
// dependency is injected. Covers eligibility, due-ness, retry/deadline, comparison,
// metrics, the worker lifecycle, isolation from the authoritative path, and admin auth.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking } from '../app/lib/bookings'
import type { EstimationResultV2 } from '../app/lib/estimation/v2-bridge'
import type { V2ShadowJob } from '../app/lib/estimation/shadow-types'
import {
  evaluateShadowEligibility, isShadowDue, isShadowStale, shadowRetryDecision,
  classifyShadowFailure, shadowIdempotencyKey, shadowBackoffMs, type ShadowFlags,
} from '../app/lib/estimation/shadow-policy'
import { buildV2Comparison } from '../app/lib/estimation/shadow-comparison'
import { computeShadowMetrics } from '../app/lib/estimation/shadow-metrics'
import {
  enqueueShadowJobForBooking, maybeEnqueueShadowJob, processShadowJob, runDueShadowJobs,
  type ShadowDeps,
} from '../app/lib/estimation/shadow-worker'
import { handleShadowAdminAction, isShadowAdminAction } from '../app/lib/estimation/shadow-admin'

// ── Fixtures ─────────────────────────────────────────────────────────────────
const T = 1_000_000_000_000 // fixed clock

function mkBooking(p: Partial<Booking> = {}): Booking {
  return {
    token: 'abcdef0123456789', bookingNumber: 'JK-B-9', customerName: 'C',
    serviceType: 'junk-removal', items: [], invoiceAmountCents: 0, depositAmountCents: 0,
    amountPaidCents: 0, availableDates: [], availableWindows: [], status: 'quote_received',
    payments: [], source: 'online', createdAt: 1, updatedAt: 1,
    invoicePhotos: [{ url: 'https://x/1.jpg' }, { url: 'https://x/2.jpg' }],
    aiJob: { status: 'completed' } as unknown as Booking['aiJob'],
    aiEstimate: { decision: 'auto', pricing: { recommendedUsd: 400 } } as unknown as Booking['aiEstimate'],
    ...p,
  } as Booking
}

const FLAGS_SELECTED: ShadowFlags = { queueEnabled: true, autoEnqueue: false, selectedOnly: true }
const FLAGS_AUTO: ShadowFlags = { queueEnabled: true, autoEnqueue: true, selectedOnly: false }

function fakeEstimate(over: Partial<{ cents: number; manual: boolean; tierKey: string; tierLabel: string; frac: number; band: string; items: number }> = {}): EstimationResultV2 {
  return {
    manualReviewRequired: over.manual ?? false,
    pricing: { recommendedCents: over.cents ?? 45000 },
    inventory: Array.from({ length: over.items ?? 2 }, () => ({})),
    volume: { cubicYards: { expected: 5 } },
    v2: {
      loadTier: { key: over.tierKey ?? 'three_eighths', label: over.tierLabel ?? '3/8 load' },
      truckFraction: { expected: over.frac ?? 0.35 },
      confidence: { band: over.band ?? 'high' },
      analysisVersion: 2,
    },
  } as unknown as EstimationResultV2
}

// In-memory store + injectable deps for the worker.
function memDeps(booking: Booking, over: Partial<ShadowDeps> = {}, env: Record<string, string | undefined> = {}): { deps: ShadowDeps; store: Map<string, V2ShadowJob> } {
  const store = new Map<string, V2ShadowJob>()
  const deps: ShadowDeps = {
    now: () => T,
    env: { VISION_SHADOW_QUEUE_ENABLED: 'true', VISION_SHADOW_SELECTED_ONLY: 'true', VISION_SHADOW_WORKER_ENABLED: 'true', ...env },
    getBooking: async () => booking,
    getJob: async (id) => store.get(id) ?? null,
    saveJob: async (j) => { store.set(j.bookingId, j) },
    listJobs: async () => Array.from(store.values()),
    isExcluded: async () => false,
    isSelected: async () => true,
    lock: async (_id, fn) => fn(),
    analyze: async () => ({ analysis: {} as never, ok: true, outcome: 'ok', model: 'test-model', callId: 'c1', latencyMs: 1234 }),
    estimate: () => fakeEstimate(),
    clarify: () => [],
    ...over,
  }
  return { deps, store }
}

// ── Eligibility (Phase 5) ────────────────────────────────────────────────────
test('eligibility: queue off, not-terminal, cancelled, excluded, no-photos are hard blocks', () => {
  const base = { bookingId: 'b', idempotencyKey: 'k', photoCount: 2, authoritativeTerminal: true, selected: true }
  assert.equal(evaluateShadowEligibility(base, { ...FLAGS_SELECTED, queueEnabled: false }).reason, 'queue_disabled')
  assert.equal(evaluateShadowEligibility({ ...base, authoritativeTerminal: false }, FLAGS_SELECTED).reason, 'authoritative_not_terminal')
  assert.equal(evaluateShadowEligibility({ ...base, cancelled: true }, FLAGS_SELECTED).reason, 'cancelled')
  assert.equal(evaluateShadowEligibility({ ...base, excluded: true }, FLAGS_SELECTED).reason, 'excluded')
  assert.equal(evaluateShadowEligibility({ ...base, photoCount: 0 }, FLAGS_SELECTED).reason, 'no_usable_photos')
})

test('eligibility: selected-only requires selection; auto-enqueue does not; manual bypasses mode', () => {
  const base = { bookingId: 'b', idempotencyKey: 'k', photoCount: 2, authoritativeTerminal: true }
  assert.equal(evaluateShadowEligibility({ ...base, selected: false }, FLAGS_SELECTED).eligible, false)
  assert.equal(evaluateShadowEligibility({ ...base, selected: true }, FLAGS_SELECTED).eligible, true)
  assert.equal(evaluateShadowEligibility({ ...base, selected: false }, FLAGS_AUTO).eligible, true)
  // manual owner enqueue bypasses selected-only, but still respects hard blocks
  assert.equal(evaluateShadowEligibility({ ...base, selected: false, manualEnqueue: true }, FLAGS_SELECTED).eligible, true)
  assert.equal(evaluateShadowEligibility({ ...base, cancelled: true, manualEnqueue: true }, FLAGS_SELECTED).eligible, false)
})

test('eligibility: duplicate prevention for an active or completed job with the same idem key', () => {
  const base = { bookingId: 'b', idempotencyKey: 'k', photoCount: 2, authoritativeTerminal: true, selected: true }
  for (const status of ['queued', 'processing', 'retrying', 'completed', 'manual_review'] as const) {
    assert.equal(evaluateShadowEligibility({ ...base, existingJob: { status, idempotencyKey: 'k' } }, FLAGS_SELECTED).reason, 'already_queued_or_done')
  }
  // a FAILED job with the same key is NOT a block (can re-run); different key is not a block
  assert.equal(evaluateShadowEligibility({ ...base, existingJob: { status: 'failed', idempotencyKey: 'k' } }, FLAGS_SELECTED).eligible, true)
  assert.equal(evaluateShadowEligibility({ ...base, existingJob: { status: 'completed', idempotencyKey: 'other' } }, FLAGS_SELECTED).eligible, true)
})

test('idempotency key varies by estimator + photo version', () => {
  assert.notEqual(shadowIdempotencyKey('b', 2, 2), shadowIdempotencyKey('b', 2, 3))
  assert.notEqual(shadowIdempotencyKey('b', 2, 2), shadowIdempotencyKey('b', 3, 2))
  assert.equal(shadowIdempotencyKey('b', 2, 2), shadowIdempotencyKey('b', 2, 2))
})

// ── Due-ness / retry / failure (Phases 6/7) ──────────────────────────────────
test('isShadowDue + isShadowStale', () => {
  const lease = 1000
  const q = { status: 'queued', nextRetryAt: T } as V2ShadowJob
  assert.equal(isShadowDue(q, T, lease), true)
  assert.equal(isShadowDue({ ...q, nextRetryAt: T + 1 }, T, lease), false)
  const proc = { status: 'processing', heartbeatAt: T - 2000 } as V2ShadowJob
  assert.equal(isShadowStale(proc, T, lease), true)     // 2000 > 1000 lease
  assert.equal(isShadowDue(proc, T, lease), true)
  assert.equal(isShadowStale({ ...proc, heartbeatAt: T - 500 }, T, lease), false)
  assert.equal(isShadowDue({ status: 'completed' } as V2ShadowJob, T, lease), false)
})

test('retry decision: deadline→manual_review, transient bounded, permanent→failed', () => {
  assert.deepEqual(shadowRetryDecision(1, 'deadline', 3), { terminal: true, status: 'manual_review' })
  assert.equal(shadowRetryDecision(1, 'provider_timeout', 3).terminal, false)   // retry
  assert.deepEqual(shadowRetryDecision(3, 'provider_timeout', 3), { terminal: true, status: 'failed' }) // exhausted
  assert.deepEqual(shadowRetryDecision(1, 'invalid_output', 3), { terminal: true, status: 'failed' })   // non-transient
  assert.deepEqual(shadowRetryDecision(1, 'cancelled', 3), { terminal: true, status: 'failed' })
  assert.ok(shadowBackoffMs(1) > 0 && shadowBackoffMs(9) >= shadowBackoffMs(1))
})

test('failure classification maps analyzer outcomes', () => {
  assert.equal(classifyShadowFailure('timeout'), 'provider_timeout')
  assert.equal(classifyShadowFailure('rate_limited'), 'provider_unavailable')
  assert.equal(classifyShadowFailure('image_fetch'), 'image_access')
  assert.equal(classifyShadowFailure('no_items'), 'invalid_output')
  assert.equal(classifyShadowFailure('something_weird'), 'internal_error')
})

// ── Comparison (Phase 11) ────────────────────────────────────────────────────
test('comparison: no ground truth → needs_ground_truth; divergent → inconclusive', () => {
  const near = buildV2Comparison(fakeEstimate({ cents: 42000 }), { recommendedUsd: 400, decision: 'auto' })
  assert.equal(near.outcome, 'needs_ground_truth')         // within band but unverified
  assert.equal(near.quoteDeltaUsd, 20)                     // 420 − 400
  const far = buildV2Comparison(fakeEstimate({ cents: 90000 }), { recommendedUsd: 400, decision: 'auto' })
  assert.equal(far.outcome, 'inconclusive')                // +125% diverges
})

test('comparison: ground truth is the judge (better / worse / equivalent) + tier match', () => {
  const gtGood = buildV2Comparison(fakeEstimate({ cents: 42000 }), { recommendedUsd: 400 }, { actualQuoteUsd: 400, correctLoadTier: '3/8 load' })
  assert.equal(gtGood.outcome, 'better_than_authoritative') // 420 within 15% of 400
  assert.equal(gtGood.vsGroundTruthTierMatches, true)       // label match
  const gtWorse = buildV2Comparison(fakeEstimate({ cents: 90000 }), { recommendedUsd: 400 }, { actualQuoteUsd: 400 })
  assert.equal(gtWorse.outcome, 'worse')
  const gtTierKey = buildV2Comparison(fakeEstimate({ tierKey: 'half', tierLabel: '1/2 load' }), undefined, { correctLoadTier: 'half' })
  assert.equal(gtTierKey.vsGroundTruthTierMatches, true)    // key match
})

// ── Metrics (Phase 12) ───────────────────────────────────────────────────────
test('metrics aggregate status, retries, awaiting-review, runtime, cost', () => {
  const jobs = [
    { status: 'completed', attempts: 1, latencyMs: 1000, estimatedCostUsd: 0.02, reviewedAt: T } as V2ShadowJob,
    { status: 'completed', attempts: 3, latencyMs: 3000 } as V2ShadowJob,                 // awaiting review
    { status: 'failed', attempts: 3, timeoutCategory: 'deadline', failureCategory: 'invalid_output' } as V2ShadowJob,
    { status: 'queued', attempts: 0 } as V2ShadowJob,
  ]
  const m = computeShadowMetrics(jobs)
  assert.equal(m.total, 4)
  assert.equal(m.completed, 2)
  assert.equal(m.failed, 1)
  assert.equal(m.queued, 1)
  assert.equal(m.retries, 4)              // (3-1)+(3-1)
  assert.equal(m.awaitingReview, 1)
  assert.equal(m.timedOut, 1)
  assert.equal(m.avgRuntimeMs, 2000)
  assert.equal(m.invalidOutput, 1)
})

// ── Worker lifecycle (DI) ────────────────────────────────────────────────────
test('enqueue writes a queued job to the store and NEVER mutates the booking', async () => {
  const b = mkBooking()
  const { deps, store } = memDeps(b)
  const before = JSON.stringify(b)
  const r = await enqueueShadowJobForBooking(b, { createdBy: 'owner', manualEnqueue: true, deps })
  assert.equal(r.enqueued, true)
  assert.equal(store.get(b.token)?.status, 'queued')
  assert.equal(JSON.stringify(b), before)                 // booking untouched
  assert.equal(('v2Shadow' in b), false)                  // no shadow fields on the booking
  assert.equal(('shadowEstimate' in b), false)
})

test('maybeEnqueue is a no-op when the queue flag is off', async () => {
  const b = mkBooking()
  const { deps, store } = memDeps(b, {}, { VISION_SHADOW_QUEUE_ENABLED: 'false' })
  await maybeEnqueueShadowJob(b, deps)
  assert.equal(store.size, 0)
})

test('process success → completed, records comparison, telemetry; never touches authoritative', async () => {
  const b = mkBooking()
  const { deps, store } = memDeps(b)
  await enqueueShadowJobForBooking(b, { createdBy: 'auto', manualEnqueue: true, deps })
  const authBefore = JSON.stringify(b.aiEstimate)
  const r = await processShadowJob(b.token, deps)
  assert.equal(r.status, 'completed')
  const job = store.get(b.token)!
  assert.equal(job.status, 'completed')
  assert.equal(job.model, 'test-model')
  assert.equal(job.latencyMs, 1234)
  assert.ok(job.result?.estimate)
  assert.ok(job.comparison)
  assert.equal(JSON.stringify(b.aiEstimate), authBefore)  // authoritative estimate unchanged
})

test('process deadline → manual_review (graceful), not a hard hang', async () => {
  const b = mkBooking()
  const { deps, store } = memDeps(b, { analyze: () => new Promise(() => {}) as never }, { VISION_SHADOW_DEADLINE_MS: '20' })
  await enqueueShadowJobForBooking(b, { createdBy: 'auto', manualEnqueue: true, deps })
  const r = await processShadowJob(b.token, deps)
  assert.equal(r.status, 'manual_review')
  assert.equal(store.get(b.token)?.timeoutCategory, 'deadline')
})

test('process provider failure retries, then exhausts to failed', async () => {
  const b = mkBooking()
  // transient failure, max attempts 1 → straight to failed
  const { deps, store } = memDeps(b, { analyze: async () => ({ analysis: {} as never, ok: false, outcome: 'rate_limited' }) }, { VISION_SHADOW_MAX_ATTEMPTS: '1' })
  await enqueueShadowJobForBooking(b, { createdBy: 'auto', manualEnqueue: true, deps })
  const r = await processShadowJob(b.token, deps)
  assert.equal(r.status, 'failed')
  assert.equal(store.get(b.token)?.failureCategory, 'provider_unavailable')
})

test('runDueShadowJobs: worker flag off → no-op; on → processes the due job', async () => {
  const b = mkBooking()
  const off = memDeps(b, {}, { VISION_SHADOW_WORKER_ENABLED: 'false' })
  await enqueueShadowJobForBooking(b, { createdBy: 'auto', manualEnqueue: true, deps: off.deps })
  assert.deepEqual(await runDueShadowJobs(1, off.deps), { processed: 0, results: [] })

  const on = memDeps(b)
  await enqueueShadowJobForBooking(b, { createdBy: 'auto', manualEnqueue: true, deps: on.deps })
  const res = await runDueShadowJobs(1, on.deps)
  assert.equal(res.processed, 1)
  assert.equal(on.store.get(b.token)?.status, 'completed')
})

// ── Admin authorization (security) ───────────────────────────────────────────
test('admin action registry + non-admin is refused for every shadow action', async () => {
  assert.equal(isShadowAdminAction('shadow-enqueue'), true)
  assert.equal(isShadowAdminAction('v2-override'), true)
  assert.equal(isShadowAdminAction('update'), false)
  assert.equal(isShadowAdminAction('send-link'), false)
  const b = mkBooking()
  for (const role of ['manager', 'crew', 'customer', undefined]) {
    for (const action of ['shadow-enqueue', 'shadow-retry', 'shadow-rerun', 'v2-override', 'shadow-ground-truth']) {
      const r = await handleShadowAdminAction(action, b, {}, 'someone', role, T)
      assert.equal(r.status, 403, `${role}/${action} must be 403`)
    }
  }
})
