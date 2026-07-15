// ── V2 Shadow — independent worker (enqueue • process • run-due) ──────────────
//
// This is the ONLY place the heavy V2 vision call runs, and it runs OUTSIDE the
// authoritative worker — on its own cron, its own queue, its own budget. It never
// mutates the booking's authoritative estimate/status/price and never sends comms.
// Every external dependency is injectable so the whole thing is hermetically testable.

import type { Booking } from '../bookings'
import { getBookingByToken } from '../bookings'
import { isEnabled, type FeatureFlag } from '../platform/flags'
import { analyzePhotosV2 } from '../ai/analysis-v2'
import { estimateFromV2 } from './v2-bridge'
import { clarificationsForV2 } from './clarify-v2'
import { buildV2Comparison } from './shadow-comparison'
import {
  getShadowJob, saveShadowJob, listShadowJobs, withShadowLock,
  isExcluded as storeIsExcluded, isSelected as storeIsSelected,
} from './shadow-store'
import {
  evaluateShadowEligibility, isShadowDue, shadowRetryDecision, classifyShadowFailure,
  shadowIdempotencyKey, shadowJobId, shadowDeadlineMs, shadowLeaseMs, shadowMaxAttempts,
  SHADOW_FUNCTION_BUDGET_MS, V2_ESTIMATOR_VERSION, type ShadowFlags,
} from './shadow-policy'
import { V2_SHADOW_JOB_VERSION, type V2ShadowJob, type V2ShadowCreatedBy, type V2ShadowFailure } from './shadow-types'

type EnvLike = Record<string, string | undefined>

// ── Injectable dependencies (default to the real store/AI/clock) ─────────────
export type ShadowDeps = {
  now?: () => number
  env?: EnvLike
  getBooking?: (id: string) => Promise<Booking | null>
  getJob?: (id: string) => Promise<V2ShadowJob | null>
  saveJob?: (job: V2ShadowJob) => Promise<void>
  listJobs?: (limit: number) => Promise<V2ShadowJob[]>
  analyze?: typeof analyzePhotosV2
  estimate?: typeof estimateFromV2
  clarify?: typeof clarificationsForV2
  isExcluded?: (id: string) => Promise<boolean>
  isSelected?: (id: string) => Promise<boolean>
  lock?: <T>(id: string, fn: () => Promise<T>, onBusy: () => T, token: string) => Promise<T>
}

function resolve(deps: ShadowDeps = {}) {
  const now = deps.now ?? (() => Date.now())
  return {
    now,
    env: deps.env ?? process.env,
    getBooking: deps.getBooking ?? getBookingByToken,
    getJob: deps.getJob ?? getShadowJob,
    saveJob: deps.saveJob ?? saveShadowJob,
    listJobs: deps.listJobs ?? listShadowJobs,
    analyze: deps.analyze ?? analyzePhotosV2,
    estimate: deps.estimate ?? estimateFromV2,
    clarify: deps.clarify ?? clarificationsForV2,
    isExcluded: deps.isExcluded ?? storeIsExcluded,
    isSelected: deps.isSelected ?? storeIsSelected,
    lock: deps.lock ?? (<T>(id: string, fn: () => Promise<T>, onBusy: () => T, token: string) =>
      withShadowLock(id, fn, { onBusy, token, ttlMs: shadowLeaseMs(deps.env ?? process.env) })),
  }
}

function flag(env: EnvLike, f: FeatureFlag): boolean { return isEnabled(f, env) }
function shadowFlags(env: EnvLike): ShadowFlags {
  return {
    queueEnabled: flag(env, 'VISION_SHADOW_QUEUE_ENABLED'),
    autoEnqueue: flag(env, 'VISION_SHADOW_AUTO_ENQUEUE'),
    selectedOnly: flag(env, 'VISION_SHADOW_SELECTED_ONLY'),
  }
}

function photoVersion(b: Pick<Booking, 'invoicePhotos'>): number { return b.invoicePhotos?.length ?? 0 }
function authoritativeTerminal(b: Booking): boolean {
  return b.aiJob?.status === 'completed' || b.aiJob?.status === 'manual_review'
}
function authoritativeBaseline(b: Booking): { recommendedUsd?: number; decision?: string } {
  const est = b.aiEstimate as { pricing?: { recommendedUsd?: number }; decision?: string } | undefined
  return { recommendedUsd: est?.pricing?.recommendedUsd, decision: est?.decision }
}

// ── Enqueue (Phase 5) — called AFTER authoritative terminal, or by owner ─────
export type EnqueueResult = { enqueued: boolean; reason: string; job?: V2ShadowJob }

