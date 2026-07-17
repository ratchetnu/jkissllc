// ── Independent V2 Shadow subsystem — shared contract ────────────────────────
//
// Vision Estimation V2 runs as a SHADOW: it re-analyzes a booking's photos AFTER
// the authoritative estimator has already reached a terminal state, in a completely
// separate queue + worker + cron, and NEVER touches the customer's estimate, price,
// booking status, or communications. This module is the typed contract shared by the
// store, policy, worker, comparison, admin, and tests.
//
// The shadow job state is deliberately SEPARATE from the authoritative `aiJob`
// (app/lib/bookings.ts) — a distinct status enum, distinct record, distinct Redis key
// family (`shadow:*`) — so a shadow job can never appear as the booking's AI status and
// can never race the authoritative worker on the booking blob's version counter.
//
// Types only — pure, dependency-light (it may import V2 result/clarification types).

import type { EstimationResultV2 } from './v2-bridge'
import type { ClarificationV2 } from './clarify-v2'

export const V2_SHADOW_JOB_VERSION = 1

// Distinct from AiJobStatus. `not_eligible`/`skipped` are terminal non-runs; `cancelled`
// is owner-initiated; the rest mirror a normal job lifecycle but for the shadow only.
export type V2ShadowStatus =
  | 'not_eligible'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'manual_review'
  | 'retrying'
  | 'failed'
  | 'cancelled'
  | 'skipped'

/** Active (occupies a slot / is due-scannable) vs terminal. */
export const SHADOW_ACTIVE: V2ShadowStatus[] = ['queued', 'processing', 'retrying']
export const SHADOW_TERMINAL: V2ShadowStatus[] = ['completed', 'manual_review', 'failed', 'cancelled', 'skipped', 'not_eligible']

// Failure taxonomy — kept separate from the authoritative AiJobErrorCode.
export type V2ShadowFailure =
  | 'provider_timeout'
  | 'provider_unavailable'
  | 'invalid_output'
  | 'image_access'
  | 'unsupported_image'
  | 'no_usable_images'
  | 'deadline'
  | 'cancelled'
  | 'internal_error'

/** Transient failures may retry (bounded); everything else is terminal. */
export const SHADOW_TRANSIENT: V2ShadowFailure[] = ['provider_timeout', 'provider_unavailable', 'image_access']

// How the shadow job was created (owner vs the automatic post-terminal enqueue).
export type V2ShadowCreatedBy = 'auto' | 'owner' | 'system'

/** Where the owner's benchmark number came from. Provenance matters: a completed job price
 *  is stronger evidence than a quote the customer never accepted, and a test benchmark is not
 *  real-world evidence at all. Recorded so a promotion decision can be re-judged later. */
export type GroundTruthSource =
  | 'customer_quote'    // what was quoted to the customer
  | 'owner_adjusted'    // the owner's corrected number
  | 'completed_job'     // the final invoiced price — the strongest evidence
  | 'test_benchmark'    // an internal fixture, NOT real-world evidence

export const GROUND_TRUTH_SOURCES: readonly GroundTruthSource[] = [
  'customer_quote', 'owner_adjusted', 'completed_job', 'test_benchmark',
] as const

export const isGroundTruthSource = (v: unknown): v is GroundTruthSource =>
  typeof v === 'string' && (GROUND_TRUTH_SOURCES as readonly string[]).includes(v)

/** Owner-confirmed reality — the ONLY ground truth. Neither estimator is ground truth. */
export type V2GroundTruth = {
  source?: GroundTruthSource
  confirmedItems?: string          // free text or short list the owner confirms
  confirmedQuantities?: string
  duplicateSightings?: number
  correctLoadTier?: string
  actualTruckPct?: number          // 0..100
  actualQuoteUsd?: number          // what the owner actually quoted
  actualFinalUsd?: number          // final invoiced price
  expectedSurchargeUsd?: number
  expectedManualReview?: boolean
  notes?: string
  reviewedBy?: string
  reviewedAt?: number
}

// Owner-facing verdict of the shadow vs authoritative (+ ground truth when present).
export type V2ComparisonOutcome =
  | 'better_than_authoritative'
  | 'equivalent'
  | 'worse'
  | 'inconclusive'
  | 'needs_ground_truth'

