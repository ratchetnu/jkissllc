import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { analyzeJunkPhotos } from '../../../lib/ai/junk-analysis'
import { monitorAnalysis, applyMonitor } from '../../../lib/ai/analysis-monitor'
import { reviewJunkAnalysis, reconcileWithCritic, criticEnabled, type CriticVerdict } from '../../../lib/ai/junk-critic'
import { decideQuote } from '../../../lib/pricing/quote-decision'
import { getDisposalSettings } from '../../../lib/disposal'
import { getCalibration } from '../../../lib/job-learning'
import { saveDraftEstimate, customerEstimateView, type StoredAiEstimate } from '../../../lib/ai/estimate-store'
import { recordFunnelEvent } from '../../../lib/analytics-events'
import { SERVICE_LABELS, SERVICE_TYPES, type ServiceType } from '../../../lib/bookings'

export const runtime = 'nodejs'
export const maxDuration = 60

// POST /api/quote/analyze — the AI estimating step (Phase 9).
// Body: { photos: string[] (Blob URLs), service, debris?, idempotencyKey? }
// 1) AI analyzes the photo SET → structured observations (never a price)
// 2) deterministic engine (priceJob) turns the truck-fill read into a quote
// 3) classify instant_quote | estimate_range | manual_review
// 4) persist a draft estimate (qa:{id}, 24h) so submit can attach it to the booking
// The result is customer-safe (no cost basis / margin). The AI never sees PII.
export async function POST(req: NextRequest) {
  if (await rateLimit(req, 'quoteanalyze', 10, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many estimates. Please wait a few minutes.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Request blocked. Please try again.' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const photos: string[] = Array.isArray(body.photos)
    ? body.photos.map((u: unknown) => String(u)).filter((u: string) => /^https:\/\/\S+$/i.test(u)).slice(0, 8)
    : []
  if (photos.length === 0) {
    return NextResponse.json({ error: 'Please upload at least one photo to get an instant estimate.' }, { status: 400 })
  }

  const serviceType = (SERVICE_TYPES.includes(body.service) ? body.service : 'junk-removal') as ServiceType
  const debris = typeof body.debris === 'string' ? body.debris : undefined
  const nowIso = new Date().toISOString()
  const analysisId = crypto.randomUUID()

  await recordFunnelEvent('quote_analyze_started', nowIso)

  const serviceLabel = SERVICE_LABELS[serviceType] ?? serviceType

  // 1) AI visual analysis (fail-soft — always returns an analysis object).
  const analyzed = await analyzeJunkPhotos({
    analysisId, bookingId: 'draft', photoUrls: photos, serviceLabel, nowIso,
  })
  await recordFunnelEvent(analyzed.ok ? 'ai_analysis_completed' : 'ai_analysis_failed', nowIso)

  // 1b) Deterministic consistency monitor (always on, zero AI cost) — cross-checks
  // the model's own numbers and penalizes/flags contradictions before pricing.
  const monitor = monitorAnalysis(analyzed.analysis)
  let analysis = applyMonitor(analyzed.analysis, monitor)

  // 2) + 3) Deterministic pricing + decision. A monitor 'block' forces manual review.
  const [settings, calibration] = await Promise.all([getDisposalSettings(), getCalibration()])
  let decision = decideQuote({ analysis, settings, calibration, serviceType, debris, forceReview: monitor.forceReview })

  // 1c) Second-opinion AI reviewer — only when we're about to auto-quote (verify
  // before commit). It can confirm, downgrade to a range, or force review. Fail-soft.
  let critic: CriticVerdict | null = null
  if (decision.decision === 'instant_quote' && criticEnabled()) {
    critic = await reviewJunkAnalysis({ analysis, photoUrls: photos, serviceLabel })
    if (critic) {
      analysis = reconcileWithCritic(analysis, critic)
      decision = decideQuote({ analysis, settings, calibration, serviceType, debris, forceReview: monitor.forceReview || critic.recommend === 'review' })
    }
  }

  await recordFunnelEvent(
    decision.decision === 'instant_quote' ? 'instant_quote_displayed'
      : decision.decision === 'estimate_range' ? 'estimate_range_displayed'
        : 'manual_review_required',
    nowIso,
  )

  // 4) Persist the draft estimate so /api/quote can attach it on submit.
  const stored: StoredAiEstimate = {
    id: analysisId,
    createdAt: nowIso,
    status: analyzed.ok ? (decision.decision === 'manual_review' ? 'review' : 'completed') : 'failed',
    decision: decision.decision,
    provider: analysis.modelProvider,
    model: analyzed.model ?? analysis.modelName,
    schemaVersion: analysis.schemaVersion,
    callId: analyzed.callId,
    latencyMs: analyzed.latencyMs,
    inputPhotoUrls: photos,
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
  try { await saveDraftEstimate(stored) } catch (e) { console.error('[quote/analyze] save draft', e) }

  return NextResponse.json({ ok: true, estimate: customerEstimateView(stored) })
}
