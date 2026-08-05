// ─────────────────────────────────────────────────────────────────────────────
// Evaluation telemetry — the internal record a benchmark needs and the customer
// response deliberately does not carry.
//
// WHY THIS EXISTS. `customerEstimateView` is a customer-safe projection: it
// exposes `estimatedTruckLoads` (a whole-number load count, `max(1, ceil(fraction))`)
// but not `estimatedTruckLoadFraction`, which is the value the pricing engine
// actually consumes. A benchmark reading the public response therefore sees "1
// load" for a single couch and cannot measure volume or truck utilisation at all.
// Deriving them anyway produced numbers wrong by an order of magnitude — see
// tools/vision-benchmark/README.md → Instrumentation gap.
//
// WHAT IT DOES NOT DO. It does not change the response, the quote, the decision,
// or anything a customer sees. It writes one record to KV, keyed by analysisId,
// fire-and-forget. Reading it is a separate Preview-only diagnostic route.
//
// THE JOIN. Provider-side facts — token usage, cost, attempts, retries, provider
// latency — are ALREADY recorded by the AI audit log (`recordAiCall`) under the
// call id. This record carries the ESTIMATE side and the `aiCallId` that links
// them, so the reader joins rather than duplicating a second source of truth
// that could drift from the first.
//
// THREE GATES, all required: never in Production (VERCEL_ENV), the
// AI_EVAL_TELEMETRY_ENABLED flag (OFF everywhere by default), and a valid
// analysis id. Off ⇒ nothing is written and the code path is inert.
// ─────────────────────────────────────────────────────────────────────────────

import { redis } from '../redis'
import { isEnabled } from '../platform/flags'
import type { StoredAiEstimate } from './estimate-store'
import type { StoredMovingEstimate } from './moving-estimate'
import type { ServiceType } from '../bookings'

export type EvalJobType = 'junk_removal' | 'moving' | 'other'

/** Privacy-safe, lane-neutral item data used to calibrate catalog agreement. */
export type CatalogEvaluationItem = {
  itemIndex: number
  catalogId: string | null
  quantity: number
  modelVolumeCubicFeet: number | null
  catalogVolumeCubicFeet: { minimum: number; maximum: number } | null
  catalogAgreement: number | null
}

export type EvaluationRecord = {
  analysisId: string
  at: string
  // ── Inputs ──
  jobType: EvalJobType
  serviceType: string
  debris?: string
  imageCount: number
  // ── Provider ── (the join key; usage/cost/attempts live on the AI call record)
  provider: string
  model: string
  aiCallId?: string
  providerLatencyMs?: number
  outcome: string
  analyzedOk: boolean
  /** Set only when the interactive latency budget cut the read short (PR #155). */
  degraded?: string | null
  // ── What the model saw ──
  detectedItems: Array<{ label: string; category: string; quantity: number; confidence: number }>
  catalogItems: CatalogEvaluationItem[]
  itemCount: number
  estimatedVolumeCubicYards: number
  /** The number the customer response does NOT expose. 0–600 (>100% = multi-load). */
  truckUtilizationPct: number
  estimatedTruckLoads: number
  // ── Confidence inputs (all five sub-scores, not just `overall`) ──
  confidence: {
    overall: number; volume: number; weight: number
    itemClassification: number; accessDifficulty: number
  }
  // ── QA layers ──
  monitorForceReview: boolean
  monitorConfidencePenalty: number
  monitorConcerns: string[]
  criticInvoked: boolean
  criticRecommend?: string
  criticAgrees?: boolean
  criticAdjustedFraction?: number
  // ── Result ──
  decision: string
  status: string
  recommendedUsd: number
  lowUsd: number
  highUsd: number
  reviewReasons: string[]
}

