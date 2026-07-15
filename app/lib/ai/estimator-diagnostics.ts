// ─────────────────────────────────────────────────────────────────────────────
// estimator-diagnostics — owner-safe operational diagnostics for the V2 vision
// photo-estimation pipeline (Phase 15 observability).
//
// This is a PURE aggregator: it takes a snapshot of bookings + the AI audit log
// (both already loaded by the route) and rolls them into a single operational
// health object. It never calls a model, never touches Redis, never mutates its
// inputs, and takes `now` as a parameter (no Date.now / random) so it is fully
// deterministic and unit-testable.
//
// OWNER-SAFE BY CONSTRUCTION: the output is counts, rates, model identifiers, and
// prompt-version numbers ONLY. It deliberately carries NO raw error strings, NO
// stack traces, NO secrets, and NO image/blob URLs — nothing that could leak PII
// or an internal failure to a customer surface. This mirrors the "all persisted
// error text is safe" rule the AI-job pipeline already follows.
//
// DATA-HONEST: metrics that depend on data we weren't given return `null` (not a
// fabricated 0). Job-derived counts come from `Booking.aiJob`; AI-call telemetry
// (latency, cost, provider/schema failures, prompt versions) comes from the passed
// `aiCalls`. When `aiCalls` is omitted entirely, every telemetry-only metric is
// null; when it is provided-but-empty, counts we can prove are zero stay 0 while
// averages (which have nothing to average) stay null.
// ─────────────────────────────────────────────────────────────────────────────

import type { Booking, AiJobStatus } from '../bookings'
import type { AiCallRecord } from './telemetry'

// The confidence band the deterministic engine assigns to a shadow estimate.
// Mirrors the shared ConfidenceBand union (analysis-schema-v2 / confidence.ts);
// kept local so this observability module stays free of estimation-engine imports.
type ConfidenceBand = 'high' | 'medium' | 'low'

// The AI feature id every photo-estimation vision call is recorded under
// (analysis-v2.ts + junk-analysis.ts both use taskId/feature 'ops.junkAnalysis').
export const ESTIMATOR_AI_FEATURE = 'ops.junkAnalysis'

// A job counts as "stuck" when it has sat in an active (non-terminal) state longer
// than this. Deliberately >> the 5-min processing lease and the 1-hour max backoff
// so a healthy in-flight/retrying job is never flagged. Overridable per call.
export const DEFAULT_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000 // 2h

// AI-job states that are not terminal — a job sitting here too long is stuck.
const ACTIVE_JOB_STATES: AiJobStatus[] = ['queued', 'processing', 'retrying']

// AI-job error codes that indicate the image itself could not be read/converted
// (e.g. a still-HEIC upload the provider can't decode, or a fetch that failed).
const IMAGE_FAILURE_CODES = new Set(['unsupported_image', 'image_access_failed'])

export type EstimatorDiagnosticsOpts = {
  now: number               // caller supplies the clock (keeps this pure)
  windowHours?: number      // only consider activity within this trailing window; omit = all
  staleThresholdMs?: number // override the stuck-job threshold
}

export type EstimatorDiagnostics = {
  generatedAt: number
  windowHours: number | null      // null = no window filter applied (all records)
  staleThresholdMs: number
  // sample sizes the snapshot was computed over (transparency, not a metric)
  bookingsConsidered: number
  aiCallsConsidered: number | null // null when no telemetry was provided

  // ── Job stats (from Booking.aiJob) ──
  jobsCreated: number
  jobsCompleted: number
  jobsFailed: number
  jobsStuck: number
  jobsManualReview: number
  retries: number                  // sum of retry attempts beyond the first, across jobs
  noPhotoJobs: number              // jobs enqueued with zero photos
  imageConversionFailures: number  // HEIC-still / unreadable-image jobs (detectable)

  // ── AI-call telemetry (from aiCalls; null when telemetry absent) ──
  avgAnalysisDurationMs: number | null
  costPerAnalysisUsd: number | null
  providerFailures: number | null       // outcome 'provider_error'
  schemaValidationFailures: number | null // outcome 'invalid_response'

  // ── Shadow-quality (from v2Shadow; null when the shadow flag never ran) ──
  lowConfidenceRate: number | null      // share of v2 shadow estimates banded 'low'

  // ── Versions in use ──
  modelVersions: string[]               // distinct models seen (jobs + telemetry)
  promptVersions: number[] | null       // distinct prompt versions (telemetry only)
}

// v2Shadow is attached additively onto the booking by book-now-ai.ts when the
// VISION_ESTIMATION_SHADOW flag is on. Read it defensively via a narrow view.
type ShadowView = {
  v2Shadow?: { estimate?: { v2?: { confidence?: { band?: ConfidenceBand } } } }
}

function round6(n: number): number { return Math.round(n * 1_000_000) / 1_000_000 }
function round4(n: number): number { return Math.round(n * 10_000) / 10_000 }

// Best available "last activity" timestamp for a job — used for window inclusion
// and stuck-age. AiJob always carries updatedAt; lastAttemptAt is more precise for
// in-flight work.
function jobActivityAt(j: NonNullable<Booking['aiJob']>): number {
  return j.lastAttemptAt ?? j.updatedAt ?? 0
}