/** Deterministic comparison of the shadow result against the authoritative estimate. */
export type V2Comparison = {
  comparisonVersion: number
  // authoritative baseline (as it presents today)
  authoritativeRecommendedUsd?: number
  authoritativeDecision?: string
  // shadow
  shadowRecommendedUsd: number
  shadowDecision: string
  shadowLoadTier?: string          // human label, e.g. "3/8 load"
  shadowLoadTierKey?: string       // stable key, e.g. "three_eighths"
  shadowTruckPct?: number
  shadowConfidenceBand?: string    // high | medium | low
  shadowManualReview: boolean
  shadowInventoryCount: number
  // deltas (shadow − authoritative)
  quoteDeltaUsd?: number
  quoteDeltaPct?: number | null
  manualReviewDiffers?: boolean
  // vs owner ground truth (only when captured)
  vsGroundTruthQuoteDeltaUsd?: number | null
  vsGroundTruthTierMatches?: boolean | null
  outcome: V2ComparisonOutcome
  outcomeReasons: string[]
}

/** The stored V2 shadow output (the estimate + clarification questions the model made). */
export type V2ShadowOverrideRecord = { overriddenUsd: number; reason: string; by: string; at: string }

export type V2ShadowResult = {
  estimate: EstimationResultV2
  questions: ClarificationV2[]
  ok: boolean
  model?: string
  provider?: string
  analysisVersion?: number
  promptVersion?: number
  // Owner correction of the shadow quote (audited). Shadow-only — never a customer price.
  override?: V2ShadowOverrideRecord
}

/**
 * The durable, INDEPENDENT shadow job record. Stored at `shadow:job:{bookingId}` —
 * never inside the booking blob. Its `status` is a V2ShadowStatus and must never be
 * surfaced as the booking's authoritative AI status.
 */
export type V2ShadowJob = {
  jobVersion: number
  bookingId: string
  bookingNumber?: string
  shadowJobId: string
  status: V2ShadowStatus
  idempotencyKey: string            // {bookingId}:{estimatorVersion}:{photoVersion}
  estimatorVersion: number
  promptVersion?: number
  model?: string
  provider?: string
  imageCount: number
  attempts: number
  createdBy: V2ShadowCreatedBy
  // lifecycle timestamps
  queuedAt?: number
  startedAt?: number
  heartbeatAt?: number
  completedAt?: number
  nextRetryAt?: number
  updatedAt: number
  // execution telemetry
  latencyMs?: number
  providerUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  estimatedCostUsd?: number
  traceId?: string
  providerRequestId?: string
  // failure / cancellation
  timeoutCategory?: 'deadline' | 'provider_timeout'
  failureCategory?: V2ShadowFailure
  failureSummary?: string
  cancellationReason?: string
  // outputs (shadow-only; NEVER customer-facing)
  result?: V2ShadowResult
  comparison?: V2Comparison
  groundTruth?: V2GroundTruth
  reviewedAt?: number
  reviewedBy?: string
  skippedReason?: string
  // ── Owner evaluation workspace (Increment 3) — classification + notes + assignment.
  // Owner-only, audited; shadow-only diagnostics, never a customer price. All optional so
  // existing stored jobs stay valid (no migration).
  classification?: ShadowClassification
  classifiedBy?: string
  classifiedAt?: number
  assignee?: string
  ownerNotes?: { note: string; by: string; at: number }[]
}

/** How the owner classified a shadow disagreement/evaluation (evidence for model promotion). */
export type ShadowClassification =
  | 'false_positive'        // V2 was wrong to flag/escalate
  | 'false_negative'        // V2 wrongly auto-quoted where a human was needed
  | 'needs_investigation'
  | 'expected_difference'   // the V1/V2 gap is understood + acceptable
  | 'accepted_v2'           // V2's read is the better one
  | 'ignored'

/** A booking is excluded from shadow analysis (owner opt-out); stored separately. */
export type V2ShadowExclusion = { bookingId: string; reason?: string; by?: string; at: number }
