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
import { decideMovingQuote, type MovingDecisionResult } from '../pricing/moving-decision'
import { timeStage } from '../observability/pipeline-trace'
import { SERVICE_LABELS, type ServiceType } from '../bookings'
import type { MovingPhotoAnalysis } from './analysis-schema-moving'

export type MovingEstimateInput = {
  analysisId: string
  bookingId: string
  photoUrls: string[]
  serviceType: ServiceType
  facts?: MovingJobFacts
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
}

export type MovingEstimateResult = {
  stored: StoredMovingEstimate
  analyzedOk: boolean
  outcome: string
  model?: string
  callId?: string
}

export async function buildMovingEstimate(input: MovingEstimateInput): Promise<MovingEstimateResult> {
  const nowIso = new Date().toISOString()
  const serviceLabel = SERVICE_LABELS[input.serviceType] ?? input.serviceType

  const analyzed = await timeStage('ai', () => analyzeMovingPhotos({
    analysisId: input.analysisId, bookingId: input.bookingId, photoUrls: input.photoUrls, serviceLabel, nowIso,
  }))

  const decision = await timeStage('pricing', async () => {
    const settings = await getMovingSettings()
    return decideMovingQuote({ analysis: analyzed.analysis, settings, facts: input.facts })
  })

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
  }

  return { stored, analyzedOk: analyzed.ok, outcome: analyzed.outcome, model: analyzed.model, callId: analyzed.callId }
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
