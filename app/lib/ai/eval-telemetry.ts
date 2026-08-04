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
import type { ServiceType } from '../bookings'

export type EvalJobType = 'junk_removal' | 'moving' | 'other'

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

const KEY = (id: string) => `eval:${id}`
const INDEX = 'eval:index'
const TTL_MS = 7 * 24 * 60 * 60 * 1000     // a benchmark run is analysed within days
const INDEX_CAP = 2000
const ID_RE = /^[a-z0-9-]{8,}$/i

/** Junk removal is the only lane validated so far; moving is explicitly out of scope. */
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
export async function recordEvaluation(rec: EvaluationRecord): Promise<void> {
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

export async function getEvaluation(analysisId: string): Promise<EvaluationRecord | null> {
  if (!ID_RE.test(analysisId)) return null
  try {
    const raw = await redis.get(KEY(analysisId))
    return raw ? JSON.parse(raw) as EvaluationRecord : null
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
