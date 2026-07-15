import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { getBookingByToken, paymentSummaryStatus } from '../../../../lib/bookings'
import { getReview, saveReview, type SiteReview } from '../../../../lib/site-reviews'
import { rateLimit } from '../../../../lib/rate-limit'
import { emailOpsReviewLeft } from '../../../../lib/booking-emails'
import { resolveTenantFromResource } from '../../../../lib/platform/tenancy/tenant-resolve'
import { runWithTenant } from '../../../../lib/platform/tenancy/context'

// GET /api/booking/[token]/review — the existing review for this booking, if any.
export const GET = withTenantRoute(async (_req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const r = await getReview(token)
  return NextResponse.json({ review: r ?? null })
})

// POST /api/booking/[token]/review — a customer leaves (or updates) a review.
// Gated to bookings that are paid in full; one review per booking.
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  if (await rateLimit(req, 'bookingreview', 10, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }

  const b = await getBookingByToken(token)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (paymentSummaryStatus(b) !== 'paid_in_full') {
    return NextResponse.json({ error: 'Reviews open once your invoice is paid in full.' }, { status: 403 })
  }

  // Tenant is derived from the RECORD the unguessable token binds to — never from a
  // client param/query/body. Fail closed when tenancy is on and the record has no
  // binding; reference tenant (no-op) while TENANCY_ENABLED=false → response
  // unchanged. Booking has no tenantId field yet; the cast lets the resolver read it
  // once bindings exist (today undefined → fallback off / fail-closed on).
  const resolution = resolveTenantFromResource(b as { tenantId?: string | null }, { kind: 'booking', correlationId: token })
  if (!resolution) return NextResponse.json({ error: 'This booking is temporarily unavailable. Please try again shortly.' }, { status: 503 })
  return runWithTenant({ tenantId: resolution.tenantId }, async () => {

  const body = await req.json().catch(() => ({}))
  const rating = Math.round(Number(body.rating))
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: 'Please choose a star rating.' }, { status: 400 })
  }
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 1000) : undefined

  const existing = await getReview(token)
  const review: SiteReview = {
    token,
    bookingNumber: b.bookingNumber,
    authorName: b.customerName,
    rating,
    text: text || undefined,
    createdAt: existing?.createdAt ?? Date.now(),
    hidden: existing?.hidden ?? false,
  }
  await saveReview(review)
  await emailOpsReviewLeft(b, rating, review.text)

  return NextResponse.json({ ok: true, review })
  })
})
