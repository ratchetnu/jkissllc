import {
  getBookingByToken, saveBooking, listBookings, pushBookingEvent, serviceFamily,
  type Booking, type AiJob, type AiJobErrorCode, type AiJobStatus,
} from './bookings'
import { buildPhotoEstimate } from './ai/photo-estimate'

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
export async function processAiJob(token: string, opts: { initiatedBy?: string; tenantId?: string } = {}): Promise<ProcessResult> {
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
  try {
    res = await buildPhotoEstimate({
      analysisId: `srv-${b.token}-${attempts}`, bookingId: b.token,
      photoUrls: (b.invoicePhotos ?? []).map(p => p.url), serviceType: b.serviceType,
    })
  } catch (e) {
    // The chain shouldn't throw (fail-soft), but if it does treat it as transient.
    const summary = e instanceof Error ? e.message.slice(0, 200) : 'processing error'
    b.aiJob = scheduleRetryOrFail(b, attempts, 'provider_unavailable', summary, opts.initiatedBy)
    await saveBooking(b)
    return { ok: false, status: b.aiJob.status, errorCode: 'provider_unavailable', reason: 'exception' }
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
  await saveBooking(b)
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

/** A job the cron may pick up right now (queued/retrying and past its backoff). */
export function isDue(b: Booking, at = now()): boolean {
  const j = b.aiJob
  if (!j || b.archived || b.isTest) return false
  if (j.status !== 'queued' && j.status !== 'retrying') return false
  return (j.nextRetryAt ?? 0) <= at
}

/** Cron entry point: process all due jobs (bounded). Returns a summary per booking. */
export async function runDueAiJobs(limit = 10): Promise<{ processed: number; results: { token: string; status: AiJobStatus }[] }> {
  const all = await listBookings(500)
  const due = all.filter(b => isDue(b)).slice(0, limit)
  const results: { token: string; status: AiJobStatus }[] = []
  for (const b of due) {
    const r = await processAiJob(b.token, { initiatedBy: 'cron' })
    results.push({ token: b.token, status: r.status })
  }
  return { processed: due.length, results }
}

/** Dry-run backfill report: eligible records that WOULD be enqueued, no writes. */
export async function backfillDryRun(): Promise<{ eligible: { bookingNumber: string; serviceType: string; photos: number; aiJobStatus?: AiJobStatus }[]; scanned: number }> {
  const all = await listBookings(500)
  const eligible = all.filter(needsAiJob).map(b => ({
    bookingNumber: b.bookingNumber, serviceType: b.serviceType, photos: photoVersion(b), aiJobStatus: b.aiJob?.status,
  }))
  return { eligible, scanned: all.length }
}