/**
 * Consider a booking for shadow analysis and, if eligible, enqueue a job in the
 * INDEPENDENT store. Fail-soft by construction (callers wrap it); it performs no AI
 * work and never touches authoritative fields. `manualEnqueue` bypasses auto/selected
 * gating (owner action); `force` re-runs even if a completed job exists.
 */
export async function enqueueShadowJobForBooking(
  b: Booking,
  opts: { createdBy: V2ShadowCreatedBy; manualEnqueue?: boolean; force?: boolean; deps?: ShadowDeps } = { createdBy: 'auto' },
): Promise<EnqueueResult> {
  const d = resolve(opts.deps)
  const now = d.now()
  const pv = photoVersion(b)
  const idem = shadowIdempotencyKey(b.token, V2_ESTIMATOR_VERSION, pv)
  const existing = opts.force ? null : await d.getJob(b.token)

  const elig = evaluateShadowEligibility(
    {
      bookingId: b.token,
      idempotencyKey: idem,
      photoCount: pv,
      isTest: b.isTest,
      cancelled: !!b.archived,
      authoritativeTerminal: authoritativeTerminal(b),
      excluded: await d.isExcluded(b.token),
      selected: await d.isSelected(b.token),
      existingJob: existing ? { status: existing.status, idempotencyKey: existing.idempotencyKey } : null,
      manualEnqueue: opts.manualEnqueue,
    },
    shadowFlags(d.env),
  )
  if (!elig.eligible) return { enqueued: false, reason: elig.reason }

  const job: V2ShadowJob = {
    jobVersion: V2_SHADOW_JOB_VERSION,
    bookingId: b.token,
    bookingNumber: b.bookingNumber,
    shadowJobId: shadowJobId(b.token, pv, V2_ESTIMATOR_VERSION),
    status: 'queued',
    idempotencyKey: idem,
    estimatorVersion: V2_ESTIMATOR_VERSION,
    imageCount: pv,
    attempts: 0,
    createdBy: opts.createdBy,
    // preserve any prior owner ground truth across a re-run
    groundTruth: existing?.groundTruth,
    queuedAt: now,
    nextRetryAt: now,
    updatedAt: now,
  }
  await d.saveJob(job)
  return { enqueued: true, reason: 'queued', job }
}

/** Fail-soft wrapper for the post-terminal auto path — never throws into the caller. */
export async function maybeEnqueueShadowJob(b: Booking, deps?: ShadowDeps): Promise<void> {
  try {
    if (!isEnabled('VISION_SHADOW_QUEUE_ENABLED', (deps?.env ?? process.env))) return
    await enqueueShadowJobForBooking(b, { createdBy: 'auto', deps })
  } catch (e) {
    // The authoritative estimate is already saved; a shadow enqueue error is inert.
    try { console.error('[vision-shadow] enqueue (non-fatal)', e) } catch { /* noop */ }
  }
}

// ── Process one job (Phases 6/7) ─────────────────────────────────────────────
const DEADLINE = Symbol('shadow-deadline')

function applyFailure(job: V2ShadowJob, failure: V2ShadowFailure, summary: string, now: number, maxAttempts: number): void {
  const decision = shadowRetryDecision(job.attempts, failure, maxAttempts)
  job.failureCategory = failure
  job.failureSummary = summary.slice(0, 240)
  job.updatedAt = now
  if (decision.terminal) {
    job.status = decision.status
    job.completedAt = now
  } else {
    job.status = 'retrying'
    job.nextRetryAt = now + decision.delayMs
  }
}

export async function processShadowJob(bookingId: string, deps?: ShadowDeps): Promise<{ ok: boolean; status: string; reason?: string }> {
  const d = resolve(deps)
  const token = `${bookingId}:${d.now()}`
  return d.lock(
    bookingId,
    () => processShadowInner(bookingId, deps),
    () => ({ ok: false, status: 'processing', reason: 'locked' }),
    token,
  )
}

