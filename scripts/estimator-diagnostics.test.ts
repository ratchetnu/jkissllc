// Owner-safe V2 estimator diagnostics (Phase 15): a PURE aggregator over a bookings
// snapshot + the AI audit log. These tests are hermetic — no Redis, no model, no
// clock (now is injected). They pin the job-stat counting, stuck detection, provider
// vs schema failure classification, no-photo jobs, shadow low-confidence rate, the
// null-when-absent (no-fabrication) contract, and the windowHours filter.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking, AiJob, AiJobStatus } from '../app/lib/bookings'
import type { AiCallRecord, AiCallOutcome } from '../app/lib/ai/telemetry'
import {
  computeEstimatorDiagnostics,
  ESTIMATOR_AI_FEATURE,
  DEFAULT_STALE_THRESHOLD_MS,
} from '../app/lib/ai/estimator-diagnostics'

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

// ── Mock builders ────────────────────────────────────────────────────────────
function mkJob(p: Partial<AiJob> & { status: AiJobStatus }): AiJob {
  return {
    idempotencyKey: 'k', photoVersion: 1, attempts: 1,
    updatedAt: NOW, lastAttemptAt: NOW, ...p,
  }
}

let seq = 0
function mkBooking(p: Partial<Booking> & { aiJob?: AiJob }): Booking {
  seq++
  return {
    token: `tok-${seq}`, bookingNumber: `JK-B-${seq}`, customerName: 'C',
    serviceType: 'junk-removal', items: [], invoiceAmountCents: 0, depositAmountCents: 0,
    amountPaidCents: 0, availableDates: [], availableWindows: [], status: 'quote_received',
    source: 'online', invoicePhotos: [{ url: 'https://blob/x/1.jpg' }],
    ...p,
  } as unknown as Booking
}

// A booking with an attached v2Shadow (additive field set by book-now-ai.ts).
function mkShadowBooking(band: 'high' | 'medium' | 'low', extra: Partial<Booking> = {}): Booking {
  const b = mkBooking({ aiJob: mkJob({ status: 'completed' }), ...extra })
  ;(b as unknown as { v2Shadow: unknown }).v2Shadow = {
    estimate: { v2: { confidence: { band } } }, questions: [], ok: true,
  }
  return b
}

function mkCall(p: Partial<AiCallRecord> & { outcome?: AiCallOutcome }): AiCallRecord {
  return {
    id: `c-${Math.random()}`, at: NOW, tenantId: 'default', actor: 'system', role: 'system',
    feature: ESTIMATOR_AI_FEATURE, taskId: ESTIMATOR_AI_FEATURE, promptVersion: 2,
    model: 'anthropic/claude-sonnet-4-6', ok: p.outcome ? p.outcome === 'success' : true,
    outcome: p.outcome ?? 'success', latencyMs: 1000, inputTokens: 100, outputTokens: 100,
    totalTokens: 200, estCostUsd: 0.001, requestChars: 50, responseValid: true, ...p,
  }
}

// ── Job counting: completed / failed / manual_review ─────────────────────────
test('counts completed, failed, and manual-review jobs; jobsCreated is the total', () => {
  const bookings = [
    mkBooking({ aiJob: mkJob({ status: 'completed' }) }),
    mkBooking({ aiJob: mkJob({ status: 'completed' }) }),
    mkBooking({ aiJob: mkJob({ status: 'failed' }) }),
    mkBooking({ aiJob: mkJob({ status: 'manual_review' }) }),
    mkBooking({ aiJob: mkJob({ status: 'queued' }) }),
    mkBooking({}), // no aiJob — ignored entirely
  ]
  const d = computeEstimatorDiagnostics(bookings, [], { now: NOW })
  assert.equal(d.jobsCreated, 5)
  assert.equal(d.jobsCompleted, 2)
  assert.equal(d.jobsFailed, 1)
  assert.equal(d.jobsManualReview, 1)
})

