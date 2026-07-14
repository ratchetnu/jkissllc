import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { getBookingByToken, saveBooking, customerView } from '../../../../lib/bookings'
import { rateLimit } from '../../../../lib/rate-limit'
import { notifyReturnConfirmed, notifyReturnChangeRequest } from '../../../../lib/notify'

export const runtime = 'nodejs'

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || undefined : undefined)

// POST /api/booking/[token]/confirm-return — customer confirms (or pushes back on)
// the return date for a multi-day / continued job.
//   mode 'confirm': the proposed return date/window works — lock it in.
//   mode 'request': ask for a different return date (ops coordinates a new one).
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  if (await rateLimit(req, 'confirmreturn', 10, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }

  const b = await getBookingByToken(token)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (b.status !== 'continued' || !b.continuation) {
    return NextResponse.json({ error: 'There is no return visit to confirm on this booking.' }, { status: 409 })
  }

  const body = await req.json().catch(() => ({}))

  if (body.mode === 'request') {
    const requestedDate = clean(body.requestedDate, 20)
    const note = clean(body.note, 500)
    if (!requestedDate && !note) {
      return NextResponse.json({ error: 'Tell us what date works better for you.' }, { status: 400 })
    }
    b.continuation.returnChangeRequest = { requestedDate, note, at: Date.now() }
    b.continuation.customerConfirmedReturn = false
    b.continuation.customerConfirmedReturnAt = undefined
    await saveBooking(b)
    await notifyReturnChangeRequest(b)
    return NextResponse.json({ ok: true, requested: true, booking: customerView(b) })
  }

  // mode 'confirm' — the proposed return date works.
  b.continuation.customerConfirmedReturn = true
  b.continuation.customerConfirmedReturnAt = Date.now()
  b.continuation.returnChangeRequest = undefined
  await saveBooking(b)
  await notifyReturnConfirmed(b)
  return NextResponse.json({ ok: true, confirmed: true, booking: customerView(b) })
})
