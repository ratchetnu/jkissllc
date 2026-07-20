import { analyzeJunkPhotos } from './junk-analysis'
import { monitorAnalysis, applyMonitor } from './analysis-monitor'
import { reviewJunkAnalysis, reconcileWithCritic, criticEnabled, criticModeFor, type CriticVerdict } from './junk-critic'
import { decideQuote } from '../pricing/quote-decision'
import { getDisposalSettings } from '../disposal'
import { getCalibration } from '../job-learning'
import { isEnabled } from '../platform/flags'
import { timeStage } from '../observability/pipeline-trace'
import type { StoredAiEstimate } from './estimate-store'
import { SERVICE_LABELS, type ServiceType } from '../bookings'

// ─────────────────────────────────────────────────────────────────────────────
// The Book Now photo-estimating chain, as ONE reusable server-side function:
//   AI vision → consistency monitor → deterministic pricing → critic → decision.
//
// Both the customer instant estimate (POST /api/quote/analyze) AND the durable
// server-side recovery worker (app/lib/book-now-ai.ts) call this — so there is a
// SINGLE pricing path, never two that can drift. The AI only ever produces
// observations; the deterministic engine sets the price. Fail-soft: the underlying
// analyzer never throws, and `analyzedOk` tells the caller whether the model
// actually produced a usable read (false = provider failure → the worker retries).
// ─────────────────────────────────────────────────────────────────────────────

export type PhotoEstimateInput = {
  analysisId: string
  bookingId: string
  photoUrls: string[]
  serviceType: ServiceType
  debris?: string
}

export type PhotoEstimateResult = {
  stored: StoredAiEstimate
  analyzedOk: boolean        // false = the AI vision call itself failed (retryable)
  outcome: string            // telemetry outcome / local reason from the analyzer
  model?: string
  callId?: string
}

export async function buildPhotoEstimate(input: PhotoEstimateInput): Promise<PhotoEstimateResult> {
  const nowIso = new Date().toISOString()
  const serviceLabel = SERVICE_LABELS[input.serviceType] ?? input.serviceType

  // 1) AI visual analysis (fail-soft — always returns an analysis object). Timed as the
  // `ai` stage (its internal preprocessing + provider round-trip are recorded as nested
  // sub-stages). Observability is a no-op when no pipeline trace is active.
  const analyzed = await timeStage('ai', () => analyzeJunkPhotos({
    analysisId: input.analysisId, bookingId: input.bookingId, photoUrls: input.photoUrls, serviceLabel, nowIso,
  }))

  // 1b)+2)+3)+1c) The deterministic pricing phase: consistency monitor, disposal
  // settings/calibration fetch, pricing decision, and an optional second-opinion critic
  // (default off) — timed together as the `pricing` stage.
  const { monitor, analysis, decision, critic } = await timeStage('pricing', async () => {
    const monitor = monitorAnalysis(analyzed.analysis)
    let analysis = applyMonitor(analyzed.analysis, monitor)

    // Deterministic pricing + decision. A monitor 'block' forces manual review.
    const [settings, calibration] = await Promise.all([getDisposalSettings(), getCalibration()])
    let decision = decideQuote({ analysis, settings, calibration, serviceType: input.serviceType, debris: input.debris, forceReview: monitor.forceReview })

    // Second-opinion critic — only when about to auto-quote. Fail-soft. The reviewer
    // inspects the structured numbers by default and spends a full second vision pass
    // only on borderline-confidence reads (OPERION_CRITIC_JSON); OFF ⇒ vision always.
    let critic: CriticVerdict | null = null
    if (decision.decision === 'instant_quote' && criticEnabled()) {
      const mode = criticModeFor(analysis.confidence, isEnabled('OPERION_CRITIC_JSON'))
      critic = await reviewJunkAnalysis({ analysis, photoUrls: input.photoUrls, serviceLabel, mode })
      if (critic) {
        analysis = reconcileWithCritic(analysis, critic)
        decision = decideQuote({ analysis, settings, calibration, serviceType: input.serviceType, debris: input.debris, forceReview: monitor.forceReview || critic.recommend === 'review' })
      }
    }
    return { monitor, analysis, decision, critic }
  })

  const stored: StoredAiEstimate = {
    id: input.analysisId,
    createdAt: nowIso,
    status: analyzed.ok ? (decision.decision === 'manual_review' ? 'review' : 'completed') : 'failed',
    decision: decision.decision,
    provider: analysis.modelProvider,
    model: analyzed.model ?? analysis.modelName,
    schemaVersion: analysis.schemaVersion,
    callId: analyzed.callId,
    latencyMs: analyzed.latencyMs,
    inputPhotoUrls: input.photoUrls,
    analysis,
    pricing: {
      recommendedUsd: decision.recommendedUsd,
      lowUsd: decision.rangeUsd.low,
      highUsd: decision.rangeUsd.high,
      breakdown: decision.breakdown,
    },
    reviewReasons: decision.reviewReasons,
    monitor,
    critic: critic ?? undefined,
  }

  return { stored, analyzedOk: analyzed.ok, outcome: analyzed.outcome, model: analyzed.model, callId: analyzed.callId }
}
