import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { buildPhotoEstimate } from '../../../lib/ai/photo-estimate'
import { saveDraftEstimate, customerEstimateView } from '../../../lib/ai/estimate-store'
import { selectFollowUpQuestions } from '../../../lib/ai/followup-questions'
import { recordFunnelEvent } from '../../../lib/analytics-events'
import { filterPhotoUrls } from '../../../lib/photo-url'
import { SERVICE_TYPES, serviceFamily, type ServiceType } from '../../../lib/bookings'

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
  // Only our Vercel Blob store — never an attacker-supplied URL handed to the model.
  const photos: string[] = filterPhotoUrls(body.photos, 8)
  if (photos.length === 0) {
    return NextResponse.json({ error: 'Please upload at least one photo to get an instant estimate.' }, { status: 400 })
  }

  const serviceType = (SERVICE_TYPES.includes(body.service) ? body.service : 'junk-removal') as ServiceType
  const debris = typeof body.debris === 'string' ? body.debris : undefined
  const analysisId = crypto.randomUUID()
  const nowIso = new Date().toISOString()

  await recordFunnelEvent('quote_analyze_started', nowIso)

  // The full AI → monitor → pricing → critic chain, shared verbatim with the durable
  // server-side worker (app/lib/book-now-ai.ts) so both paths price identically.
  const { stored, analyzedOk } = await buildPhotoEstimate({ analysisId, bookingId: 'draft', photoUrls: photos, serviceType, debris })

  await recordFunnelEvent(analyzedOk ? 'ai_analysis_completed' : 'ai_analysis_failed', nowIso)
  await recordFunnelEvent(
    stored.decision === 'instant_quote' ? 'instant_quote_displayed'
      : stored.decision === 'estimate_range' ? 'estimate_range_displayed'
        : 'manual_review_required',
    nowIso,
  )

  // Persist the draft estimate so /api/quote can attach it on submit.
  try { await saveDraftEstimate(stored) } catch (e) { console.error('[quote/analyze] save draft', e) }

  // Governed follow-up question selection (server-side; the client only renders).
  const estate = serviceType === 'estate-cleanout' || serviceType === 'garage-cleanout' || serviceType === 'eviction'
  const followUps = selectFollowUpQuestions({ serviceFamily: serviceFamily(serviceType), analysis: stored.analysis, estate })

  return NextResponse.json({ ok: true, estimate: customerEstimateView(stored), followUps })
}
