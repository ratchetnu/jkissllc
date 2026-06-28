import { NextRequest, NextResponse } from 'next/server'
import { getBookingByToken, saveBooking, customerView, recompute } from '../../../../lib/bookings'
import { rateLimit } from '../../../../lib/rate-limit'
import { notifyRescheduled, notifyRescheduleRequest } from '../../../../lib/notify'

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || undefined : undefined)

// POST /api/booking/[token]/reschedule — customer self-service rescheduling.
// mode 'pick': switch to a different admin-offered date/window.
// mode 'request': ask for a custom date (ops coordinates; booking unchanged).
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (await rateLimit(req, 'bookingreschedule', 8, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }

  const b = await getBookingByToken(token)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (b.status === 'cancelled' || b.status === 'completed') {
    return NextResponse.json({ error: 'This booking can no longer be rescheduled online — please call us.' }, { status: 409 })
  }

  const body = await req.json().catch(() => ({}))

  if (body.mode === 'request') {
    const requestedDate = clean(body.requestedDate, 60)
    const note = clean(body.note, 500)
    if (!requestedDate && !note) return NextResponse.json({ error: 'Tell us what date works better.' }, { status: 400 })
    b.rescheduleRequest = { requestedDate, note, at: Date.now() }
    await saveBooking(b)
    await notifyRescheduleRequest(b)
    return NextResponse.json({ ok: true, requested: true, booking: customerView(b) })
  }

  // mode 'pick' — must choose from the admin-offered options.
  const selectedDate = clean(body.selectedDate, 20)
  const selectedWindow = clean(body.selectedWindow, 40)
  if (!selectedDate || !b.availableDates.includes(selectedDate)) {
    return NextResponse.json({ error: 'Please choose one of the offered dates.' }, { status: 400 })
  }
  if (b.availableWindows.length > 0 && (!selectedWindow || !b.availableWindows.includes(selectedWindow))) {
    return NextResponse.json({ error: 'Please choose an arrival window.' }, { status: 400 })
  }
  if (selectedDate === b.selectedDate && selectedWindow === b.selectedWindow) {
    return NextResponse.json({ error: 'That’s already your scheduled time.' }, { status: 400 })
  }

  b.selectedDate = selectedDate
  b.selectedWindow = selectedWindow
  b.rescheduleCount = (b.rescheduleCount ?? 0) + 1
  b.rescheduleRequest = undefined
  recompute(b)
  await saveBooking(b)
  await notifyRescheduled(b)

  return NextResponse.json({ ok: true, booking: customerView(b) })
}
