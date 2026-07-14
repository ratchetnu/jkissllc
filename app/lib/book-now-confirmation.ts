import {
  getBookingByToken, saveBooking, listBookings, pushBookingEvent, withBookingWriteLock,
  type Booking, type AiJob, type AiJobErrorCode, type AiJobStatus,
} from './bookings'
import {
  normalizeConfirmation, activeItems,
  type CustomerConfirmation,
} from './ai/confirmation-schema'
import { detectPhotoTextConflicts } from './ai/photo-text-consistency'
import { buildConfirmedPhotoEstimate } from './ai/confirmed-analysis'
import { supportsPhotoAi } from './book-now-ai'

// The confirmation + final-analysis writers serialize on the UNIFIED per-booking
// write lease (bk:wlock) shared with the admin handler and the initial-AI worker,
// so no two side-effecting operations touch the same booking at once. `lockHeld`
// lets an admin-triggered call skip re-acquiring a lease its caller already holds.

// ─────────────────────────────────────────────────────────────────────────────
// Durable customer inventory-confirmation + SECOND (final) analysis worker.
//
// Extends the existing Book Now AI pipeline (book-now-ai.ts) rather than replacing
// it. The FIRST analysis (aiJob → aiEstimate) is untouched. After the customer
// confirms/corrects the detected inventory, `submitConfirmation` persists the
// confirmation ON THE BOOKING and enqueues a durable FINAL-analysis job
// (`finalAiJob`) advanced by the same cron + owner controls. State is persisted
// before the slow model/pricing call, so a crash / closed browser / retried submit
// never strands the request. Idempotent on the confirmation version.
// ─────────────────────────────────────────────────────────────────────────────

export const MAX_FINAL_ATTEMPTS = 5
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
const now = () => Date.now()

export function finalJobIdempotencyKey(token: string, confirmationVersion: number, tenantId = 'default'): string {
  return `book-now-final:${tenantId}:${token}:${confirmationVersion}`
}

function backoffMs(attempt: number): number {
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
}

/** The next monotonic confirmation version for a booking (1-indexed). */
export function nextConfirmationVersion(b: Pick<Booking, 'confirmation'>): number {
  return (b.confirmation?.confirmationVersion ?? 0) + 1
}

export type SubmitConfirmationResult = {
  ok: boolean
  confirmation?: CustomerConfirmation
  status: AiJobStatus | 'rejected'
  reason?: string
}

/**
 * Persist a customer (or owner-assisted) inventory confirmation and enqueue the
 * durable final-analysis job. Idempotent: a retry carrying the SAME idempotencyKey
 * as the stored confirmation is a no-op that returns the existing record (so a
 * double-submit / refresh never creates a second version or a duplicate job).
 */
export async function submitConfirmation(
  token: string,
  rawConfirmation: unknown,
  opts: { submittedBy?: 'customer' | 'owner'; tenantId?: string; initiatedBy?: string; nowIso?: string; lockHeld?: boolean } = {},
): Promise<SubmitConfirmationResult> {
  const incomingKey = typeof (rawConfirmation as { idempotencyKey?: unknown })?.idempotencyKey === 'string'
    ? (rawConfirmation as { idempotencyKey: string }).idempotencyKey
    : undefined

  // Serialize concurrent submits for the SAME booking so two racing submits can't
  // land the same confirmation version (which would collide on the final-job key).
  return withBookingWriteLock(token, async () => {
  const b = await getBookingByToken(token)
  if (!b) return { ok: false, status: 'rejected', reason: 'not_found' }
  if (b.isTest || b.archived) return { ok: false, status: 'rejected', reason: 'ineligible' }

  // ── Idempotency: same key as the stored confirmation → return it, no new version.
  if (incomingKey && b.confirmation?.idempotencyKey === incomingKey) {
    return { ok: true, confirmation: b.confirmation, status: b.finalAiJob?.status ?? 'queued', reason: 'idempotent' }
  }

  const nowIso = opts.nowIso ?? new Date().toISOString()
  const confirmation = normalizeConfirmation(rawConfirmation, {
    now: nowIso,
    confirmationVersion: nextConfirmationVersion(b),
    submittedBy: opts.submittedBy ?? 'customer',
    status: 'submitted',
  })

  // Server-computed conflicts (never client-trusted) against the INITIAL analysis.
  confirmation.conflicts = detectPhotoTextConflicts(b.aiEstimate?.analysis, confirmation)

  // Supersede any prior confirmation (kept in the event log, not overwritten silently).
  if (b.confirmation) {
    pushBookingEvent(b, {
      actor: opts.initiatedBy ?? 'system', action: 'confirmation.submitted',
      result: 'superseded', meta: { priorVersion: b.confirmation.confirmationVersion },
    })
  }
  b.confirmation = confirmation

  pushBookingEvent(b, {
    actor: opts.submittedBy === 'owner' ? (opts.initiatedBy ?? 'owner') : 'customer',
    action: 'confirmation.submitted',
    result: `v${confirmation.confirmationVersion}`,
    meta: {
      items: activeItems(confirmation).length,
      added: confirmation.items.filter(i => !i.removed && !i.aiDetected).length,
      removed: confirmation.items.filter(i => i.removed).length,
      conflicts: confirmation.conflicts.length,
      attested: !!confirmation.attestation?.representsEverything,
    },
  })

  // Enqueue the durable final-analysis job for this confirmation version.
  enqueueFinalAiJob(b, { tenantId: opts.tenantId, initiatedBy: opts.initiatedBy ?? 'system', force: true })
  await saveBooking(b)

  return { ok: true, confirmation, status: b.finalAiJob?.status ?? 'queued' }
  }, { onBusy: () => ({ ok: false as const, status: 'rejected' as const, reason: 'busy' }), ttlMs: 15_000, lockHeld: opts.lockHeld })
}