// ── Stuck detection ──────────────────────────────────────────────────────────
test('jobsStuck flags an OLD queued/processing/retrying job but not a fresh one', () => {
  const old = NOW - DEFAULT_STALE_THRESHOLD_MS - 1
  const fresh = NOW - 1000
  const bookings = [
    mkBooking({ aiJob: mkJob({ status: 'queued', updatedAt: old, lastAttemptAt: old }) }),
    mkBooking({ aiJob: mkJob({ status: 'processing', updatedAt: old, lastAttemptAt: old }) }),
    mkBooking({ aiJob: mkJob({ status: 'retrying', updatedAt: old, lastAttemptAt: old }) }),
    mkBooking({ aiJob: mkJob({ status: 'processing', updatedAt: fresh, lastAttemptAt: fresh }) }),
    // Old but TERMINAL — never stuck.
    mkBooking({ aiJob: mkJob({ status: 'completed', updatedAt: old, lastAttemptAt: old }) }),
  ]
  const d = computeEstimatorDiagnostics(bookings, [], { now: NOW })
  assert.equal(d.jobsStuck, 3)
})

// ── Provider vs schema failure classification (from telemetry) ───────────────
test('classifies provider_error vs invalid_response from AI telemetry; ignores other features', () => {
  const calls = [
    mkCall({ outcome: 'provider_error' }),
    mkCall({ outcome: 'provider_error' }),
    mkCall({ outcome: 'invalid_response' }),
    mkCall({ outcome: 'success' }),
    // A different feature must NOT be counted against the estimator.
    mkCall({ outcome: 'provider_error', feature: 'ops.command' }),
  ]
  const d = computeEstimatorDiagnostics([], calls, { now: NOW })
  assert.equal(d.providerFailures, 2)
  assert.equal(d.schemaValidationFailures, 1)
  assert.equal(d.aiCallsConsidered, 4) // the ops.command call is filtered out
})

// ── No-photo jobs + image conversion failures ────────────────────────────────
test('noPhotoJobs counts jobs with zero photos; imageConversionFailures detects HEIC + error codes', () => {
  const bookings = [
    mkBooking({ aiJob: mkJob({ status: 'queued' }), invoicePhotos: [] }),          // no photos
    mkBooking({ aiJob: mkJob({ status: 'completed' }), invoicePhotos: [{ url: 'https://blob/x/IMG_1.HEIC' }] }), // heic
    mkBooking({ aiJob: mkJob({ status: 'failed', errorCode: 'unsupported_image' }) }),  // error-code signal
    mkBooking({ aiJob: mkJob({ status: 'completed' }) }),                          // clean
  ]
  const d = computeEstimatorDiagnostics(bookings, [], { now: NOW })
  assert.equal(d.noPhotoJobs, 1)
  assert.equal(d.imageConversionFailures, 2) // heic + unsupported_image
})

// ── retries = sum of attempts beyond the first ───────────────────────────────
test('retries sums attempts beyond the first across jobs', () => {
  const bookings = [
    mkBooking({ aiJob: mkJob({ status: 'completed', attempts: 1 }) }), // 0 retries
    mkBooking({ aiJob: mkJob({ status: 'failed', attempts: 3 }) }),    // 2 retries
    mkBooking({ aiJob: mkJob({ status: 'retrying', attempts: 2 }) }),  // 1 retry
  ]
  const d = computeEstimatorDiagnostics(bookings, [], { now: NOW })
  assert.equal(d.retries, 3)
})

// ── lowConfidenceRate from v2Shadow ──────────────────────────────────────────
test('lowConfidenceRate = share of v2Shadow estimates banded low; null when no shadow present', () => {
  const withShadow = [
    mkShadowBooking('low'),
    mkShadowBooking('low'),
    mkShadowBooking('high'),
    mkShadowBooking('medium'),
    mkBooking({ aiJob: mkJob({ status: 'completed' }) }), // no shadow — not in denominator
  ]
  const d = computeEstimatorDiagnostics(withShadow, [], { now: NOW })
  assert.equal(d.lowConfidenceRate, 0.5) // 2 of 4 shadow estimates

  // No shadow anywhere → null (shadow flag never ran), not a fabricated 0.
  const noShadow = computeEstimatorDiagnostics(
    [mkBooking({ aiJob: mkJob({ status: 'completed' }) })], [], { now: NOW },
  )
  assert.equal(noShadow.lowConfidenceRate, null)
})