/**
 * The MOVING lane's evaluation record.
 *
 * A separate type, not extra optional fields on the junk one. A move has no
 * landfill trip, no debris weight and no truck-load COUNT; a junk job has no
 * loading/unloading split and no box count. Folding both into one shape would
 * make every field optional and let a reader average across lanes without
 * noticing — which is the exact mistake the two-lane split exists to prevent.
 * `jobType` discriminates, and the benchmark's scoring specs refuse a mismatch.
 *
 * Token usage, estimated cost, attempts, retries and structured-output validity
 * are DELIBERATELY ABSENT here. They are already recorded by `recordAiCall`
 * against `aiCallId`, and the diagnostics reader joins them. A second copy could
 * drift from the first, and then neither would be trustworthy.
 */
export type MovingEvaluationRecord = {
  analysisId: string
  at: string
  jobType: 'moving'
  serviceType: string
  imageCount: number
  // ── Provider ── (the join key; usage/cost/attempts/retries/validity live there)
  provider: string
  model: string
  aiCallId?: string
  /** The provider round-trip alone. */
  modelLatencyMs?: number
  /** Vision + normalization + pricing + decision, measured by the route. */
  totalLatencyMs?: number
  outcome: string
  analyzedOk: boolean
  // ── What the model saw ──
  detectedItems: Array<{
    label: string; category: string; quantity: number; sizeClass: string
    fragile: boolean; requiresDisassembly: boolean; isAppliance: boolean; confidence: number
  }>
  catalogItems: CatalogEvaluationItem[]
  itemCount: number
  boxCount: { minimum: number; likely: number; maximum: number }
  estimatedVolumeCubicFeet: { minimum: number; likely: number; maximum: number }
  /** Fraction of the configured truck — the value pricing consumes. */
  truckSpaceFraction: { minimum: number; likely: number; maximum: number }
  crewSize: { minimum: number; likely: number; maximum: number }
  loadingHours: { minimum: number; likely: number; maximum: number }
  unloadingHours: { minimum: number; likely: number; maximum: number }
  access: Record<string, boolean>
  missingInformation: string[]
  // ── Confidence: all five moving dimensions, not just `overall` ──
  confidence: {
    overall: number; inventory: number; volume: number; access: number; labor: number
  }
  // ── QA layers ──
  // The moving lane runs NO second vision pass (see moving-analysis.ts: a full
  // re-read would double the cost of every quote to re-count an inventory).
  // Recorded explicitly as false rather than omitted, so a reader can tell "no
  // critic ran" from "this field was never populated".
  criticInvoked: boolean
  criticTrigger: string
  criticLatencyMs: number
  // ── Result ──
  decision: string
  status: string
  priced: boolean
  recommendedUsd: number
  lowUsd: number
  highUsd: number
  reviewReasons: string[]
}

