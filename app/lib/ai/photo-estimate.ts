import { analyzeJunkPhotos, analysisOutputTokenBudget } from './junk-analysis'
import { reviewFallbackAnalysis } from './analysis-schema'
import { monitorAnalysis, applyMonitor } from './analysis-monitor'
import { reviewJunkAnalysis, reconcileWithCritic, criticEnabled, criticModeFor, type CriticVerdict } from './junk-critic'
import { decideQuote, type QuoteDecisionResult } from '../pricing/quote-decision'
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

/**
 * Dependency-injection seam, mirroring analyzePhotosV2's `deps`. Lets the budget
 * wiring be tested without a provider call or a Redis round-trip. Defaults are the
 * real implementations, so production behaviour is unchanged.
 */
export type PhotoEstimateDeps = {
  analyze?: typeof analyzeJunkPhotos
  review?: typeof reviewJunkAnalysis
  loadSettings?: typeof getDisposalSettings
  loadCalibration?: typeof getCalibration
}

/** The customer-facing reason a review reads as honest rather than as a failure. */
const UNPRICED_REASON = 'We could not finish reading your photos automatically — a team member is pricing this by hand.'

/**
 * Strip the money from a decision that was computed over a read which never
 * happened, keeping the shape every downstream consumer expects.
 *
 * `priced: false` already carries exactly this meaning in QuoteDecisionResult ("no
 * price was computed, which is NOT the same as the price is $0"), so this reuses
 * that contract rather than inventing a second one. Zeroing WITHOUT setting the flag
 * would be the worse bug — a real $0 job and an unpriced one would become
 * indistinguishable.
 */
function unpricedDecision(d: QuoteDecisionResult): QuoteDecisionResult {
  return {
    ...d,
    decision: 'manual_review',
    recommendedUsd: 0,
    rangeUsd: { low: 0, high: 0 },
    priced: false,
    breakdown: { ...d.breakdown, costLines: [] },
    reviewReasons: Array.from(new Set([...d.reviewReasons, UNPRICED_REASON])),
  }
}

export async function buildPhotoEstimate(
  input: PhotoEstimateInput,
  deps: PhotoEstimateDeps = {},
): Promise<PhotoEstimateResult> {
  const analyze = deps.analyze ?? analyzeJunkPhotos
  const review = deps.review ?? reviewJunkAnalysis
  const loadSettings = deps.loadSettings ?? getDisposalSettings
  const loadCalibration = deps.loadCalibration ?? getCalibration
  const nowIso = new Date().toISOString()
  const serviceLabel = SERVICE_LABELS[input.serviceType] ?? input.serviceType
  const budget = input.budget ?? durableBudget()
  const clock = input.now ?? Date.now
  const interactive = budget.mode === 'interactive'
  const startedAt = clock()

  // 1) AI visual analysis (fail-soft — always returns an analysis object). Timed as the
  // `ai` stage (its internal preprocessing + provider round-trip are recorded as nested
  // sub-stages). Observability is a no-op when no pipeline trace is active.
  // The slice AND the matching output-token ceiling are resolved together — passing
  // the analyzer's own scaled cap so the budget can only ever lower it, never raise a
  // small job to a large job's allowance.
  const primary = budget.primary(startedAt, analysisOutputTokenBudget(input.photoUrls.length))

  // A slice that cannot afford the minimum honest response does not get to try. The
  // provider is never called: a doomed call spends money, holds the customer for the
  // whole slice, and comes back either empty or truncated — and truncated JSON
  // discards the entire read anyway. We go straight to the structured, unpriced
  // fallback, which is the same answer the doomed call would have produced minus the
  // wait and the bill.
  const analyzed = primary.skipProvider
    ? {
      analysis: reviewFallbackAnalysis(
        {
          analysisId: input.analysisId, bookingId: input.bookingId, photoUrls: input.photoUrls,
          modelProvider: 'none', modelName: 'skipped', analyzedAt: nowIso,
        },
        ['There was not enough time left to read your photos automatically.'],
      ),
      ok: false as const,
      outcome: 'budget_exhausted',
    }
    : await timeStage('ai', () => analyze({
      analysisId: input.analysisId, bookingId: input.bookingId, photoUrls: input.photoUrls, serviceLabel, nowIso,
      timeoutMs: primary.timeoutMs, attempts: primary.attempts, maxOutputTokens: primary.maxOutputTokens,
    }))

  // Did the interactive budget — rather than the provider — end this read? A timeout
  // or abort surfaces as errorClass 'network'; with a single attempt and a slice we
  // chose ourselves, that IS the budget expiring. Recorded, never a platform 504.
  const degraded: InteractiveDegradeReason | undefined = !interactive || analyzed.ok
    ? undefined
    : primary.skipProvider ? 'budget_exhausted'
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
    const [settings, calibration] = await Promise.all([loadSettings(), loadCalibration()])
    let decision = decideQuote({ analysis, settings, calibration, serviceType: input.serviceType, debris: input.debris, forceReview: monitor.forceReview })

    // ── A read that never happened must not produce a number ────────────────────
    // When the provider call fails, `analyzed.analysis` is reviewFallbackAnalysis:
    // zero confidence, no items, and `estimatedTruckLoads` defaulted to 1. Those are
    // PLACEHOLDERS, but decideQuote cannot tell them from a real read of a one-load
    // job — so it priced them, and a timed-out analysis came back as a confident
    // "$580–$815, priced: true". The decision said manual_review while the money said
    // otherwise, and the customer saw the money.
    //
    // The moving lane already refuses to price what it could not analyse
    // (`unpricedDecision`); this is the junk lane's equivalent. The analysis object
    // is kept intact for the admin and the durable retry — only the PRICE is
    // withheld, because the price is the part that was never earned.
    if (!analyzed.ok) decision = unpricedDecision(decision)

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
        critic = await review({
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
      priced: decision.priced,
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