/**
 * Enqueue (or re-enqueue) the durable final-analysis job. Mutates `b.finalAiJob`;
 * the CALLER persists. Idempotent per confirmation version. Returns true if enqueued.
 */
export function enqueueFinalAiJob(
  b: Booking,
  opts: { tenantId?: string; initiatedBy?: string; force?: boolean } = {},
): boolean {
  if (!b.confirmation) return false
  const key = finalJobIdempotencyKey(b.token, b.confirmation.confirmationVersion, opts.tenantId ?? 'default')
  const active: AiJobStatus[] = ['queued', 'processing', 'retrying']
  if (!opts.force && b.finalAiJob && b.finalAiJob.idempotencyKey === key
    && (active.includes(b.finalAiJob.status) || b.finalAiJob.status === 'completed' || b.finalAiJob.status === 'manual_review')) {
    return false
  }
  b.finalAiJob = {
    status: 'queued', idempotencyKey: key, photoVersion: b.invoicePhotos?.length ?? 0,
    attempts: b.finalAiJob && b.finalAiJob.idempotencyKey === key ? b.finalAiJob.attempts : 0,
    nextRetryAt: now(), initiatedBy: opts.initiatedBy ?? 'system', updatedAt: now(),
  }
  pushBookingEvent(b, {
    actor: opts.initiatedBy ?? 'system', action: 'ai.final_queued', result: 'queued',
    meta: { confirmationVersion: b.confirmation.confirmationVersion },
  })
  return true
}

/** A final job the cron may pick up now (queued/retrying past its backoff). */
export function isFinalDue(b: Booking, at = now()): boolean {
  const j = b.finalAiJob
  if (!j || b.archived || b.isTest || !b.confirmation) return false
  if (j.status !== 'queued' && j.status !== 'retrying') return false
  return (j.nextRetryAt ?? 0) <= at
}

/** A completed final estimate is already attached for the current confirmation version. */
export function hasFinalEstimate(b: Booking): boolean {
  return !!b.finalAiEstimate && !!b.confirmation
    && b.finalAiEstimate.confirmationVersion === b.confirmation.confirmationVersion
}

export type ProcessFinalResult = {
  ok: boolean
  status: AiJobStatus
  finalDecision?: string
  tier?: string
  reason?: string
}

/**
 * Run one attempt of the durable FINAL-analysis job. Leased per booking so the
 * inline (submit) runner and the cron runner can never double-execute the same
 * job; a missed lease returns the current state and the cron retries later.
 */
export async function processFinalAiJob(
  token: string,
  opts: { initiatedBy?: string; tenantId?: string; lockHeld?: boolean } = {},
): Promise<ProcessFinalResult> {
  return withBookingWriteLock(
    token,
    () => processFinalAiJobInner(token, opts),
    { onBusy: () => ({ ok: false, status: 'processing', reason: 'locked' }), ttlMs: 90_000, lockHeld: opts.lockHeld },
  )
}

