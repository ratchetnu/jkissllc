import { NextRequest, NextResponse } from 'next/server'
import { getBookingByToken, saveBooking, customerView } from '../../../lib/bookings'
import { getCurrentPolicy, getPolicyVersion } from '../../../lib/policy'
import { emailOpsBookingViewed } from '../../../lib/booking-emails'

// GET /api/booking/[token] — customer-safe booking + the policy to display.
// Also records the first view (chargeback evidence) without leaking internals.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  let booking
  try {
    booking = await getBookingByToken(token)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    return NextResponse.json({ error: 'lookup failed' }, { status: 500 })
  }
  if (!booking) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Mark first view + advance status if still in an early stage.
  if (!booking.customerViewedAt && booking.status !== 'cancelled') {
    booking.customerViewedAt = Date.now()
    if (booking.status === 'confirmation_link_sent' || booking.status === 'booking_created') {
      booking.status = 'customer_viewed'
    }
    try { await saveBooking(booking); await emailOpsBookingViewed(booking) } catch { /* best-effort */ }
  }

  // Show the version the customer already accepted (frozen), else the current one.
  const policy = booking.agreementPolicyVersion
    ? (await getPolicyVersion(booking.agreementPolicyVersion)) ?? (await getCurrentPolicy())
    : await getCurrentPolicy()

  return NextResponse.json({
    booking: customerView(booking),
    policy: { version: policy.version, text: policy.text },
  })
}