// ── Telemetry averages + versions; null vs 0 semantics ───────────────────────
test('avg duration / cost + prompt & model versions come from telemetry', () => {
  const calls = [
    mkCall({ latencyMs: 1000, estCostUsd: 0.002, promptVersion: 2, model: 'anthropic/claude-sonnet-4-6' }),
    mkCall({ latencyMs: 3000, estCostUsd: 0.004, promptVersion: 3, model: 'anthropic/claude-haiku-4-5' }),
  ]
  const d = computeEstimatorDiagnostics([], calls, { now: NOW })
  assert.equal(d.avgAnalysisDurationMs, 2000)
  assert.equal(d.costPerAnalysisUsd, 0.003)
  assert.deepEqual(d.promptVersions, [2, 3])
  assert.deepEqual(d.modelVersions, ['anthropic/claude-haiku-4-5', 'anthropic/claude-sonnet-4-6'])
})

test('no fabrication: telemetry metrics are null when aiCalls omitted; 0/[] when provided-but-empty', () => {
  // aiCalls omitted entirely → telemetry unknown → null.
  const absent = computeEstimatorDiagnostics(
    [mkBooking({ aiJob: mkJob({ status: 'completed' }) })], undefined, { now: NOW },
  )
  assert.equal(absent.avgAnalysisDurationMs, null)
  assert.equal(absent.costPerAnalysisUsd, null)
  assert.equal(absent.providerFailures, null)
  assert.equal(absent.schemaValidationFailures, null)
  assert.equal(absent.promptVersions, null)
  assert.equal(absent.aiCallsConsidered, null)

  // aiCalls provided but empty → counts we can prove are 0 stay 0; averages stay null.
  const empty = computeEstimatorDiagnostics([], [], { now: NOW })
  assert.equal(empty.providerFailures, 0)
  assert.equal(empty.schemaValidationFailures, 0)
  assert.deepEqual(empty.promptVersions, [])
  assert.equal(empty.aiCallsConsidered, 0)
  assert.equal(empty.avgAnalysisDurationMs, null) // nothing to average
  assert.equal(empty.costPerAnalysisUsd, null)
})

// ── windowHours filter ───────────────────────────────────────────────────────
test('windowHours restricts both jobs and telemetry to the trailing window', () => {
  const recent = NOW - 1 * HOUR
  const stale = NOW - 48 * HOUR
  const bookings = [
    mkBooking({ aiJob: mkJob({ status: 'completed', updatedAt: recent, lastAttemptAt: recent }) }),
    mkBooking({ aiJob: mkJob({ status: 'completed', updatedAt: stale, lastAttemptAt: stale }) }),
  ]
  const calls = [
    mkCall({ at: recent, outcome: 'provider_error' }),
    mkCall({ at: stale, outcome: 'provider_error' }),
  ]
  const d = computeEstimatorDiagnostics(bookings, calls, { now: NOW, windowHours: 24 })
  assert.equal(d.jobsCreated, 1)          // only the recent job
  assert.equal(d.jobsCompleted, 1)
  assert.equal(d.providerFailures, 1)     // only the recent call
  assert.equal(d.aiCallsConsidered, 1)
  assert.equal(d.windowHours, 24)

  // No window → everything counts.
  const all = computeEstimatorDiagnostics(bookings, calls, { now: NOW })
  assert.equal(all.jobsCreated, 2)
  assert.equal(all.providerFailures, 2)
  assert.equal(all.windowHours, null)
})
