import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { buildPhotoEstimate } from '../../../lib/ai/photo-estimate'
import { saveDraftEstimate, customerEstimateView } from '../../../lib/ai/estimate-store'
import { selectFollowUpQuestions } from '../../../lib/ai/followup-questions'
import { recordFunnelEvent } from '../../../lib/analytics-events'
import { filterPhotoUrls } from '../../../lib/photo-url'
import { SERVICE_TYPES, serviceFamily, type ServiceType } from '../../../lib/bookings'
import { buildMovingEstimate, customerMovingEstimateView, type StoredMovingEstimate } from '../../../lib/ai/moving-estimate'
import type { MovingJobFacts } from '../../../lib/pricing/moving-quote'
import { isEnabled } from '../../../lib/platform/flags'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Non-visual move facts, read defensively from an untrusted body. Absent stays
 * ABSENT — a missing distance must surface as `needs_information`, and coercing
 * it to 0 would silently price a cross-town move as a next-door one.
 */
function readMovingFacts(body: Record<string, unknown>): MovingJobFacts {
  const posNum = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }
  return {
    travelMiles: posNum(body.travelMiles),
    originStairsFlights: posNum(body.originStairsFlights),
    destinationStairsFlights: posNum(body.destinationStairsFlights),
    elevatorRequired: body.elevatorRequired === true,
    packingRequested: body.packingRequested === true,
    destinationKnown: typeof body.destinationAddress === 'string' && body.destinationAddress.trim().length > 0,
  }
}

/** Lane flag OFF: keep the analysis, withhold the money, route to a human. */
function withheldPricing(e: StoredMovingEstimate): StoredMovingEstimate {
  return {
    ...e,
    decision: 'manual_review',
    status: 'review',
    pricing: { ...e.pricing, recommendedUsd: 0, lowUsd: 0, highUsd: 0, priced: false, costLines: [], sellingPriceCents: 0 },
    reviewReasons: Array.from(new Set([...e.reviewReasons, 'Moving quotes are confirmed by a team member.'])),
  }
}

// POST /api/quote/analyze — the AI estimating step (Phase 9).
// Body: { photos: string[] (Blob URLs), service, debris?, idempotencyKey? }
// 1) AI analyzes the photo SET → structured observations (never a price)
// 2) deterministic engine (priceJob) turns the truck-fill read into a quote
// 3) classify instant_quote | estimate_range | manual_review
// 4) persist a draft estimate (qa:{id}, 24h) so submit can attach it to the booking
// The result is customer-safe (no cost basis / margin). The AI never sees PII.
export const POST = withTenantRoute(async (req: NextRequest) => {
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

  // ── Service-family routing ─────────────────────────────────────────────────
  // The lane is chosen from the SERVICE FAMILY, never from a caller-supplied lane
  // or pricing hint: `service` is validated against SERVICE_TYPES first, then
  // mapped by serviceFamily(), so a request cannot select the moving engine for a
  // junk job or the reverse. An unrecognised service falls back to junk-removal —
  // the pre-existing default, and the conservative one, since that is the lane
  // carrying the review gates and the critic.
  //
  // A moving job NEVER reaches the disposal engine from here. With the lane flag
  // OFF it is analysed and returned unpriced for a human; with it ON it is priced
  // on labor, crew, travel and access. Neither state invents a landfill trip.
  if (serviceFamily(serviceType) === 'moving') {
    const { stored, analyzedOk } = await buildMovingEstimate({
      analysisId, bookingId: 'draft', photoUrls: photos, serviceType, facts: readMovingFacts(body),
    })
    await recordFunnelEvent(analyzedOk ? 'ai_analysis_completed' : 'ai_analysis_failed', nowIso)
    await recordFunnelEvent(
      stored.decision === 'instant_quote' ? 'instant_quote_displayed'
        : stored.decision === 'estimate_range' ? 'estimate_range_displayed'
          : 'manual_review_required',
      nowIso,
    )
    // Flag OFF ⇒ the read is real but the price is withheld: a human quotes the
    // move. This is what shipped before the lane existed, minus the junk price.
    const view = customerMovingEstimateView(
      isEnabled('OPERION_MOVING_LANE') ? stored : withheldPricing(stored),
    )
    return NextResponse.json({ ok: true, estimate: view, followUps: [] })
  }

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
})
