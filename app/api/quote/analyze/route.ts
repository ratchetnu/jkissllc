import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { analyzeJunkPhotos } from '../../../lib/ai/junk-analysis'
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

  // 1) AI visual analysis (fail-soft — always returns an analysis object).
  const analyzed = await analyzeJunkPhotos({
    analysisId, bookingId: 'draft', photoUrls: photos,
    serviceLabel: SERVICE_LABELS[serviceType] ?? serviceType, nowIso,
  })
  await recordFunnelEvent(analyzed.ok ? 'ai_analysis_completed' : 'ai_analysis_failed', nowIso)

  // 2) + 3) Deterministic pricing + decision.
  const [settings, calibration] = await Promise.all([getDisposalSettings(), getCalibration()])
  const decision = decideQuote({ analysis: analyzed.analysis, settings, calibration, serviceType, debris })

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
    provider: analyzed.analysis.modelProvider,
    model: analyzed.model ?? analyzed.analysis.modelName,
    schemaVersion: analyzed.analysis.schemaVersion,
    callId: analyzed.callId,
    latencyMs: analyzed.latencyMs,
    inputPhotoUrls: photos,
    analysis: analyzed.analysis,
    pricing: {
      recommendedUsd: decision.recommendedUsd,
      lowUsd: decision.rangeUsd.low,
      highUsd: decision.rangeUsd.high,
      breakdown: decision.breakdown,
    },
    reviewReasons: decision.reviewReasons,
  }
  try { await saveDraftEstimate(stored) } catch (e) { console.error('[quote/analyze] save draft', e) }

  return NextResponse.json({ ok: true, estimate: customerEstimateView(stored) })
}
