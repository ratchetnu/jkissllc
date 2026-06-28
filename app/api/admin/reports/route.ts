import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import { listBookings } from '../../../lib/bookings'
import { computeBookingAnalytics } from '../../../lib/analytics'
import { listReviews, aggregate } from '../../../lib/site-reviews'

// Executive revenue/booking analytics for the admin dashboard.
export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const [bookings, reviews] = await Promise.all([listBookings(1000), listReviews(500)])
    const agg = aggregate(reviews.filter(r => !r.hidden))
    const data = computeBookingAnalytics(bookings, Date.now(), { count: agg.count, rating: agg.rating })
    return NextResponse.json({ ok: true, data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/reports]', err)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