/** Build the moving record. PURE — no clock, no I/O, no env reads. */
export function buildMovingEvaluationRecord(input: {
  stored: StoredMovingEstimate
  serviceType: ServiceType | string
  imageCount: number
  analyzedOk: boolean
  outcome: string
  totalLatencyMs?: number
  at: string
}): MovingEvaluationRecord {
  const { stored, at } = input
  const a = stored.analysis
  return {
    analysisId: stored.id,
    at,
    jobType: 'moving',
    serviceType: String(input.serviceType),
    imageCount: input.imageCount,
    provider: stored.provider,
    model: stored.model,
    aiCallId: stored.callId,
    modelLatencyMs: stored.latencyMs,
    totalLatencyMs: input.totalLatencyMs,
    outcome: input.outcome,
    analyzedOk: input.analyzedOk,
    detectedItems: a.normalizedItems.slice(0, 40).map(i => ({
      label: i.label, category: i.category, quantity: i.quantity.likely, sizeClass: i.sizeClass,
      fragile: i.fragile, requiresDisassembly: i.requiresDisassembly, isAppliance: i.isAppliance,
      confidence: i.confidence,
    })),
    catalogItems: a.normalizedItems.slice(0, 40).map((i, itemIndex) => ({
      itemIndex,
      catalogId: i.catalogId ?? null,
      quantity: i.quantity.likely,
      modelVolumeCubicFeet: i.estimatedVolumeCubicFeet > 0 ? i.estimatedVolumeCubicFeet : null,
      catalogVolumeCubicFeet: i.catalogVolumeCubicFeet ?? null,
      catalogAgreement: i.catalogAgreement ?? null,
    })),
    itemCount: a.normalizedItems.length,
    boxCount: a.boxCount,
    estimatedVolumeCubicFeet: a.totalEstimatedVolumeCubicFeet,
    truckSpaceFraction: a.estimatedTruckSpaceFraction,
    crewSize: a.recommendedCrewSize,
    loadingHours: a.estimatedLoadingHours,
    unloadingHours: a.estimatedUnloadingHours,
    access: { ...a.access },
    // The DECISION's list, not the analysis's. The decision unions what the model
    // could not tell with the non-visual facts the booking never supplied
    // (destination, distance, stairs) — and that union is what actually produced
    // `needs_information`. Recording only the model's half would leave the
    // benchmark unable to explain the decision it is scoring.
    missingInformation: stored.missingInformation.slice(0, 10),
    confidence: {
      overall: a.confidence.overall, inventory: a.confidence.inventory, volume: a.confidence.volume,
      access: a.confidence.access, labor: a.confidence.labor,
    },
    criticInvoked: false,
    criticTrigger: 'none — the moving lane runs no second vision pass',
    criticLatencyMs: 0,
    decision: stored.decision,
    status: stored.status,
    priced: stored.pricing.priced,
    recommendedUsd: stored.pricing.recommendedUsd,
    lowUsd: stored.pricing.lowUsd,
    highUsd: stored.pricing.highUsd,
    reviewReasons: stored.reviewReasons.slice(0, 10),
  }
}

const KEY = (id: string) => `eval:${id}`
const INDEX = 'eval:index'
const TTL_MS = 7 * 24 * 60 * 60 * 1000     // a benchmark run is analysed within days
const INDEX_CAP = 2000
const ID_RE = /^[a-z0-9-]{8,}$/i

/** Map a service type onto a benchmark lane. Both lanes now record telemetry. */
export function evalJobType(serviceType: string): EvalJobType {
  if (serviceType === 'moving') return 'moving'
  if (['junk-removal', 'estate-cleanout', 'garage-cleanout', 'eviction'].includes(serviceType)) return 'junk_removal'
  return 'other'
}

/**
 * Build the record from an estimate. PURE — no clock, no I/O, no env reads — so
 * the shape is unit-testable without Redis or a live analysis.
 */
