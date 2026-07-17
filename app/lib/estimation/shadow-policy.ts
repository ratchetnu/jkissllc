// ── V2 Shadow subsystem — PURE policy (eligibility, due-ness, retry, deadlines) ──
//
// No I/O, no Date.now, no randomness — every function takes its inputs explicitly so
// the whole policy is hermetically testable. The worker/store call these; they never
// reach into Redis or the clock themselves.

import type { V2ShadowJob, V2ShadowStatus, V2ShadowFailure } from './shadow-types'
import { SHADOW_ACTIVE, SHADOW_TRANSIENT, V2_SHADOW_JOB_VERSION } from './shadow-types'

// ── Versioning / identity ────────────────────────────────────────────────────
export const V2_ESTIMATOR_VERSION = 2 // the shadow estimator generation (ANALYSIS_V2)

/** Idempotency key — one shadow attempt-set per booking + estimator + photo set. */
export function shadowIdempotencyKey(bookingId: string, estimatorVersion: number, photoVersion: number): string {
  return `vision-shadow:${bookingId}:v${estimatorVersion}:p${photoVersion}`
}

export function shadowJobId(bookingId: string, photoVersion: number, estimatorVersion: number): string {
  return `vs_${bookingId}_v${estimatorVersion}_p${photoVersion}`
}

// ── Tunable budgets (env-overridable; must stay below the cron maxDuration=300s) ──
export const DEFAULT_SHADOW_DEADLINE_MS = 210_000       // per-job graceful deadline (3.5m)
export const DEFAULT_SHADOW_LEASE_MS = 8 * 60_000       // stale-processing reaper (>> maxDuration)
export const SHADOW_FUNCTION_BUDGET_MS = 285_000        // never start a job past this in one cron run
// One retry only: a transient failure gets exactly one more shot, and a permanent one
// (billing/auth/schema/unsupported) gets zero. Was 3 — which meant up to ~6 gateway calls
// on a billing failure that could never succeed.
export const DEFAULT_SHADOW_MAX_ATTEMPTS = 2
// Shadow is not urgent — back off generously so retries never crowd real work.
const SHADOW_BACKOFF_MS = [5 * 60_000, 20 * 60_000]     // 5m, 20m (last value repeats)

function numEnv(raw: string | undefined, dflt: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : dflt
}
export function shadowDeadlineMs(env: Record<string, string | undefined> = process.env): number {
  return numEnv(env.VISION_SHADOW_DEADLINE_MS, DEFAULT_SHADOW_DEADLINE_MS)
}
export function shadowLeaseMs(env: Record<string, string | undefined> = process.env): number {
  return numEnv(env.VISION_SHADOW_LEASE_MS, DEFAULT_SHADOW_LEASE_MS)
}
export function shadowMaxAttempts(env: Record<string, string | undefined> = process.env): number {
  return numEnv(env.VISION_SHADOW_MAX_ATTEMPTS, DEFAULT_SHADOW_MAX_ATTEMPTS)
}

// ── Eligibility (Phase 5) ────────────────────────────────────────────────────
export type ShadowFlags = {
  queueEnabled: boolean
  autoEnqueue: boolean
  selectedOnly: boolean
}

export type ShadowEligibilityInput = {
  bookingId: string
  idempotencyKey: string
  photoCount: number
  isTest?: boolean
  cancelled?: boolean            // booking archived/cancelled
  authoritativeTerminal?: boolean // authoritative aiJob reached completed/manual_review
  excluded?: boolean             // owner opt-out
  selected?: boolean             // owner-selected (for selected-only mode)
  minPhotos?: number             // configurable eligibility control (default 1)
  existingJob?: Pick<V2ShadowJob, 'status' | 'idempotencyKey'> | null
  manualEnqueue?: boolean         // owner clicked "Queue V2" — bypasses auto/selected gating (still respects hard blocks)
}

export type ShadowEligibility = { eligible: boolean; reason: string }

/**
 * Decide whether a booking may be shadow-analyzed RIGHT NOW. Hard blocks (queue off,
 * no photos, not terminal, cancelled, excluded, duplicate) always apply — even for a
 * manual owner enqueue. Mode gating (auto vs selected-only) is bypassed by manualEnqueue.
 */
