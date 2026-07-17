// ── V2 Shadow — admin action handler (Phases 9/10) ───────────────────────────
//
// Owner-only controls for the independent shadow subsystem. EVERY action here touches
// ONLY the `shadow:*` store — never the booking blob, never authoritative fields,
// never customer comms/pricing. The admin route calls handleShadowAdminAction() as an
// early return so shadow actions never reach the booking write path.

import type { Booking } from '../bookings'
import {
  getShadowJob, saveShadowJob, deleteShadowJob,
  addSelected, removeSelected, addExcluded, removeExcluded,
} from './shadow-store'
import { enqueueShadowJobForBooking } from './shadow-worker'
import { buildV2Comparison } from './shadow-comparison'
import {
  correctItemQuantity, markDuplicate, setLoadTier, setSurcharge, buildV2Override,
} from './v2-corrections'
import type { V2ShadowJob, V2GroundTruth } from './shadow-types'
import { isGroundTruthSource } from './shadow-types'
import { isLearningCategory, LEARNING_CATEGORIES } from './shadow-learning'

export const SHADOW_ADMIN_ACTIONS = new Set([
  'shadow-enqueue', 'shadow-rerun', 'shadow-cancel', 'shadow-retry',
  'shadow-exclude', 'shadow-include', 'shadow-select', 'shadow-unselect',
  'shadow-ground-truth', 'shadow-mark-reviewed', 'shadow-categorize', 'shadow-delete',
  'v2-correct-item', 'v2-mark-duplicate', 'v2-set-tier', 'v2-set-surcharge', 'v2-override',
])

export function isShadowAdminAction(action: string): boolean {
  return SHADOW_ADMIN_ACTIONS.has(action)
}

export type ShadowActionResult = { status: number; body: Record<string, unknown> }

function authoritativeBaseline(b: Booking): { recommendedUsd?: number; decision?: string } {
  const est = b.aiEstimate as { pricing?: { recommendedUsd?: number }; decision?: string } | undefined
  return { recommendedUsd: est?.pricing?.recommendedUsd, decision: est?.decision }
}

const s = (v: unknown, max = 200): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
const n = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined))

/** Recompute the stored comparison after a correction/ground-truth change. */
function refreshComparison(job: V2ShadowJob, b: Booking): void {
  if (job.result?.estimate) {
    job.comparison = buildV2Comparison(job.result.estimate, authoritativeBaseline(b), job.groundTruth)
  }
}

/**
 * Handle one owner shadow action. `role` must be 'admin' (owner). Returns an HTTP-ish
 * status + body for the route to relay. Never throws for expected states.
 */