async function processShadowInner(bookingId: string, deps?: ShadowDeps): Promise<{ ok: boolean; status: string; reason?: string }> {
  const d = resolve(deps)
  const env = d.env
  const now = d.now()
  const maxAttempts = shadowMaxAttempts(env)

  const job = await d.getJob(bookingId)
  if (!job) return { ok: false, status: 'failed', reason: 'no_job' }
  if (!isShadowDue(job, now, shadowLeaseMs(env))) return { ok: false, status: job.status, reason: 'not_due' }

  // Enter processing (durable) BEFORE the slow call so a crash is recoverable.
  job.status = 'processing'
  job.startedAt = now
  job.heartbeatAt = now
  job.attempts += 1
  job.timeoutCategory = undefined
  job.failureCategory = undefined
  job.updatedAt = now
  await d.saveJob(job)

  const b = await d.getBooking(bookingId)
  if (!b) { applyFailure(job, 'internal_error', 'booking not found', d.now(), maxAttempts); await d.saveJob(job); return { ok: false, status: job.status, reason: 'no_booking' } }
  const photoUrls = (b.invoicePhotos ?? []).map((p) => p.url)
  if (photoUrls.length === 0) { applyFailure(job, 'no_usable_images', 'no photos on booking', d.now(), maxAttempts); await d.saveJob(job); return { ok: false, status: job.status, reason: 'no_photos' } }

  // Run the heavy V2 vision analysis under a graceful deadline (well below maxDuration).
  const deadlineMs = shadowDeadlineMs(env)
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let v2: Awaited<ReturnType<typeof analyzePhotosV2>>
  try {
    const analysisP = d.analyze({
      bookingId: b.token,
      photoUrls,
      serviceLabel: b.serviceType,
      customerNotes: b.description,
      nowIso: new Date(d.now()).toISOString(),
    })
    analysisP.catch(() => {})
    v2 = await Promise.race([
      analysisP,
      new Promise<never>((_, reject) => { deadlineTimer = setTimeout(() => reject(DEADLINE), deadlineMs) }),
    ])
  } catch (e) {
    if (e === DEADLINE) {
      job.timeoutCategory = 'deadline'
      applyFailure(job, 'deadline', 'V2 analysis exceeded its shadow deadline', d.now(), maxAttempts)
      await d.saveJob(job)
      return { ok: false, status: job.status, reason: 'deadline' }
    }
    applyFailure(job, 'internal_error', e instanceof Error ? e.message : 'analysis threw', d.now(), maxAttempts)
    await d.saveJob(job)
    return { ok: false, status: job.status, reason: 'exception' }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer)
  }

  if (!v2.ok) {
    const failure = classifyShadowFailure(v2.outcome)
    applyFailure(job, failure, `V2 did not return a usable read (${v2.outcome})`, d.now(), maxAttempts)
    await d.saveJob(job)
    return { ok: false, status: job.status, reason: v2.outcome }
  }

  // Success — build the deterministic estimate + questions + comparison (model never prices).
  try {
    const estimate = d.estimate(v2.analysis, { bookingId: b.token, serviceType: b.serviceType })
    const questions = d.clarify(v2.analysis)
    const comparison = buildV2Comparison(estimate, authoritativeBaseline(b), job.groundTruth)
    const endNow = d.now()
    job.status = estimate.manualReviewRequired ? 'manual_review' : 'completed'
    job.result = { estimate, questions, ok: true, model: v2.model, analysisVersion: estimate.v2?.analysisVersion, promptVersion: job.promptVersion }
    job.comparison = comparison
    job.model = v2.model
    job.traceId = v2.callId
    job.latencyMs = v2.latencyMs
    job.completedAt = endNow
    job.failureCategory = undefined
    job.failureSummary = undefined
    job.updatedAt = endNow
    await d.saveJob(job)
    return { ok: true, status: job.status }
  } catch (e) {
    applyFailure(job, 'internal_error', e instanceof Error ? e.message : 'bridge/compare threw', d.now(), maxAttempts)
    await d.saveJob(job)
    return { ok: false, status: job.status, reason: 'bridge_error' }
  }
}

// ── Cron entry point ─────────────────────────────────────────────────────────
/** Process due shadow jobs, bounded by count AND a wall-clock budget. Gated by the
 *  worker flag — off ⇒ a pure no-op (no scan, no AI). */
export async function runDueShadowJobs(limit = 1, deps?: ShadowDeps): Promise<{ processed: number; results: { bookingId: string; status: string }[] }> {
  const d = resolve(deps)
  if (!isEnabled('VISION_SHADOW_WORKER_ENABLED', d.env)) return { processed: 0, results: [] }
  const jobs = await d.listJobs(500)
  const lease = shadowLeaseMs(d.env)
  const deadlineMs = shadowDeadlineMs(d.env)
  const due = jobs.filter((j) => isShadowDue(j, d.now(), lease)).slice(0, Math.max(1, limit))
  const results: { bookingId: string; status: string }[] = []
  const runStart = d.now()
  for (const j of due) {
    if (d.now() - runStart + deadlineMs > SHADOW_FUNCTION_BUDGET_MS) break
    const r = await processShadowJob(j.bookingId, deps)
    results.push({ bookingId: j.bookingId, status: r.status })
  }
  return { processed: results.length, results }
}