export function buildEvaluationRecord(input: {
  stored: StoredAiEstimate
  serviceType: ServiceType | string
  debris?: string
  imageCount: number
  analyzedOk: boolean
  outcome: string
  degraded?: string | null
  at: string
}): EvaluationRecord {
  const { stored, at } = input
  const a = stored.analysis
  const fraction = a.estimatedTruckLoadFraction?.likely ?? 0
  return {
    analysisId: stored.id,
    at,
    jobType: evalJobType(String(input.serviceType)),
    serviceType: String(input.serviceType),
    debris: input.debris,
    imageCount: input.imageCount,
    provider: stored.provider,
    model: stored.model,
    aiCallId: stored.callId,
    providerLatencyMs: stored.latencyMs,
    outcome: input.outcome,
    analyzedOk: input.analyzedOk,
    degraded: input.degraded ?? null,
    detectedItems: a.normalizedItems.slice(0, 40).map(i => ({
      label: i.label, category: i.category, quantity: i.estimatedQuantity, confidence: i.confidence,
    })),
    catalogItems: a.normalizedItems.slice(0, 40).map((i, itemIndex) => ({
      itemIndex,
      catalogId: i.catalogId ?? null,
      quantity: i.estimatedQuantity,
      modelVolumeCubicFeet: i.modelVolumeReported === false
        ? null
        : Math.round(i.estimatedVolumeCubicYards * 27 * 1000) / 1000,
      catalogVolumeCubicFeet: i.catalogVolumeCubicFeet ?? null,
      catalogAgreement: i.catalogAgreement ?? null,
    })),
    itemCount: a.normalizedItems.length,
    estimatedVolumeCubicYards: a.totalEstimatedVolumeCubicYards?.likely ?? 0,
    // The whole point: a real percentage, not ceil()'d to a load count.
    truckUtilizationPct: Math.round(fraction * 1000) / 10,
    estimatedTruckLoads: a.estimatedTruckLoads?.likely ?? 0,
    confidence: {
      overall: a.confidence.overall, volume: a.confidence.volume, weight: a.confidence.weight,
      itemClassification: a.confidence.itemClassification, accessDifficulty: a.confidence.accessDifficulty,
    },
    monitorForceReview: stored.monitor?.forceReview ?? false,
    monitorConfidencePenalty: stored.monitor?.confidencePenalty ?? 0,
    monitorConcerns: (stored.monitor?.concerns ?? []).map(c => c.code),
    criticInvoked: !!stored.critic,
    criticRecommend: stored.critic?.recommend,
    criticAgrees: stored.critic?.agrees,
    criticAdjustedFraction: stored.critic?.adjustedTruckLoadFraction,
    decision: stored.decision,
    status: stored.status,
    recommendedUsd: stored.pricing.recommendedUsd,
    lowUsd: stored.pricing.lowUsd,
    highUsd: stored.pricing.highUsd,
    reviewReasons: stored.reviewReasons.slice(0, 10),
  }
}

/** True when evaluation telemetry may be written at all. Never in Production. */
export function evalTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VERCEL_ENV === 'production') return false
  return isEnabled('AI_EVAL_TELEMETRY_ENABLED', env)
}

/**
 * Persist one evaluation record. Fire-and-forget and fail-soft: a telemetry
 * failure must never affect the customer's quote, so every error is swallowed.
 */
export async function recordEvaluation(rec: EvaluationRecord | MovingEvaluationRecord): Promise<void> {
  if (!evalTelemetryEnabled()) return
  if (!ID_RE.test(rec.analysisId)) return
  try {
    await redis.set(KEY(rec.analysisId), JSON.stringify(rec))
    await redis.pexpire(KEY(rec.analysisId), TTL_MS)
    // Capped recency index (ZSET, matching the AI audit log's pattern) so a run
    // can be listed without a key scan. Trimmed oldest-first past the cap.
    await redis.zadd(INDEX, Date.parse(rec.at) || 0, rec.analysisId)
    const n = await redis.zcard(INDEX)
    if (n > INDEX_CAP + 100) {
      const stale = await redis.zrange(INDEX, 0, n - INDEX_CAP - 1)
      await Promise.all(stale.map(id => Promise.all([redis.del(KEY(id)), redis.zrem(INDEX, id)])))
    }
  } catch (e) {
    console.error('[eval-telemetry] record', e)
  }
}

export async function getEvaluation(analysisId: string): Promise<EvaluationRecord | MovingEvaluationRecord | null> {
  if (!ID_RE.test(analysisId)) return null
  try {
    const raw = await redis.get(KEY(analysisId))
    return raw ? JSON.parse(raw) as EvaluationRecord | MovingEvaluationRecord : null
  } catch { return null }
}

/** Most-recent-last analysis ids from the index. */
export async function listEvaluationIds(limit = 100): Promise<string[]> {
  try {
    const n = await redis.zcard(INDEX)
    const take = Math.max(0, Math.min(limit, INDEX_CAP))
    const ids = await redis.zrange(INDEX, Math.max(0, n - take), n - 1)
    return Array.isArray(ids) ? ids : []
  } catch { return [] }
}
