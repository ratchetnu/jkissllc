import { NextRequest, NextResponse } from 'next/server'
import { after as afterResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { buildPhotoEstimate } from '../../../lib/ai/photo-estimate'
import { saveDraftEstimate, customerEstimateView } from '../../../lib/ai/estimate-store'
import { selectFollowUpQuestions } from '../../../lib/ai/followup-questions'
import { recordFunnelEvent } from '../../../lib/analytics-events'
import { filterPhotoUrls } from '../../../lib/photo-url'
import { buildEvaluationRecord, buildMovingEvaluationRecord, recordEvaluation } from '../../../lib/ai/eval-telemetry'
import { SERVICE_TYPES, serviceFamily, type ServiceType } from '../../../lib/bookings'
import { buildMovingEstimate, customerMovingEstimateView, type StoredMovingEstimate } from '../../../lib/ai/moving-estimate'
import type { MovingJobFacts } from '../../../lib/pricing/moving-quote'
import { isEnabled } from '../../../lib/platform/flags'
import { interactiveBudget, INTERACTIVE_ROUTE_CEILING_MS } from '../../../lib/ai/interactive-policy'

export const runtime = 'nodejs'
// The interactive latency budget is sized against THIS number. They are declared in
// two places by necessity (Next reads `maxDuration` as a static export; the budget is
// a runtime value), so assert they agree at module load rather than let them drift —
// a silently-raised ceiling would hand the customer a longer wait, not a better answer.
export const maxDuration = 60
if (maxDuration * 1000 !== INTERACTIVE_ROUTE_CEILING_MS) {
  throw new Error(
    `[quote/analyze] maxDuration ${maxDuration}s disagrees with INTERACTIVE_ROUTE_CEILING_MS ` +
    `${INTERACTIVE_ROUTE_CEILING_MS}ms — update ai/interactive-policy together with this route.`,
  )
}

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
  // Head-start analyses are counted separately (never instead) so the speculative
  // share of total analyses — the cost side of the latency win — is measurable.
  if (body.speculative === true) await recordFunnelEvent('quote_analyze_speculative', nowIso)

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
    const movingStartedAt = Date.now()
    // Same ceiling, same budget, same single-shot rule as the junk lane below. This
    // lane has one model call and no critic, so it takes the primary slice only —
    // but it MUST take one: unbudgeted it inherits the 30s platform default and the
    // service's transient retry, and two attempts alone reach this route's 60s
    // ceiling with no margin left to answer in.
    const movingBudget = interactiveBudget(movingStartedAt)
    const { stored, analyzedOk, outcome, degraded } = await buildMovingEstimate({
      analysisId, bookingId: 'draft', photoUrls: photos, serviceType, facts: readMovingFacts(body),
      budget: movingBudget,
    })
    const movingTotalMs = Date.now() - movingStartedAt
    await recordFunnelEvent(analyzedOk ? 'ai_analysis_completed' : 'ai_analysis_failed', nowIso)
    // A budget overrun is its own funnel outcome in BOTH lanes, so the degrade rate
    // a rollout has to watch is one number across the whole route.
    if (degraded) await recordFunnelEvent('ai_analysis_timeout', nowIso)
    await recordFunnelEvent(
      stored.decision === 'instant_quote' ? 'instant_quote_displayed'
        : stored.decision === 'estimate_range' ? 'estimate_range_displayed'
          : 'manual_review_required',
      nowIso,
    )
    // Evaluation telemetry for the moving lane — the same three gates as junk
    // (never Production, flag OFF by default, valid analysis id) and the same
    // `after` scheduling, so the KV writes land outside the request the benchmark
    // is timing. Registered BEFORE the response is returned; executed after it.
    //
    // The record is built from `stored`, which is the UNMODIFIED estimate: what is
    // measured is what the lane actually produced, not the flag-withheld
    // projection the customer sees. Fail-soft — telemetry can never reach the quote.
    afterResponse(async () => {
      try {
        await recordEvaluation(buildMovingEvaluationRecord({
          stored, serviceType, imageCount: photos.length,
          analyzedOk, outcome, totalLatencyMs: movingTotalMs, at: nowIso,
        }))
      } catch (e) { console.error('[quote/analyze] moving eval telemetry', e) }
    })

    // Flag OFF ⇒ the read is real but the price is withheld: a human quotes the
    // move. This is what shipped before the lane existed, minus the junk price.
    const view = customerMovingEstimateView(
      isEnabled('OPERION_MOVING_LANE') ? stored : withheldPricing(stored),
    )
    return NextResponse.json({ ok: true, estimate: view, followUps: [] })
  }

  // The full AI → monitor → pricing → critic chain, shared verbatim with the durable
  // server-side worker (app/lib/book-now-ai.ts) so both paths price identically.
  // The BUDGET is the only difference: a customer is waiting on this one, so every
  // stage is sliced against the route's own ceiling and the whole thing is single-shot.
  // The durable worker calls buildPhotoEstimate with no budget and keeps its longer,
  // patient retry policy (150s deadline, 5 attempts, exponential backoff).
  const budget = interactiveBudget(Date.now())
  const { stored, analyzedOk, degraded } = await buildPhotoEstimate({
    analysisId, bookingId: 'draft', photoUrls: photos, serviceType, debris, budget,
  })

  await recordFunnelEvent(analyzedOk ? 'ai_analysis_completed' : 'ai_analysis_failed', nowIso)
  // A budget overrun is its own funnel outcome. Before the interactive policy this
  // case was invisible: the platform killed the function and nothing was recorded.
  if (degraded) await recordFunnelEvent('ai_analysis_timeout', nowIso)
  await recordFunnelEvent(
    stored.decision === 'instant_quote' ? 'instant_quote_displayed'
      : stored.decision === 'estimate_range' ? 'estimate_range_displayed'
        : 'manual_review_required',
    nowIso,
  )

  // Persist the draft estimate so /api/quote can attach it on submit.
  try { await saveDraftEstimate(stored) } catch (e) { console.error('[quote/analyze] save draft', e) }

  // Evaluation telemetry (Preview only, flag OFF by default). Records the
  // estimate-side facts the customer-safe response omits, so a benchmark can
  // measure volume, truck utilisation, confidence inputs and critic behaviour.
  //
  // Runs AFTER the response via `after`, not inline. Awaiting its KV writes here
  // would add them to the request the benchmark is timing — telemetry that
  // inflates the very latency it exists to measure. Fail-soft: a telemetry error
  // can never reach the customer's quote.
  afterResponse(async () => {
    try {
      await recordEvaluation(buildEvaluationRecord({
        stored, serviceType, debris, imageCount: photos.length,
        analyzedOk, outcome: stored.status, at: nowIso,
      }))
    } catch (e) { console.error('[quote/analyze] eval telemetry', e) }
  })

  // Governed follow-up question selection (server-side; the client only renders).
  const estate = serviceType === 'estate-cleanout' || serviceType === 'garage-cleanout' || serviceType === 'eviction'
  const followUps = selectFollowUpQuestions({ serviceFamily: serviceFamily(serviceType), analysis: stored.analysis, estate })

  // `analyzed` is the structured outcome the client needs to distinguish "the model
  // read your photos and routed you to review" from "we ran out of time". Both still
  // return 200 with a usable estimate shell — the booking is never lost, and the
  // browser never sees a killed request.
  return NextResponse.json({
    ok: true,
    estimate: customerEstimateView(stored),
    followUps,
    analyzed: { ok: analyzedOk, degraded: degraded ?? null },
  })
})
