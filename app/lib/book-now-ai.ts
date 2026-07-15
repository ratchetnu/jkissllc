import {
  getBookingByToken, saveBooking, listBookings, pushBookingEvent, serviceFamily, withBookingWriteLock,
  type Booking, type AiJob, type AiJobErrorCode, type AiJobStatus,
} from './bookings'
import { buildPhotoEstimate } from './ai/photo-estimate'
import { isEnabled } from './platform/flags'
import { runEstimationEngine } from './estimation/engine'
import { clarificationsFor } from './estimation/clarify'
import { buildShadowComparison, recordShadowComparison } from './estimation/shadow'
import type { EstimationResult } from './estimation/types'
import { analyzePhotosV2 } from './ai/analysis-v2'
import { estimateFromV2, type EstimationResultV2 } from './estimation/v2-bridge'
import { clarificationsForV2, type ClarificationV2 } from './estimation/clarify-v2'

// ─────────────────────────────────────────────────────────────────────────────
// Durable, server-side Book Now AI processing — the RECOVERY path for the
// customer-side instant estimate. State lives ON THE BOOKING (`aiJob`), advanced
// by a cron worker (/api/cron/ai-jobs) and owner controls. No in-memory promise,
// no fire-and-forget: "processing" is persisted before the slow model call, so a
// crash leaves a durable job the cron re-picks up.
//
// Idempotent per booking + photo set. Bounded exponential backoff. Permanent
// errors do not retry forever. All persisted error text is safe (non-PII).
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_ATTEMPTS = 5
// Backoff by attempt number (1-indexed). Beyond the array, the last value repeats.
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] // 1m, 5m, 15m, 1h

