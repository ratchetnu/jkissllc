import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { getBookingByToken, saveBooking, customerView } from '../../../../lib/bookings'
import { rateLimit } from '../../../../lib/rate-limit'
import { notifyReturnConfirmed, notifyReturnChangeRequest } from '../../../../lib/notify'
import { resolveTenantFromResource } from '../../../../lib/platform/tenancy/tenant-resolve'
import { runWithTenant } from '../../../../lib/platform/tenancy/context'

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
  // Capture the narrowed (defined) continuation so TS keeps the narrowing inside the
  // tenant-scope closure below — same object reference, so mutations still persist via saveBooking.
  const continuation = b.continuation

  // Tenant is derived from the RECORD the unguessable token binds to — never from a
  // client param/query/body. Fail closed when tenancy is on and the record has no
  // binding; reference tenant (no-op) while TENANCY_ENABLED=false → response
  // unchanged. Booking has no tenantId field yet; the cast lets the resolver read it
  // once bindings exist (today undefined → fallback off / fail-closed on).
  const resolution = resolveTenantFromResource(b as { tenantId?: string | null }, { kind: 'booking', correlationId: token })
  if (!resolution) return NextResponse.json({ error: 'This booking is temporarily unavailable. Please try again shortly.' }, { status: 503 })
  return runWithTenant({ tenantId: resolution.tenantId }, async () => {

  const body = await req.json().catch(() => ({}))

  if (body.mode === 'request') {
    const requestedDate = clean(body.requestedDate, 20)
    const note = clean(body.note, 500)
    if (!requestedDate && !note) {
      return NextResponse.json({ error: 'Tell us what date works better for you.' }, { status: 400 })
    }
    continuation.returnChangeRequest = { requestedDate, note, at: Date.now() }
    continuation.customerConfirmedReturn = false
    continuation.customerConfirmedReturnAt = undefined
    await saveBooking(b)
    await notifyReturnChangeRequest(b)
    return NextResponse.json({ ok: true, requested: true, booking: customerView(b) })
  }

  // mode 'confirm' — the proposed return date works.
  continuation.customerConfirmedReturn = true
  continuation.customerConfirmedReturnAt = Date.now()
  continuation.returnChangeRequest = undefined
  await saveBooking(b)
  await notifyReturnConfirmed(b)
  return NextResponse.json({ ok: true, confirmed: true, booking: customerView(b) })
  })
})
