// ─────────────────────────────────────────────────────────────────────────────
// The moving photo-estimating chain, as ONE reusable server-side function:
//   moving vision → moving normalization → deterministic moving pricing → decision.
//
// Structurally parallel to buildPhotoEstimate (the junk chain) and deliberately
// separate from it: different prompt, different schema, different engine. Nothing
// in this path can reach disposal.priceJob, which is the property the whole lane
// exists to guarantee.
// ─────────────────────────────────────────────────────────────────────────────

import { analyzeMovingPhotos } from './moving-analysis'
import { getMovingSettings, type MovingJobFacts } from '../pricing/moving-quote'
import { decideMovingQuote, MOVING_DECISION_VERSION, type MovingDecisionResult } from '../pricing/moving-decision'
import { timeStage } from '../observability/pipeline-trace'
import { SERVICE_LABELS, type ServiceType } from '../bookings'
import type { MovingPhotoAnalysis } from './analysis-schema-moving'
import { durableBudget, type InteractiveBudget, type InteractiveDegradeReason } from './interactive-policy'

export type MovingEstimateInput = {
  analysisId: string
  bookingId: string
  photoUrls: string[]
  serviceType: ServiceType
  facts?: MovingJobFacts
  // Latency policy — the SAME budget object the junk chain threads (see
  // buildPhotoEstimate). Omitted ⇒ durableBudget(), i.e. today's unbounded
  // behaviour, so every non-interactive caller is byte-identical to before.
  budget?: InteractiveBudget
  /** Injectable clock, for deterministic budget tests. Defaults to Date.now. */
  now?: () => number
}

export type StoredMovingEstimate = {
  id: string
  createdAt: string
  lane: 'moving'
  status: 'completed' | 'review' | 'failed'
  decision: MovingDecisionResult['decision']
  provider: string
  model: string
  schemaVersion: number
  callId?: string
  latencyMs?: number
  inputPhotoUrls: string[]
  analysis: MovingPhotoAnalysis
  pricing: {
    recommendedUsd: number
    lowUsd: number
    highUsd: number
    priced: boolean
    decisionVersion: string
    crewSize: number
    laborHours: { minimum: number; likely: number; maximum: number }
    costLines: { label: string; cents: number }[]
    sellingPriceCents: number
    minimumApplied: boolean
  }
  reviewReasons: string[]
  missingInformation: string[]
  /**
   * Interactive-only latency record, mirroring the junk lane's block. Present only
   * for interactive runs so a durable/stored moving estimate is unchanged.
   */
  latency?: {
    mode: 'interactive'
    degraded?: InteractiveDegradeReason
    primaryTimeoutMs: number
    elapsedMs: number
  }
}

/**
 * Dependency-injection seam, mirroring PhotoEstimateDeps on the junk chain. Lets the
 * budget wiring be tested without a provider call or a settings round-trip. Defaults
 * are the real implementations, so production behaviour is unchanged.
 */
export type MovingEstimateDeps = {
  analyze?: typeof analyzeMovingPhotos
  loadSettings?: typeof getMovingSettings
}

export type MovingEstimateResult = {
  stored: StoredMovingEstimate
  analyzedOk: boolean
  /** 'ok' | 'output_truncated' | 'empty_read' | a provider outcome. */
  outcome: string
  model?: string
  callId?: string
  /** Set when the interactive budget cut the analysis short. Never set for durable runs. */
  degraded?: InteractiveDegradeReason
  /** Structured-output diagnostics, for telemetry and the benchmark report. */
  finishReason?: string
  outputTokens?: number
  maxOutputTokens?: number
  outputTruncated?: boolean
  parseSucceeded?: boolean
}

/** A decision carrying the vision read but no price, for when pricing cannot run. */
function unpricedDecision(analysis: MovingPhotoAnalysis): MovingDecisionResult {
  return {
    decision: 'manual_review',
    quote: {
      low: 0, high: 0, recommendedUsd: 0, crewSize: analysis.recommendedCrewSize.likely || 2,
      laborHours: { minimum: 0, likely: 0, maximum: 0 },
      truckSpaceFraction: analysis.estimatedTruckSpaceFraction.likely,
      costBasisCents: 0, sellingPriceCents: 0, minimumApplied: false,
      breakdown: [], assumptions: ['Pricing configuration was unavailable.'],
    },
    reviewReasons: Array.from(new Set([...analysis.reviewReasons, 'Pricing configuration was unavailable — a team member will confirm your price.'])),
    missingInformation: analysis.missingInformation,
    recommendedUsd: 0,
    rangeUsd: { low: 0, high: 0 },
    priced: false,
    decisionVersion: MOVING_DECISION_VERSION,
  }
}