// Per-job graceful deadline for the model analysis. If buildPhotoEstimate runs longer
// than this we route the booking to manual_review (a terminal state the owner hand-
// prices) BEFORE Vercel hard-kills the function at its maxDuration — otherwise the job
// is left stuck in "processing" for the full stale lease and retries up to MAX_ATTEMPTS,
// which the owner sees as a booking frozen in "AI analysis" (with the admin page polling
// = "kept reloading"). Env-overridable; must stay comfortably below the cron route's
// maxDuration (300s). Raising the worker budget from 60s→300s means most legitimate
// heavy analyses now finish well within this deadline; only true hangs degrade.
const DEFAULT_AI_JOB_DEADLINE_MS = 150_000
function aiJobDeadlineMs(): number {
  const raw = Number(process.env.AI_JOB_DEADLINE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AI_JOB_DEADLINE_MS
}
// The cron function's own wall-clock ceiling (maxDuration=300s minus margin). runDueAiJobs
// won't START a new job unless a full per-job deadline can still elapse before this, so a
// late job is never hard-killed mid-run and left stuck in "processing".
const FUNCTION_BUDGET_MS = 285_000

// Errors that will never succeed on retry — route straight to a terminal state.
const PERMANENT: AiJobErrorCode[] = ['unsupported_image', 'bot_blocked', 'invalid_schema', 'pricing_validation_failed']

// Analyzer outcomes where the model RAN fine but produced no usable read — not a
// provider error, so retrying is futile → route to owner manual review instead.
const MODEL_RAN_EMPTY = ['no_items']
/** True when a failed read is "model ran, nothing to price" → manual review, not retry. */
export function needsManualReview(outcome: string | undefined): boolean {
  return MODEL_RAN_EMPTY.includes(outcome ?? '')
}

const now = () => Date.now()

/** Photos count doubles as a version — a changed set re-triggers analysis. */
export function photoVersion(b: Pick<Booking, 'invoicePhotos'>): number {
  return b.invoicePhotos?.length ?? 0
}

/** Only the junk/cleanout family is photo-estimated; moving/delivery are priced by hand. */
export function supportsPhotoAi(b: Pick<Booking, 'serviceType'>): boolean {
  return serviceFamily(b.serviceType) === 'junk'
}

/** A genuine, usable AI estimate is already attached (not a failed shell). */
export function hasValidEstimate(b: Pick<Booking, 'aiEstimate'>): boolean {
  return !!b.aiEstimate && b.aiEstimate.status !== 'failed' && !!b.aiEstimate.pricing
}

export function aiJobIdempotencyKey(b: Pick<Booking, 'token' | 'invoicePhotos'>, tenantId: string): string {
  return `book-now-ai:${tenantId}:${b.token}:${photoVersion(b)}`
}

/** A Book Now request that should be processed by the server-side worker. */
export function needsAiJob(b: Booking): boolean {
  return b.source === 'online'
    && !b.archived && !b.isTest
    && supportsPhotoAi(b)
    && photoVersion(b) > 0
    && !hasValidEstimate(b)
}

// Map the analyzer's telemetry outcome → a safe, persisted error category.
export function classifyOutcome(outcome: string | undefined, analyzedOk: boolean): AiJobErrorCode {
  if (analyzedOk) return 'unknown'
  const o = (outcome ?? '').toLowerCase()
  if (o.includes('rate') || o.includes('429')) return 'rate_limited'
  if (o.includes('block') || o.includes('bot')) return 'bot_blocked'
  if (o.includes('budget') || o.includes('unavailable') || o.includes('provider') || o.includes('timeout') || o.includes('500') || o.includes('503')) return 'provider_unavailable'
  if (o.includes('no_photos') || o.includes('unsupported')) return 'unsupported_image'
  if (o.includes('image') || o.includes('photo') || o.includes('fetch') || o.includes('media')) return 'image_access_failed'
  if (o.includes('schema') || o.includes('parse') || o.includes('invalid')) return 'invalid_schema'
  return 'provider_unavailable' // default: treat an unknown model failure as transient
}

function backoffMs(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
}

/**
 * The bounded-retry policy as a pure decision: given the attempt just made and the
 * error, should we retry (with what backoff) or go terminal (with what final code)?
 * Permanent errors never retry; transient errors retry until MAX_ATTEMPTS, then
 * become 'retry_exhausted'. Exported so the policy is unit-tested directly.
 */
export function retryDecision(attempts: number, code: AiJobErrorCode): { terminal: boolean; finalCode: AiJobErrorCode; delayMs?: number } {
  const permanent = PERMANENT.includes(code)
  if (permanent || attempts >= MAX_ATTEMPTS) {
    return { terminal: true, finalCode: permanent ? code : 'retry_exhausted' }
  }
  return { terminal: false, finalCode: code, delayMs: backoffMs(attempts) }
}

/**
 * Enqueue (or re-enqueue) a durable AI job on the booking. Mutates `b.aiJob`;
 * the CALLER persists. Idempotent: an active job for the same photo set is a
 * no-op, so repeated triggers never duplicate work. Returns true if it enqueued.
 */
export function enqueueAiJob(b: Booking, opts: { tenantId?: string; initiatedBy?: string; force?: boolean } = {}): boolean {
  if (!opts.force && !needsAiJob(b)) return false
  const key = aiJobIdempotencyKey(b, opts.tenantId ?? 'default')
  const active: AiJobStatus[] = ['queued', 'processing', 'retrying']
  if (!opts.force && b.aiJob && b.aiJob.idempotencyKey === key && (active.includes(b.aiJob.status) || b.aiJob.status === 'completed' || b.aiJob.status === 'manual_review')) {
    return false // already tracked for this exact photo set
  }
  b.aiJob = {
    status: 'queued', idempotencyKey: key, photoVersion: photoVersion(b),
    attempts: b.aiJob && b.aiJob.idempotencyKey === key ? b.aiJob.attempts : 0,
    nextRetryAt: now(), initiatedBy: opts.initiatedBy ?? 'system', updatedAt: now(),
  }
  pushBookingEvent(b, { actor: opts.initiatedBy ?? 'system', action: 'ai.queued', result: 'queued', meta: { photoVersion: photoVersion(b) } })
  return true
}

export type ProcessResult = {
  ok: boolean
  status: AiJobStatus
  reason?: string
  errorCode?: AiJobErrorCode
  decision?: string
}

/**
 * Run one attempt of the durable job for a booking. Persists "processing" before
 * the model call, attaches the estimate on success, or schedules a bounded retry /
 * terminal failure on provider error. Idempotent + safe to call repeatedly.
 */
export async function processAiJob(token: string, opts: { initiatedBy?: string; tenantId?: string; lockHeld?: boolean } = {}): Promise<ProcessResult> {
  // Serialize on the unified per-booking write lease so the inline + cron runners
  // (and any admin write) never double-execute / clobber. lockHeld skips re-acquire
  // when an admin handler already holds it. A missed lease → the cron retries.
  return withBookingWriteLock(token, () => processAiJobInner(token, opts), {
    onBusy: () => ({ ok: false, status: 'processing', reason: 'locked' }), ttlMs: 90_000, lockHeld: opts.lockHeld,
  })
}

async function processAiJobInner(token: string, opts: { initiatedBy?: string; tenantId?: string } = {}): Promise<ProcessResult> {
  const b = await getBookingByToken(token)
  if (!b) return { ok: false, status: 'failed', reason: 'not_found' }

  // Idempotency: a valid estimate already landed (e.g. the customer path succeeded
  // after enqueue) → mark complete, never double-price.
  if (hasValidEstimate(b)) {
    b.aiJob = completeJob(b, b.aiEstimate!.decision === 'manual_review' ? 'manual_review' : 'completed', opts.initiatedBy)
    await saveBooking(b)
    return { ok: true, status: b.aiJob.status, decision: b.aiEstimate!.decision }
  }
  if (!supportsPhotoAi(b) || photoVersion(b) === 0) {
    b.aiJob = failJob(b, 'unsupported_image', 'No analyzable photos for this service.', opts.initiatedBy, /*permanent*/ true)
    await saveBooking(b)
    return { ok: false, status: 'failed', errorCode: 'unsupported_image' }
  }

  // Stale-'processing' recovery. This booking's job crash-stranded in 'processing'
  // (a crash/timeout mid model-call). We run INSIDE the per-booking write lease, so
  // two crons can never double-recover. Transition it (terminal if attempts are
  // exhausted, else re-arm to 'retrying') WITHOUT burning a model call here; the
  // re-armed job runs once more on the next normal pickup. The stale attempt counts
  // — attempts are never reset, terminal states are never resurrected.
  if (isStaleProcessing(b.aiJob)) {
    const recovered = recoverStaleJob(b.aiJob)!
    b.aiJob = recovered
    pushBookingEvent(b, {
      actor: opts.initiatedBy ?? 'cron',
      action: recovered.status === 'manual_review' ? 'ai.manual_review' : 'ai.queued',
      result: 'recovered_stale',
      meta: { recovered: true, attempts: recovered.attempts, prior: 'processing' },
    })
    console.log(`[book-now-ai] recovered stale processing job token=${b.token.slice(0, 8)} attempts=${recovered.attempts} -> ${recovered.status}`)
    await saveBooking(b)
    return { ok: recovered.status !== 'manual_review', status: recovered.status, reason: 'recovered_stale' }
  }

  // Persist "processing" BEFORE the slow call so a crash leaves a durable record.
  const prior = b.aiJob
  const attempts = (prior?.attempts ?? 0) + 1
  b.aiJob = {
    status: 'processing',
    idempotencyKey: prior?.idempotencyKey ?? aiJobIdempotencyKey(b, opts.tenantId ?? 'default'),
    photoVersion: photoVersion(b), attempts,
    lastAttemptAt: now(), initiatedBy: opts.initiatedBy ?? prior?.initiatedBy ?? 'system', updatedAt: now(),
  }
  await saveBooking(b)

  let res
  const deadlineMs = aiJobDeadlineMs()
  const DEADLINE = Symbol('ai-job-deadline')
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const analysisP = buildPhotoEstimate({
      analysisId: `srv-${b.token}-${attempts}`, bookingId: b.token,
      photoUrls: (b.invoicePhotos ?? []).map(p => p.url), serviceType: b.serviceType,
    })
    // If the deadline wins the race we abandon this promise; swallow any late rejection
    // so it can't surface as an unhandledRejection after we've already moved on.
    analysisP.catch(() => {})
    res = await Promise.race([
      analysisP,
      new Promise<never>((_, reject) => { deadlineTimer = setTimeout(() => reject(DEADLINE), deadlineMs) }),
    ])
  } catch (e) {
    if (e === DEADLINE) {
      // The analysis outran its time budget. Degrade gracefully to manual review so the
      // booking reaches a TERMINAL state now — instead of a hard function kill that leaves
      // it stuck in "processing" and retrying. The owner hand-prices from here.
      b.aiJob = {
        status: 'manual_review', idempotencyKey: b.aiJob.idempotencyKey, photoVersion: photoVersion(b), attempts,
        lastAttemptAt: now(), completedAt: now(),
        errorSummary: 'Photo analysis exceeded its time budget — routed to manual pricing.',
        initiatedBy: opts.initiatedBy ?? b.aiJob.initiatedBy, updatedAt: now(),
      }
      pushBookingEvent(b, { actor: opts.initiatedBy ?? 'system', action: 'ai.manual_review', result: 'ai:deadline', meta: { attempts, deadlineMs } })
      await saveBooking(b)
      return { ok: false, status: 'manual_review', reason: 'deadline' }
    }
    // The chain shouldn't throw (fail-soft), but if it does treat it as transient.
    const summary = e instanceof Error ? e.message.slice(0, 200) : 'processing error'
    b.aiJob = scheduleRetryOrFail(b, attempts, 'provider_unavailable', summary, opts.initiatedBy)
    await saveBooking(b)
    return { ok: false, status: b.aiJob.status, errorCode: 'provider_unavailable', reason: 'exception' }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer)
  }

  if (!res.analyzedOk) {
    // The model ran and returned valid output but found NO identifiable items — a
    // photo the AI can't price, not a provider error. Retrying just repeats it, so
    // route straight to MANUAL REVIEW for the owner to price by hand. We attach the
    // (item-less) analysis so the owner sees what the model observed.
    if (MODEL_RAN_EMPTY.includes(res.outcome)) {
      b.aiEstimate = res.stored
      b.aiJob = {
        status: 'manual_review', idempotencyKey: b.aiJob.idempotencyKey, photoVersion: photoVersion(b), attempts,
        lastAttemptAt: now(), completedAt: now(), provider: res.stored.provider, model: res.model, providerTraceId: res.callId,
        errorSummary: 'AI found no identifiable items in the photos — needs manual pricing.',
        initiatedBy: opts.initiatedBy ?? b.aiJob.initiatedBy, updatedAt: now(),
      }
      pushBookingEvent(b, { actor: opts.initiatedBy ?? 'system', action: 'ai.manual_review', result: `ai:${res.outcome}`, meta: { attempts, outcome: res.outcome } })
      await saveBooking(b)
      return { ok: false, status: 'manual_review', reason: res.outcome }
    }
    // A genuine provider failure (timeout, 5xx, rate limit, image fetch) → retry.
    const code = classifyOutcome(res.outcome, false)
    b.aiJob = scheduleRetryOrFail(b, attempts, code, `AI vision did not return a usable read (${res.outcome}).`, opts.initiatedBy)
    await saveBooking(b)
    return { ok: false, status: b.aiJob.status, errorCode: code }
  }

  // Success — attach the estimate + advance the workflow. Never a price without a read.
  b.aiEstimate = res.stored
  b.disposalEstimateCents = res.stored.pricing.breakdown.disposalCents

  const status: AiJobStatus = res.stored.decision === 'manual_review' ? 'manual_review' : 'completed'
  b.aiJob = {
    status, idempotencyKey: b.aiJob.idempotencyKey, photoVersion: photoVersion(b), attempts,
    lastAttemptAt: b.aiJob.lastAttemptAt, completedAt: now(),
    provider: res.stored.provider, model: res.model, providerTraceId: res.callId,
    initiatedBy: opts.initiatedBy ?? b.aiJob.initiatedBy, updatedAt: now(),
  }
  pushBookingEvent(b, {
    actor: opts.initiatedBy ?? 'system',
    action: status === 'manual_review' ? 'ai.manual_review' : 'ai.analyzed',
    result: `ai:${res.stored.decision}`,
    meta: { recommendedUsd: res.stored.pricing.recommendedUsd, confidence: res.stored.analysis.confidence?.overall, attempts, model: res.model },
  })
  // Persist the AUTHORITATIVE estimate + completed status FIRST — before any shadow
  // work — so a slow/failed shadow can never delay, lose, or block the live result.
  await saveBooking(b)

  // SHADOW (VISION_ESTIMATION_SHADOW, default OFF): runs AFTER the authoritative save.
  // Stashes results for admin comparison + records the redacted delta. NEVER
  // authoritative, never shown to the customer, fully fail-soft. Off ⇒ no-op
  // (byte-identical to today). A V2 provider timeout/error only affects the shadow
  // stash — the live estimate is already durably saved and the job already complete.
  if (isEnabled('VISION_ESTIMATION_SHADOW')) {
    let shadowDirty = false
    // (a) v1 deterministic engine over the already-computed analysis (no extra AI call).
    try {
      const shadow = runEstimationEngine(res.stored.analysis, {
        bookingId: b.token, serviceType: b.serviceType,
        imageIds: (b.invoicePhotos ?? []).map((p) => p.url),
      })
      shadow.clarificationQuestions = clarificationsFor(shadow)
      shadow.clarificationRequired = shadow.clarificationQuestions.length > 0
      ;(b as { shadowEstimate?: EstimationResult }).shadowEstimate = shadow
      shadowDirty = true
      recordShadowComparison(
        buildShadowComparison(shadow, { recommendedUsd: res.stored.pricing.recommendedUsd, decision: res.stored.decision }),
      )
    } catch (e) {
      console.error('[book-now-ai] shadow estimation v1 (non-fatal)', e)
    }
    // (b) v2 MULTI-PASS pipeline: a fresh per-image + reconciled vision analysis →
    // deterministic bridge (volume/tier/pricing via priceJob, model never prices) →
    // intelligent clarification questions. One extra vision call, shadow-only.
    try {
      const v2 = await analyzePhotosV2({
        bookingId: b.token,
        photoUrls: (b.invoicePhotos ?? []).map((p) => p.url),
        serviceLabel: b.serviceType,
        customerNotes: b.description,
        nowIso: new Date(now()).toISOString(),
      })
      const v2Estimate = estimateFromV2(v2.analysis, { bookingId: b.token, serviceType: b.serviceType })
      const v2Questions = clarificationsForV2(v2.analysis)
      ;(b as { v2Shadow?: { estimate: EstimationResultV2; questions: ClarificationV2[]; ok: boolean; model?: string } }).v2Shadow =
        { estimate: v2Estimate, questions: v2Questions, ok: v2.ok, model: v2.model }
      shadowDirty = true
      recordShadowComparison(
        buildShadowComparison(v2Estimate, { recommendedUsd: res.stored.pricing.recommendedUsd, decision: res.stored.decision }),
      )
    } catch (e) {
      console.error('[book-now-ai] shadow estimation v2 (non-fatal)', e)
    }
    // Persist the stashed shadow separately (second write) — fail-soft; a failure here
    // cannot affect the already-saved authoritative estimate. Re-load under the lock is
    // unnecessary: we still hold the same booking object; saveBooking is last-write of
    // the shadow-only fields.
    if (shadowDirty) {
      try { await saveBooking(b) } catch (e) { console.error('[book-now-ai] shadow persist (non-fatal)', e) }
    }
  }
  return { ok: true, status, decision: res.stored.decision }
}