export function evaluateShadowEligibility(input: ShadowEligibilityInput, flags: ShadowFlags): ShadowEligibility {
  if (!flags.queueEnabled) return { eligible: false, reason: 'queue_disabled' }
  if (!input.authoritativeTerminal) return { eligible: false, reason: 'authoritative_not_terminal' }
  if (input.cancelled) return { eligible: false, reason: 'cancelled' }
  if (input.excluded) return { eligible: false, reason: 'excluded' }
  const minPhotos = input.minPhotos ?? 1
  if ((input.photoCount ?? 0) < minPhotos) return { eligible: false, reason: 'no_usable_photos' }

  // Duplicate prevention: an active OR already-completed job for the SAME idempotency
  // key means this exact estimator+photo-set was (or is being) analyzed — skip.
  const j = input.existingJob
  if (j && j.idempotencyKey === input.idempotencyKey) {
    if (SHADOW_ACTIVE.includes(j.status) || j.status === 'completed' || j.status === 'manual_review') {
      return { eligible: false, reason: 'already_queued_or_done' }
    }
  }

  // Mode gating — only when NOT a manual owner enqueue.
  if (!input.manualEnqueue) {
    if (!flags.autoEnqueue) {
      // selected-only is the safe default: nothing auto-runs unless explicitly selected.
      if (flags.selectedOnly && !input.selected) return { eligible: false, reason: 'not_selected' }
      if (!flags.selectedOnly && !input.selected) return { eligible: false, reason: 'auto_enqueue_disabled' }
    }
  }
  return { eligible: true, reason: 'eligible' }
}

// ── Due-ness (independent of the authoritative isDue) ────────────────────────
/** True when a shadow job should be picked up now: queued/retrying past backoff, or a
 *  stale 'processing' job whose lease has expired (crashed/hard-killed mid-run). */
export function isShadowDue(job: V2ShadowJob, at: number, leaseMs: number): boolean {
  if (job.status === 'queued' || job.status === 'retrying') return (job.nextRetryAt ?? 0) <= at
  if (job.status === 'processing') return isShadowStale(job, at, leaseMs)
  return false
}

/** A 'processing' shadow job is stale if it entered processing (startedAt/heartbeatAt)
 *  longer ago than the lease — i.e. the worker crashed or was hard-killed. */
export function isShadowStale(job: V2ShadowJob, at: number, leaseMs: number): boolean {
  if (job.status !== 'processing') return false
  const since = job.heartbeatAt ?? job.startedAt ?? job.updatedAt ?? 0
  return at - since > leaseMs
}

// ── Retry / failure classification (Phase 7) ─────────────────────────────────
export function shadowBackoffMs(attempt: number): number {
  const i = Math.max(0, attempt - 1)
  return SHADOW_BACKOFF_MS[Math.min(i, SHADOW_BACKOFF_MS.length - 1)]
}

export type ShadowRetryDecision =
  | { terminal: true; status: Extract<V2ShadowStatus, 'failed' | 'manual_review'> }
  | { terminal: false; status: 'retrying'; delayMs: number }

/**
 * Given the attempt count and failure category, decide retry vs terminal. Only
 * transient failures retry, and only up to maxAttempts. `deadline` is treated as a
 * soft outcome → manual_review (owner-priced), never an infinite retry.
 */
export function shadowRetryDecision(attempts: number, failure: V2ShadowFailure, maxAttempts: number): ShadowRetryDecision {
  if (failure === 'deadline') return { terminal: true, status: 'manual_review' }
  if (failure === 'cancelled') return { terminal: true, status: 'failed' }
  const transient = SHADOW_TRANSIENT.includes(failure)
  if (!transient || attempts >= maxAttempts) return { terminal: true, status: 'failed' }
  return { terminal: false, status: 'retrying', delayMs: shadowBackoffMs(attempts) }
}

/** Map an analyzePhotosV2 outcome / thrown error into the shadow failure taxonomy. */
export function classifyShadowFailure(outcome: string | undefined, errorClass?: string): V2ShadowFailure {
  // errorClass wins when present: a `provider_error` outcome can be a transient blip OR a
  // permanent billing/auth rejection, and only errorClass distinguishes them. Retrying a
  // billing failure is pure wasted spend.
  if (errorClass === 'billing' || errorClass === 'budget') return 'provider_billing'
  if (errorClass === 'auth') return 'provider_auth'
  switch (outcome) {
    case 'timeout':
    case 'provider_timeout':
      return 'provider_timeout'
    case 'rate_limited':
    case 'provider_error':
    case 'provider_unavailable':
      return 'provider_unavailable'
    case 'over_budget':
      return 'provider_billing'
    case 'image_fetch':
    case 'image_access':
      return 'image_access'
    case 'unsupported_image':
      return 'unsupported_image'
    case 'no_images':
    case 'no_usable_images':
      return 'no_usable_images'
    case 'invalid_schema':
    case 'invalid_output':
    case 'no_items':
      return 'invalid_output'
    default:
      return 'internal_error'
  }
}

export { V2_SHADOW_JOB_VERSION }
