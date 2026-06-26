import { NextRequest, NextResponse } from 'next/server'
import { getBookingByToken, paymentSummaryStatus } from '../../../../lib/bookings'
import { getReview, saveReview, type SiteReview } from '../../../../lib/site-reviews'
import { rateLimit } from '../../../../lib/rate-limit'
import { emailOpsReviewLeft } from '../../../../lib/booking-emails'

// GET /api/booking/[token]/review — the existing review for this booking, if any.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const r = await getReview(token)
  return NextResponse.json({ review: r ?? null })
}

// POST /api/booking/[token]/review — a customer leaves (or updates) a review.
// Gated to bookings that are paid in full; one review per booking.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (await rateLimit(req, 'bookingreview', 10, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }

  const b = await getBookingByToken(token)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (paymentSummaryStatus(b) !== 'paid_in_full') {
    return NextResponse.json({ error: 'Reviews open once your invoice is paid in full.' }, { status: 403 })
  }

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
}