function completeJob(b: Booking, status: AiJobStatus, initiatedBy?: string): AiJob {
  const prior = b.aiJob
  return {
    status, idempotencyKey: prior?.idempotencyKey ?? aiJobIdempotencyKey(b, 'default'),
    photoVersion: photoVersion(b), attempts: prior?.attempts ?? 1,
    completedAt: now(), provider: b.aiEstimate?.provider, model: b.aiEstimate?.model,
    initiatedBy: initiatedBy ?? prior?.initiatedBy ?? 'system', updatedAt: now(),
  }
}

function failJob(b: Booking, code: AiJobErrorCode, summary: string, initiatedBy: string | undefined, permanent: boolean): AiJob {
  const prior = b.aiJob
  pushBookingEvent(b, { actor: initiatedBy ?? 'system', action: 'ai.failed', result: code, meta: { permanent } })
  return {
    status: 'failed', idempotencyKey: prior?.idempotencyKey ?? aiJobIdempotencyKey(b, 'default'),
    photoVersion: photoVersion(b), attempts: prior?.attempts ?? 1,
    lastAttemptAt: now(), errorCode: code, errorSummary: summary,
    initiatedBy: initiatedBy ?? prior?.initiatedBy ?? 'system', updatedAt: now(),
  }
}

function scheduleRetryOrFail(b: Booking, attempts: number, code: AiJobErrorCode, summary: string, initiatedBy?: string): AiJob {
  const idempotencyKey = b.aiJob?.idempotencyKey ?? aiJobIdempotencyKey(b, 'default')
  const d = retryDecision(attempts, code)
  if (d.terminal) {
    pushBookingEvent(b, { actor: initiatedBy ?? 'system', action: 'ai.failed', result: d.finalCode, meta: { attempts } })
    return {
      status: 'failed', idempotencyKey, photoVersion: photoVersion(b), attempts,
      lastAttemptAt: now(), errorCode: d.finalCode, errorSummary: summary,
      initiatedBy: initiatedBy ?? 'system', updatedAt: now(),
    }
  }
  return {
    status: 'retrying', idempotencyKey, photoVersion: photoVersion(b), attempts,
    lastAttemptAt: now(), nextRetryAt: now() + (d.delayMs ?? 0),
    errorCode: code, errorSummary: summary, initiatedBy: initiatedBy ?? 'system', updatedAt: now(),
  }
}