export async function handleShadowAdminAction(
  action: string,
  b: Booking,
  body: Record<string, unknown>,
  actor: string,
  role: string | undefined,
  now: number,
): Promise<ShadowActionResult> {
  if (role !== 'admin') return { status: 403, body: { error: 'Owner/admin only.' } }
  const bookingId = b.token

  switch (action) {
    case 'shadow-enqueue':
    case 'shadow-rerun': {
      const r = await enqueueShadowJobForBooking(b, { createdBy: 'owner', manualEnqueue: true, force: action === 'shadow-rerun' })
      if (!r.enqueued) return { status: 400, body: { error: `Not enqueued: ${r.reason}`, reason: r.reason } }
      return { status: 200, body: { ok: true, action, shadowJob: r.job } }
    }
    case 'shadow-cancel': {
      const job = await getShadowJob(bookingId)
      if (!job) return { status: 404, body: { error: 'No shadow job.' } }
      if (job.status === 'completed' || job.status === 'manual_review') return { status: 400, body: { error: 'Job already finished.' } }
      job.status = 'cancelled'
      job.cancellationReason = s(body.reason, 240) ?? 'cancelled by owner'
      job.updatedAt = now
      await saveShadowJob(job)
      return { status: 200, body: { ok: true, shadowJob: job } }
    }
    case 'shadow-retry': {
      const job = await getShadowJob(bookingId)
      if (!job) return { status: 404, body: { error: 'No shadow job.' } }
      if (job.status !== 'failed' && job.status !== 'cancelled') return { status: 400, body: { error: 'Only failed/cancelled jobs can be retried.' } }
      job.status = 'retrying'
      job.nextRetryAt = now
      job.failureCategory = undefined
      job.failureSummary = undefined
      job.updatedAt = now
      await saveShadowJob(job)
      return { status: 200, body: { ok: true, shadowJob: job } }
    }
    case 'shadow-exclude': {
      await addExcluded(bookingId, s(body.reason, 240), actor, now)
      const job = await getShadowJob(bookingId)
      if (job && (job.status === 'queued' || job.status === 'retrying' || job.status === 'processing')) {
        job.status = 'cancelled'; job.cancellationReason = 'excluded by owner'; job.updatedAt = now
        await saveShadowJob(job)
      }
      return { status: 200, body: { ok: true, excluded: true } }
    }
    case 'shadow-include': {
      await removeExcluded(bookingId)
      return { status: 200, body: { ok: true, excluded: false } }
    }
    case 'shadow-select': {
      await addSelected(bookingId)
      return { status: 200, body: { ok: true, selected: true } }
    }
    case 'shadow-unselect': {
      await removeSelected(bookingId)
      return { status: 200, body: { ok: true, selected: false } }
    }
    case 'shadow-delete': {
      await deleteShadowJob(bookingId)
      return { status: 200, body: { ok: true, deleted: true } }
    }
    case 'shadow-ground-truth': {
      const job = await getShadowJob(bookingId)
      if (!job) return { status: 404, body: { error: 'No shadow job to attach ground truth to.' } }
      // Merge onto any existing ground truth so a partial edit (e.g. adding the final
      // invoiced price later) cannot silently wipe fields the owner already recorded.
      const prior = job.groundTruth ?? {}
      const gt: V2GroundTruth = {
        ...prior,
        source: isGroundTruthSource(body.source) ? body.source : prior.source,
        confirmedItems: s(body.confirmedItems, 1000) ?? prior.confirmedItems,
        confirmedQuantities: s(body.confirmedQuantities, 1000),
        duplicateSightings: n(body.duplicateSightings),
        correctLoadTier: s(body.correctLoadTier, 60),
        actualTruckPct: n(body.actualTruckPct),
        actualQuoteUsd: n(body.actualQuoteUsd) ?? prior.actualQuoteUsd,
        actualFinalUsd: n(body.actualFinalUsd) ?? prior.actualFinalUsd,
        expectedSurchargeUsd: n(body.expectedSurchargeUsd),
        expectedManualReview: typeof body.expectedManualReview === 'boolean' ? body.expectedManualReview : undefined,
        notes: s(body.notes, 2000) ?? prior.notes,
        reviewedBy: actor,
        reviewedAt: now,
      }
      job.groundTruth = gt
      refreshComparison(job, b)
      job.updatedAt = now
      await saveShadowJob(job)
      return { status: 200, body: { ok: true, shadowJob: job } }
    }
    case 'shadow-mark-reviewed': {
      const job = await getShadowJob(bookingId)
      if (!job) return { status: 404, body: { error: 'No shadow job.' } }
      job.reviewedAt = now
      job.reviewedBy = actor
      job.updatedAt = now
      await saveShadowJob(job)
      return { status: 200, body: { ok: true, shadowJob: job } }
    }
    // AI Learning: owner assigns/clears failure categories on a completed evaluation. Diagnostic
    // metadata over a stored evaluation — no inference, no customer-facing effect.
    case 'shadow-categorize': {
      const job = await getShadowJob(bookingId)
      if (!job) return { status: 404, body: { error: 'No shadow job.' } }
      const raw = Array.isArray(body.categories) ? body.categories : []
      const cats = [...new Set(raw.filter(isLearningCategory))].slice(0, LEARNING_CATEGORIES.length)
      job.learningCategories = cats
      job.learningCategorizedBy = actor
      job.learningCategorizedAt = now
      job.updatedAt = now
      await saveShadowJob(job)
      return { status: 200, body: { ok: true, shadowJob: job } }
    }
    // ── Owner corrections to the shadow estimate (model never re-prices) ───────
    case 'v2-correct-item':
    case 'v2-mark-duplicate':
    case 'v2-set-tier':
    case 'v2-set-surcharge':
    case 'v2-override': {
      const job = await getShadowJob(bookingId)
      if (!job?.result?.estimate) return { status: 400, body: { error: 'No V2 shadow estimate to correct.' } }

      if (action === 'v2-override') {
        const o = buildV2Override(n(body.overriddenUsd) ?? 0, s(body.reason, 500) ?? '', actor, new Date(now).toISOString())
        if (!o.ok || !o.override) return { status: 400, body: { error: o.error ?? 'Override failed.' } }
        job.result.override = { overriddenUsd: o.override.overriddenUsd, reason: o.override.reason, by: actor, at: new Date(now).toISOString() }
        job.updatedAt = now
        refreshComparison(job, b)
        await saveShadowJob(job)
        return { status: 200, body: { ok: true, summary: o.summary, shadowJob: job } }
      }

      const res =
        action === 'v2-correct-item' ? correctItemQuantity(job.result.estimate, s(body.objectId, 40) ?? '', n(body.quantity) ?? 0)
        : action === 'v2-mark-duplicate' ? markDuplicate(job.result.estimate, s(body.objectId, 40) ?? '')
        : action === 'v2-set-tier' ? setLoadTier(job.result.estimate, s(body.tierKey, 40) ?? '')
        : setSurcharge(job.result.estimate, s(body.label, 80) ?? '', Math.round(n(body.cents) ?? 0), body.add !== false)
      if (!res.ok) return { status: 400, body: { error: res.error ?? 'Correction failed.' } }
      job.result.estimate = res.estimate
      job.updatedAt = now
      refreshComparison(job, b)
      await saveShadowJob(job)
      return { status: 200, body: { ok: true, summary: res.summary, shadowJob: job } }
    }
    default:
      return { status: 400, body: { error: 'unknown shadow action' } }
  }
}