// The unleased body — persists "processing" before the pricing call, attaches the
// final estimate on success, advances by the routing decision, or schedules a
// bounded retry on error. Idempotent (hasFinalEstimate guard).
async function processFinalAiJobInner(
  token: string,
  opts: { initiatedBy?: string; tenantId?: string; lockHeld?: boolean } = {},
): Promise<ProcessFinalResult> {
  const b = await getBookingByToken(token)
  if (!b) return { ok: false, status: 'failed', reason: 'not_found' }
  if (!b.confirmation) return { ok: false, status: 'failed', reason: 'no_confirmation' }

  // Idempotency: a final estimate for this exact confirmation version already landed.
  if (hasFinalEstimate(b)) {
    const decision = b.finalAiEstimate!.finalDecision
    b.finalAiJob = completeFinalJob(b, decision === 'manual_review' ? 'manual_review' : 'completed', opts.initiatedBy)
    await saveBooking(b)
    return { ok: true, status: b.finalAiJob.status, finalDecision: decision, tier: b.finalAiEstimate!.routingTier }
  }

  const prior = b.finalAiJob
  const attempts = (prior?.attempts ?? 0) + 1
  const idempotencyKey = prior?.idempotencyKey ?? finalJobIdempotencyKey(b.token, b.confirmation.confirmationVersion, opts.tenantId ?? 'default')

  // Persist "processing" BEFORE the slow call so a crash leaves a durable record.
  b.finalAiJob = {
    status: 'processing', idempotencyKey, photoVersion: b.invoicePhotos?.length ?? 0, attempts,
    lastAttemptAt: now(), initiatedBy: opts.initiatedBy ?? prior?.initiatedBy ?? 'system', updatedAt: now(),
  }
  await saveBooking(b)

  let result
  try {
    result = await buildConfirmedPhotoEstimate({
      initial: b.aiEstimate?.analysis,
      confirmation: b.confirmation,
      serviceType: b.serviceType,
      analysisId: `final-${b.token}-${b.confirmation.confirmationVersion}-${attempts}`,
      bookingId: b.token,
    })
  } catch (e) {
    const summary = e instanceof Error ? e.message.slice(0, 200) : 'final analysis error'
    b.finalAiJob = scheduleFinalRetryOrFail(b, attempts, idempotencyKey, 'provider_unavailable', summary, opts.initiatedBy)
    await saveBooking(b)
    return { ok: false, status: b.finalAiJob.status, reason: 'exception' }
  }

  // Attach the final estimate (never overwrites `aiEstimate`) + advance by routing.
  b.finalAiEstimate = result
  b.disposalEstimateCents = result.disposalUsd * 100
  // Manual-review AND site-visit both require a human before any quote — the durable
  // job parks at 'manual_review'; the finalDecision retains the precise outcome.
  const needsHuman = result.finalDecision === 'manual_review' || result.finalDecision === 'site_visit_required'
  const status: AiJobStatus = needsHuman ? 'manual_review' : 'completed'
  b.finalAiJob = {
    status, idempotencyKey, photoVersion: b.invoicePhotos?.length ?? 0, attempts,
    lastAttemptAt: now(), completedAt: now(),
    provider: result.mergedAnalysis.modelProvider, model: result.mergedAnalysis.modelName,
    initiatedBy: opts.initiatedBy ?? b.finalAiJob.initiatedBy, updatedAt: now(),
  }
  pushBookingEvent(b, {
    actor: opts.initiatedBy ?? 'system',
    action: status === 'manual_review' ? 'ai.final_manual_review' : 'ai.final_analyzed',
    result: `final:${result.finalDecision}`,
    meta: {
      tier: result.routingTier, recommendedUsd: result.pricing.recommendedUsd,
      confirmationVersion: result.confirmationVersion, conflicts: result.conflicts.length, attempts,
    },
  })
  await saveBooking(b)
  return { ok: true, status, finalDecision: result.finalDecision, tier: result.routingTier }
}

function completeFinalJob(b: Booking, status: AiJobStatus, initiatedBy?: string): AiJob {
  const prior = b.finalAiJob
  return {
    status, idempotencyKey: prior?.idempotencyKey ?? finalJobIdempotencyKey(b.token, b.confirmation?.confirmationVersion ?? 1),
    photoVersion: b.invoicePhotos?.length ?? 0, attempts: prior?.attempts ?? 1,
    completedAt: now(), initiatedBy: initiatedBy ?? prior?.initiatedBy ?? 'system', updatedAt: now(),
  }
}

function scheduleFinalRetryOrFail(
  b: Booking, attempts: number, idempotencyKey: string, code: AiJobErrorCode, summary: string, initiatedBy?: string,
): AiJob {
  if (attempts >= MAX_FINAL_ATTEMPTS) {
    pushBookingEvent(b, { actor: initiatedBy ?? 'system', action: 'ai.final_failed', result: 'retry_exhausted', meta: { attempts } })
    return {
      status: 'failed', idempotencyKey, photoVersion: b.invoicePhotos?.length ?? 0, attempts,
      lastAttemptAt: now(), errorCode: 'retry_exhausted', errorSummary: summary,
      initiatedBy: initiatedBy ?? 'system', updatedAt: now(),
    }
  }
  return {
    status: 'retrying', idempotencyKey, photoVersion: b.invoicePhotos?.length ?? 0, attempts,
    lastAttemptAt: now(), nextRetryAt: now() + backoffMs(attempts),
    errorCode: code, errorSummary: summary, initiatedBy: initiatedBy ?? 'system', updatedAt: now(),
  }
}

/** Cron entry point: process all due FINAL jobs (bounded). */
export async function runDueFinalAiJobs(limit = 10): Promise<{ processed: number; results: { token: string; status: AiJobStatus }[] }> {
  const all = await listBookings(500)
  const due = all.filter(b => isFinalDue(b)).slice(0, limit)
  const results: { token: string; status: AiJobStatus }[] = []
  for (const b of due) {
    const r = await processFinalAiJob(b.token, { initiatedBy: 'cron' })
    results.push({ token: b.token, status: r.status })
  }
  return { processed: due.length, results }
}

/** True when a booking is at the "awaiting customer confirmation" stage (Part 11). */
export function awaitingConfirmation(b: Booking): boolean {
  if (b.confirmation) return false
  if (!supportsPhotoAi(b)) return false
  // The first analysis produced a read (priced OR manual_review) and no confirmation yet.
  const firstDone = b.aiJob?.status === 'completed' || b.aiJob?.status === 'manual_review' || !!b.aiEstimate
  return firstDone
}