function isHeicPhoto(p: { url?: string; name?: string }): boolean {
  const s = `${p.url ?? ''} ${p.name ?? ''}`.toLowerCase()
  return s.includes('.heic') || s.includes('.heif')
}

/**
 * Pure operational-diagnostics aggregator for the V2 photo estimator.
 *
 * @param bookings snapshot of bookings (from listBookings)
 * @param aiCalls  the AI audit log (from listAiCalls); omit/undefined => telemetry
 *                 metrics resolve to null rather than a fabricated 0
 * @param opts     { now, windowHours?, staleThresholdMs? } — clock + window
 */
export function computeEstimatorDiagnostics(
  bookings: Booking[],
  aiCalls: AiCallRecord[] | undefined,
  opts: EstimatorDiagnosticsOpts,
): EstimatorDiagnostics {
  const now = opts.now
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS
  const windowHours = opts.windowHours ?? null
  const windowStart = windowHours != null ? now - windowHours * 60 * 60 * 1000 : null
  const inWindow = (at: number): boolean => windowStart == null || at >= windowStart

  const modelVersions = new Set<string>()

  // ── Job-derived stats (from Booking.aiJob) ──────────────────────────────────
  let jobsCreated = 0
  let jobsCompleted = 0
  let jobsFailed = 0
  let jobsStuck = 0
  let jobsManualReview = 0
  let retries = 0
  let noPhotoJobs = 0
  let imageConversionFailures = 0

  // Shadow-quality accumulators (only counted when a v2Shadow is present).
  let shadowTotal = 0
  let shadowLow = 0

  for (const b of bookings) {
    const j = b.aiJob
    if (!j) continue
    if (!inWindow(jobActivityAt(j))) continue

    jobsCreated++
    if (j.model) modelVersions.add(j.model)

    switch (j.status) {
      case 'completed': jobsCompleted++; break
      case 'failed': jobsFailed++; break
      case 'manual_review': jobsManualReview++; break
      default: break
    }

    // Stuck: active (non-terminal) state older than the stale threshold.
    if (ACTIVE_JOB_STATES.includes(j.status) && now - jobActivityAt(j) > staleThresholdMs) {
      jobsStuck++
    }

    // Retries beyond the first attempt.
    retries += Math.max(0, (j.attempts ?? 0) - 1)

    // No-photo jobs (junk booking queued with zero photos).
    const photos = b.invoicePhotos ?? []
    if (photos.length === 0) noPhotoJobs++

    // Image conversion / read failures — detectable via HEIC-still uploads or the
    // job's own image-failure error code.
    const heic = photos.some(isHeicPhoto)
    if (heic || (j.errorCode != null && IMAGE_FAILURE_CODES.has(j.errorCode))) {
      imageConversionFailures++
    }

    // Shadow-estimate confidence band (only present when the shadow flag ran).
    const band = (b as unknown as ShadowView).v2Shadow?.estimate?.v2?.confidence?.band
    if (band != null) {
      shadowTotal++
      if (band === 'low') shadowLow++
    }
  }

  const lowConfidenceRate = shadowTotal > 0 ? round4(shadowLow / shadowTotal) : null

  // ── AI-call telemetry (from aiCalls) — null when not provided at all ─────────
  let avgAnalysisDurationMs: number | null = null
  let costPerAnalysisUsd: number | null = null
  let providerFailures: number | null = null
  let schemaValidationFailures: number | null = null
  let promptVersions: number[] | null = null
  let aiCallsConsidered: number | null = null

  if (aiCalls) {
    const calls = aiCalls.filter(c => c.feature === ESTIMATOR_AI_FEATURE && inWindow(c.at))
    aiCallsConsidered = calls.length

    // Failures we can prove are zero stay 0 (telemetry was provided).
    providerFailures = calls.filter(c => c.outcome === 'provider_error').length
    schemaValidationFailures = calls.filter(c => c.outcome === 'invalid_response').length

    // Prompt + model versions actually exercised.
    const pv = new Set<number>()
    for (const c of calls) {
      if (c.model) modelVersions.add(c.model)
      if (typeof c.promptVersion === 'number') pv.add(c.promptVersion)
    }
    promptVersions = [...pv].sort((a, b) => a - b)

    // Averages come from successful analyses only, and stay null with nothing to
    // average (never fabricated as 0).
    const durations = calls.filter(c => c.ok && c.latencyMs > 0).map(c => c.latencyMs)
    if (durations.length) {
      avgAnalysisDurationMs = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    }
    const costs = calls.filter(c => c.ok).map(c => c.actualCostUsd ?? c.estCostUsd)
    if (costs.length) {
      costPerAnalysisUsd = round6(costs.reduce((a, b) => a + b, 0) / costs.length)
    }
  }

  return {
    generatedAt: now,
    windowHours,
    staleThresholdMs,
    bookingsConsidered: bookings.length,
    aiCallsConsidered,

    jobsCreated,
    jobsCompleted,
    jobsFailed,
    jobsStuck,
    jobsManualReview,
    retries,
    noPhotoJobs,
    imageConversionFailures,

    avgAnalysisDurationMs,
    costPerAnalysisUsd,
    providerFailures,
    schemaValidationFailures,

    lowConfidenceRate,

    modelVersions: [...modelVersions].sort(),
    promptVersions,
  }
}
