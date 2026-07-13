import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../../../lib/rate-limit'
import { isBlockedBot } from '../../../../lib/botcheck'
import {
  getBookingByInfoRequest, saveBooking, sanitizePhotos, pushBookingEvent, serviceFamily,
  INFO_REQUEST_FIELD_LABEL,
} from '../../../../lib/bookings'
import { customerEstimateView } from '../../../../lib/ai/estimate-store'
import { selectFollowUpQuestions } from '../../../../lib/ai/followup-questions'
import { projectCustomerFinalState } from '../../../../lib/ai/confirmation-ui'
import { submitConfirmation, processFinalAiJob, enqueueFinalAiJob } from '../../../../lib/book-now-confirmation'
import { filterPhotoUrls } from '../../../../lib/photo-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The secure "request more information" continuation (Part 13). The token is the
// owner-issued info-request token (unguessable, tenant-scoped via the index). The
// customer returns to a page that opens ONLY the requested step — never a restart.
// Customer-safe throughout: no internal pricing breakdown / cost basis / errors.

function safeView(b: Awaited<ReturnType<typeof getBookingByInfoRequest>>) {
  if (!b) return null
  const ir = b.infoRequest!
  return {
    requestNumber: b.bookingNumber,
    reason: ir.reason,
    message: ir.message ?? null,
    fields: ir.fields,
    fieldLabels: ir.fields.map(f => INFO_REQUEST_FIELD_LABEL[f]),
    completed: ir.completed,
    estate: b.serviceType === 'estate-cleanout' || b.serviceType === 'garage-cleanout' || b.serviceType === 'eviction' || !!b.confirmation?.estate,
    photoCount: b.invoicePhotos?.length ?? 0,
    estimate: b.aiEstimate ? customerEstimateView(b.aiEstimate) : null,
    followUps: b.aiEstimate ? selectFollowUpQuestions({ serviceFamily: serviceFamily(b.serviceType), analysis: b.aiEstimate.analysis, estate: b.serviceType === 'estate-cleanout' || b.serviceType === 'garage-cleanout' || b.serviceType === 'eviction' }) : [],
    // The customer's own confirmed items, so the page can pre-fill the review.
    items: b.confirmation?.items.map(i => ({
      id: i.id, category: i.category, name: i.name, quantity: i.quantity,
      uncertain: i.uncertain, removed: i.removed, aiDetected: i.aiDetected,
      aiName: i.aiName, aiQuantity: i.aiQuantity, aiConfidence: i.aiConfidence, sourcePhotoUrl: i.sourcePhotoUrl,
    })) ?? [],
    final: projectCustomerFinalState(b),
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (await rateLimit(req, 'quoteresume', 40, 5 * 60_000)) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  const { token } = await ctx.params
  const b = await getBookingByInfoRequest(token)
  if (!b || !b.infoRequest) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Stamp the first view (chargeback-grade tracking; Part 13).
  if (!b.infoRequest.viewedAt) {
    b.infoRequest.viewedAt = Date.now()
    pushBookingEvent(b, { actor: 'customer', action: 'confirmation.requested', result: 'viewed', meta: { fields: b.infoRequest.fields } })
    await saveBooking(b)
  }
  return NextResponse.json({ ok: true, ...safeView(b) })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (await rateLimit(req, 'quoteresumepost', 15, 5 * 60_000)) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  if (await isBlockedBot()) return NextResponse.json({ error: 'Request blocked.' }, { status: 403 })
  const { token } = await ctx.params
  const b = await getBookingByInfoRequest(token)
  if (!b || !b.infoRequest) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Idempotent: a repeat submission on a completed request just returns the state —
  // independent of whether the final estimate has landed yet (avoids a re-run race
  // while the job is still queued/processing).
  if (b.infoRequest.completed) {
    return NextResponse.json({ ok: true, final: projectCustomerFinalState(b) })
  }
  // Refuse to re-estimate a request that has already moved past quoting (owner sent
  // a quote / it's booked / paid) — the info-request continuation is for pre-quote
  // clarification only.
  const PAST_QUOTING = new Set(['pending_payment', 'pending_zelle_verification', 'payment_received', 'booking_created', 'confirmation_link_sent', 'customer_viewed', 'time_verification_pending', 'time_verified', 'confirmed', 'in_progress', 'continued', 'completed', 'partially_completed', 'could_not_complete', 'cancelled', 'refunded'])
  if ((b.invoiceAmountCents ?? 0) > 0 || (b.amountPaidCents ?? 0) > 0 || PAST_QUOTING.has(b.status)) {
    return NextResponse.json({ ok: true, final: projectCustomerFinalState(b) })
  }

  const body = await req.json().catch(() => ({}))

  // Appended photos — ONLY our Blob host, deduped (H1: persist BEFORE the fresh
  // reload inside submitConfirmation, or the appended photos are lost).
  const newPhotos = filterPhotoUrls(body.photos, 8)
  if (newPhotos.length > 0) {
    b.invoicePhotos = sanitizePhotos([...(b.invoicePhotos ?? []), ...newPhotos.map(u => ({ url: u }))])
    await saveBooking(b)
  }

  // Updated confirmation (quantities / access / inventory).
  let ranFinal = false
  if (body.confirmation && typeof body.confirmation === 'object') {
    const sub = await submitConfirmation(b.token, body.confirmation, { submittedBy: 'customer' })
    if (sub.ok) {
      await processFinalAiJob(b.token)
      ranFinal = true
    }
  } else if (newPhotos.length > 0 && b.confirmation) {
    // Photos-only response: re-run the final analysis against the existing
    // confirmation + the new photos (durable; cron recovers on failure).
    await saveBooking(b)
    enqueueFinalAiJob(b, { force: true, initiatedBy: 'customer' })
    await saveBooking(b)
    await processFinalAiJob(b.token)
    ranFinal = true
  } else if (newPhotos.length > 0) {
    await saveBooking(b)
  }

  // Mark the request answered (kept active + completed so repeats are idempotent).
  const fresh = await getBookingByInfoRequest(token)
  const target = fresh ?? b
  if (target.infoRequest) {
    target.infoRequest.respondedAt = Date.now()
    target.infoRequest.completed = true
    pushBookingEvent(target, { actor: 'customer', action: 'confirmation.submitted', result: 'info_response', meta: { photos: newPhotos.length, ranFinal } })
    await saveBooking(target)
  }

  return NextResponse.json({ ok: true, final: projectCustomerFinalState(target) })
}
