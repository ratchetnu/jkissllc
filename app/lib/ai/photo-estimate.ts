import { analyzeJunkPhotos } from './junk-analysis'
import { monitorAnalysis, applyMonitor } from './analysis-monitor'
import { reviewJunkAnalysis, reconcileWithCritic, criticEnabled, criticModeFor, type CriticVerdict } from './junk-critic'
import { decideQuote } from '../pricing/quote-decision'
import { getDisposalSettings } from '../disposal'
import { getCalibration } from '../job-learning'
import { isEnabled } from '../platform/flags'
import { timeStage } from '../observability/pipeline-trace'
import { durableBudget, type InteractiveBudget, type InteractiveDegradeReason } from './interactive-policy'
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
  // Latency policy. Omitted ⇒ `durableBudget()`: today's behaviour exactly (platform
  // default per-call timeout, the AI service's transient retry, critic always eligible).
  // The interactive route passes a live budget so every stage is sliced against the
  // request's own function ceiling — see ai/interactive-policy.
  budget?: InteractiveBudget
  /** Injectable clock so budget behaviour is testable without real waiting. */
  now?: () => number
}

export type PhotoEstimateResult = {
  stored: StoredAiEstimate
  analyzedOk: boolean        // false = the AI vision call itself failed (retryable)
  outcome: string            // telemetry outcome / local reason from the analyzer
  model?: string
  callId?: string
  /** Set when the interactive budget cut the analysis short. Never set for durable runs. */
  degraded?: InteractiveDegradeReason
}

export async function buildPhotoEstimate(input: PhotoEstimateInput): Promise<PhotoEstimateResult> {
  const nowIso = new Date().toISOString()
  const serviceLabel = SERVICE_LABELS[input.serviceType] ?? input.serviceType
  const budget = input.budget ?? durableBudget()
  const clock = input.now ?? Date.now
  const interactive = budget.mode === 'interactive'
  const startedAt = clock()

  // 1) AI visual analysis (fail-soft — always returns an analysis object). Timed as the
  // `ai` stage (its internal preprocessing + provider round-trip are recorded as nested
  // sub-stages). Observability is a no-op when no pipeline trace is active.
  const primary = budget.primary(startedAt)
  const analyzed = await timeStage('ai', () => analyzeJunkPhotos({
    analysisId: input.analysisId, bookingId: input.bookingId, photoUrls: input.photoUrls, serviceLabel, nowIso,
    timeoutMs: primary.timeoutMs, attempts: primary.attempts,
  }))

  // Did the interactive budget — rather than the provider — end this read? A timeout
  // or abort surfaces as errorClass 'network'; with a single attempt and a slice we
  // chose ourselves, that IS the budget expiring. Recorded, never a platform 504.
  const degraded: InteractiveDegradeReason | undefined = !interactive || analyzed.ok
    ? undefined
    : analyzed.errorClass === 'network' ? 'primary_timeout'
      : primary.timeoutMs <= 0 ? 'budget_exhausted'
        : undefined

  // 1b)+2)+3)+1c) The deterministic pricing phase: consistency monitor, disposal
  // settings/calibration fetch, pricing decision, and an optional second-opinion critic
  // (default off) — timed together as the `pricing` stage.
  const { monitor, analysis, decision, critic, criticSlice, criticSkipped } = await timeStage('pricing', async () => {
    const monitor = monitorAnalysis(analyzed.analysis)
    let analysis = applyMonitor(analyzed.analysis, monitor)

    // Deterministic pricing + decision. A monitor 'block' forces manual review.
    const [settings, calibration] = await Promise.all([getDisposalSettings(), getCalibration()])
    let decision = decideQuote({ analysis, settings, calibration, serviceType: input.serviceType, debris: input.debris, forceReview: monitor.forceReview })

    // Second-opinion critic — only when about to auto-quote. Fail-soft. The reviewer
    // inspects the structured numbers by default and spends a full second vision pass
    // only on borderline-confidence reads (OPERION_CRITIC_JSON); OFF ⇒ vision always.
    let critic: CriticVerdict | null = null
    let criticSkipped: 'budget' | undefined
    const criticSlice = budget.critic(clock())
    if (decision.decision === 'instant_quote' && criticEnabled()) {
      // Interactive only: a critic we cannot afford to FINISH is pure latency for no
      // verdict, so skip it deliberately. The effect on the estimate is identical to
      // today's critic-failure path (verdict null ⇒ primary analysis stands) — but it
      // is recorded on the estimate, so the skip rate is measurable in Preview before
      // this ever reaches Production.
      if (interactive && criticSlice.timeoutMs <= 0) {
        criticSkipped = 'budget'
      } else {
        const mode = criticModeFor(analysis.confidence, isEnabled('OPERION_CRITIC_JSON'))
        critic = await reviewJunkAnalysis({
          analysis, photoUrls: input.photoUrls, serviceLabel, mode,
          timeoutMs: criticSlice.timeoutMs, attempts: criticSlice.attempts,
        })
        if (critic) {
          analysis = reconcileWithCritic(analysis, critic)
          decision = decideQuote({ analysis, settings, calibration, serviceType: input.serviceType, debris: input.debris, forceReview: monitor.forceReview || critic.recommend === 'review' })
        }
      }
    }
    return { monitor, analysis, decision, critic, criticSlice, criticSkipped }
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
    // Latency accounting is recorded ONLY for interactive runs — a durable run has no
    // budget to degrade, and writing the field there would pollute the measurement.
    ...(interactive
      ? {
        latency: {
          mode: 'interactive' as const,
          ...(degraded ? { degraded } : {}),
          ...(criticSkipped ? { criticSkipped } : {}),
          primaryTimeoutMs: primary.timeoutMs,
          criticTimeoutMs: criticSlice.timeoutMs,
          elapsedMs: Math.max(0, clock() - startedAt),
        },
      }
      : {}),
  }

  return { stored, analyzedOk: analyzed.ok, outcome: analyzed.outcome, model: analyzed.model, callId: analyzed.callId, degraded }
}