// ── Stale-`processing` recovery ──────────────────────────────────────────────
// A crash/timeout DURING the model call strands a job in 'processing' forever,
// because the normal due-check only re-picks queued/retrying. A 'processing' job
// whose entered-processing timestamp (`lastAttemptAt`, stamped just before the slow
// call in processAiJobInner) is older than this lease is treated as CRASHED and
// recovered. The lease MUST be >> the 60s function maxDuration so a HEALTHY in-flight
// job is NEVER reaped. Read from AI_PROCESSING_LEASE_MS; safe 5-minute default.
export function processingLeaseMs(): number {
  const raw = Number(process.env.AI_PROCESSING_LEASE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60_000
}

/** True when a 'processing' job was stranded (entered processing more than the lease
 *  ago and never advanced). Missing timestamp → never reaped (fail-safe). */
export function isStaleProcessing(
  j: Pick<AiJob, 'status' | 'lastAttemptAt'> | undefined,
  at = now(),
  leaseMs = processingLeaseMs(),
): boolean {
  if (!j || j.status !== 'processing') return false
  const startedAt = j.lastAttemptAt ?? 0
  if (!startedAt) return false
  return at - startedAt > leaseMs
}

/**
 * Recover a stale-'processing' job (crash/timeout mid model-call). Pure + idempotent.
 * The stranded attempt ALREADY counted (attempts was incremented before the model
 * call), so we NEVER reset attempts. If it already burned MAX_ATTEMPTS → terminal
 * manual_review (an owner prices by hand; we don't spend another model call). Else
 * re-arm it as 'retrying', due immediately, so the normal path runs it once more.
 * Returns the new AiJob, or null when `j` is not a recoverable stale-'processing' job
 * — terminal failed/manual_review states are never resurrected.
 */
export function recoverStaleJob(
  j: AiJob | undefined,
  at = now(),
  leaseMs = processingLeaseMs(),
  maxAttempts = MAX_ATTEMPTS,
): AiJob | null {
  if (!j || !isStaleProcessing(j, at, leaseMs)) return null
  if (j.attempts >= maxAttempts) {
    return {
      ...j, status: 'manual_review', completedAt: at, updatedAt: at,
      errorCode: 'retry_exhausted',
      errorSummary: `Recovered a stranded AI job after ${j.attempts} attempt(s) — needs manual pricing.`,
    }
  }
  return {
    ...j, status: 'retrying', nextRetryAt: at, updatedAt: at,
    errorCode: 'provider_unavailable',
    errorSummary: 'Recovered a stranded AI job (interrupted mid-analysis) — re-queued for one more attempt.',
  }
}

/** A job the cron may pick up right now: queued/retrying past its backoff, OR a
 *  crash-stranded 'processing' job older than the lease (recovered on pickup). */
export function isDue(b: Booking, at = now()): boolean {
  const j = b.aiJob
  if (!j || b.archived || b.isTest) return false
  if (j.status === 'queued' || j.status === 'retrying') return (j.nextRetryAt ?? 0) <= at
  if (j.status === 'processing') return isStaleProcessing(j, at)
  return false
}

/** Cron entry point: process all due jobs (bounded). Returns a summary per booking. */
export async function runDueAiJobs(limit = 10): Promise<{ processed: number; results: { token: string; status: AiJobStatus }[] }> {
  const all = await listBookings(500)
  const due = all.filter(b => isDue(b)).slice(0, limit)
  const results: { token: string; status: AiJobStatus }[] = []
  const runStart = now()
  const deadlineMs = aiJobDeadlineMs()
  for (const b of due) {
    // Never start a job that can't finish its full deadline before the function's own
    // wall-clock ceiling — a late job would be hard-killed mid-run and stick. It stays
    // due and the next cron tick picks it up.
    if (now() - runStart + deadlineMs > FUNCTION_BUDGET_MS) break
    const r = await processAiJob(b.token, { initiatedBy: 'cron' })
    results.push({ token: b.token, status: r.status })
  }
  return { processed: results.length, results }
}

/** Dry-run backfill report: eligible records that WOULD be enqueued, no writes. */
export async function backfillDryRun(): Promise<{ eligible: { bookingNumber: string; serviceType: string; photos: number; aiJobStatus?: AiJobStatus }[]; scanned: number }> {
  const all = await listBookings(500)
  const eligible = all.filter(needsAiJob).map(b => ({
    bookingNumber: b.bookingNumber, serviceType: b.serviceType, photos: photoVersion(b), aiJobStatus: b.aiJob?.status,
  }))
  return { eligible, scanned: all.length }
}
