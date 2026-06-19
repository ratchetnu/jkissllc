import { NextRequest, NextResponse } from 'next/server'
import { getBookingByToken, saveBooking, recompute, customerView } from '../../../../lib/bookings'
import { getCurrentPolicy } from '../../../../lib/policy'
import { rateLimit } from '../../../../lib/rate-limit'
import { getIP, getUA } from '../../../../lib/req'
import { notifyTimeVerified, notifyBookingConfirmed } from '../../../../lib/notify'
import { emailOpsTimeVerified } from '../../../../lib/booking-emails'

function clean(v: unknown, max = 500): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, max)
  return t || undefined
}

// POST /api/booking/[token]/verify — customer verifies date + arrival window,
// supplies access details, and accepts the cancellation/refund policy.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (await rateLimit(req, 'bookingverify', 10, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }

  const b = await getBookingByToken(token)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (b.status === 'cancelled') return NextResponse.json({ error: 'This booking has been cancelled. Please contact us.' }, { status: 409 })

  const body = await req.json().catch(() => ({}))
  const selectedDate = clean(body.selectedDate, 20)
  const selectedWindow = clean(body.selectedWindow, 40)

  if (!selectedDate || !b.availableDates.includes(selectedDate)) {
    return NextResponse.json({ error: 'Please choose an available service date.' }, { status: 400 })
  }
  if (!selectedWindow || !b.availableWindows.includes(selectedWindow)) {
    return NextResponse.json({ error: 'Please choose an available arrival window.' }, { status: 400 })
  }
  if (body.agreementAccepted !== true) {
    return NextResponse.json({ error: 'You must accept the Cancellation & Refund Policy to continue.' }, { status: 400 })
  }

  const now = Date.now()
  const policy = await getCurrentPolicy()
  const firstVerify = !b.customerTimeVerifiedAt

  b.selectedDate = selectedDate
  b.selectedWindow = selectedWindow
  b.customerPhone = clean(body.customerPhone, 40) ?? b.customerPhone
  b.gateCode = clean(body.gateCode, 60)
  b.parkingNotes = clean(body.parkingNotes, 500)
  b.accessNotes = clean(body.accessNotes, 1000)
  b.specialInstructions = clean(body.specialInstructions, 1000)
  b.customerNotes = clean(body.customerNotes, 1000)

  // Agreement acceptance audit trail (chargeback evidence).
  b.agreementAccepted = true
  b.agreementAcceptedAt = now
  b.agreementPolicyVersion = policy.version
  b.agreementIp = getIP(req)
  b.agreementUserAgent = getUA(req)

  b.customerTimeVerifiedAt = now
  const wasConfirmed = b.status === 'confirmed'
  recompute(b)
  await saveBooking(b)

  // Notify ops always; notify customer of verification; if payment already made
  // this verification flips the booking to fully confirmed.
  await emailOpsTimeVerified(b)
  if (!wasConfirmed && b.status === 'confirmed') {
    await notifyBookingConfirmed(b)
  } else if (firstVerify) {
    await notifyTimeVerified(b)
  }

  return NextResponse.json({ ok: true, booking: customerView(b) })
}