export async function buildMovingEstimate(input: MovingEstimateInput, deps: MovingEstimateDeps = {}): Promise<MovingEstimateResult> {
  const analyze = deps.analyze ?? analyzeMovingPhotos
  const loadSettings = deps.loadSettings ?? getMovingSettings
  const nowIso = new Date().toISOString()
  const serviceLabel = SERVICE_LABELS[input.serviceType] ?? input.serviceType
  const budget = input.budget ?? durableBudget()
  const clock = input.now ?? Date.now
  const interactive = budget.mode === 'interactive'
  const startedAt = clock()

  // This lane has ONE model call and no critic, so it takes the primary slice and
  // nothing else. Reusing `primary()` rather than inventing a second budget shape
  // keeps both lanes on one deadline calculation — the property that makes the
  // route's worst case provable instead of asserted.
  const primary = budget.primary(startedAt)
  const analyzed = await timeStage('ai', () => analyze({
    analysisId: input.analysisId, bookingId: input.bookingId, photoUrls: input.photoUrls, serviceLabel, nowIso,
    timeoutMs: primary.timeoutMs, attempts: primary.attempts,
  }))

  // Did OUR budget end this read, rather than the provider? With a single attempt
  // and a slice we chose, an abort/timeout (errorClass 'network') IS the budget
  // expiring. Recorded as a first-class outcome — never a platform 504.
  const degraded: InteractiveDegradeReason | undefined = !interactive || analyzed.ok
    ? undefined
    : analyzed.errorClass === 'network' ? 'primary_timeout'
      : primary.timeoutMs <= 0 ? 'budget_exhausted'
        : undefined

  // If the rate card cannot be read we do NOT fall back to the default rates: that
  // would quote this tenant's move on numbers they never agreed to, and it would
  // look exactly like a successful quote. An unreadable rate card is a job for a
  // human, and the vision read is kept either way.
  let decision: MovingDecisionResult
  try {
    decision = await timeStage('pricing', async () => {
      const settings = await loadSettings()
      return decideMovingQuote({ analysis: analyzed.analysis, settings, facts: input.facts })
    })
  } catch (e) {
    console.error('[moving-estimate] settings read failed', e)
    decision = unpricedDecision(analyzed.analysis)
  }

  const stored: StoredMovingEstimate = {
    id: input.analysisId,
    createdAt: nowIso,
    lane: 'moving',
    status: analyzed.ok ? (decision.decision === 'manual_review' ? 'review' : 'completed') : 'failed',
    decision: decision.decision,
    provider: analyzed.analysis.modelProvider,
    model: analyzed.model ?? analyzed.analysis.modelName,
    schemaVersion: analyzed.analysis.schemaVersion,
    callId: analyzed.callId,
    latencyMs: analyzed.latencyMs,
    inputPhotoUrls: input.photoUrls,
    analysis: analyzed.analysis,
    pricing: {
      recommendedUsd: decision.recommendedUsd,
      lowUsd: decision.rangeUsd.low,
      highUsd: decision.rangeUsd.high,
      priced: decision.priced,
      decisionVersion: decision.decisionVersion,
      crewSize: decision.quote.crewSize,
      laborHours: decision.quote.laborHours,
      costLines: decision.quote.breakdown,
      sellingPriceCents: decision.quote.sellingPriceCents,
      minimumApplied: decision.quote.minimumApplied,
    },
    reviewReasons: decision.reviewReasons,
    missingInformation: decision.missingInformation,
    ...(interactive
      ? {
        latency: {
          mode: 'interactive' as const,
          ...(degraded ? { degraded } : {}),
          primaryTimeoutMs: primary.timeoutMs,
          elapsedMs: Math.max(0, clock() - startedAt),
        },
      }
      : {}),
  }

  return {
    stored, analyzedOk: analyzed.ok, outcome: analyzed.outcome,
    model: analyzed.model, callId: analyzed.callId, degraded,
    finishReason: analyzed.finishReason, outputTokens: analyzed.outputTokens,
    maxOutputTokens: analyzed.maxOutputTokens, outputTruncated: analyzed.outputTruncated,
    parseSucceeded: analyzed.parseSucceeded,
  }
}

/**
 * Customer-safe projection. Everything the customer needs to understand the
 * estimate, and nothing about how it was produced.
 *
 * Withheld deliberately: the cost build-up and selling price (internal margin),
 * per-dimension confidence sub-scores, provider and model identity, token usage,
 * prompt text, tenant and internal ids, and the raw model output. `costLines` is
 * ops-only for the same reason the junk lane keeps its breakdown internal — it is
 * the margin, itemized.
 */
export function customerMovingEstimateView(e: StoredMovingEstimate) {
  const a = e.analysis
  return {
    analysisId: e.id,
    lane: 'moving' as const,
    decision: e.decision,
    priced: e.pricing.priced,
    recommendedUsd: e.pricing.recommendedUsd,
    lowUsd: e.pricing.lowUsd,
    highUsd: e.pricing.highUsd,
    photoCount: e.inputPhotoUrls.length,
    // One rolled-up number, not the five sub-scores the estimator reasons with.
    confidence: a.confidence.overall,
    items: a.normalizedItems.slice(0, 25).map((i, n) => ({
      id: `mv-${n}`,
      label: i.label,
      category: i.category,
      quantity: i.quantity.likely,
      sizeClass: i.sizeClass,
      fragile: i.fragile,
      requiresDisassembly: i.requiresDisassembly,
    })),
    boxCount: a.boxCount.likely,
    estimatedTruckSpacePct: Math.round(Math.min(1, a.estimatedTruckSpaceFraction.likely) * 100),
    crewSize: e.pricing.crewSize,
    laborHours: { low: round1(e.pricing.laborHours.minimum), high: round1(e.pricing.laborHours.maximum) },
    missingInformation: e.missingInformation.slice(0, 6),
    questions: a.additionalQuestions.slice(0, 6),
    reviewReasons: e.reviewReasons.slice(0, 6),
    note:
      e.decision === 'instant_quote' ? 'This estimate assumes the photos show everything being moved and normal access at both addresses.'
        : e.decision === 'needs_information' ? 'We can tighten this once we know the details below.'
          : e.decision === 'estimate_range' ? 'A range for now — we confirm the final price before the truck rolls.'
            : 'A team member will review your photos and confirm your price shortly.',
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10
