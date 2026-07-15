import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { COMPANY } from '../../../../lib/company'
import { getBookingByToken, saveBooking, customerView, hoursUntilService, cancellationTier } from '../../../../lib/bookings'
import { rateLimit } from '../../../../lib/rate-limit'
import { notifyCancelledByCustomer } from '../../../../lib/notify'
import { resolveTenantFromResource } from '../../../../lib/platform/tenancy/tenant-resolve'
import { runWithTenant } from '../../../../lib/platform/tenancy/context'

// POST /api/booking/[token]/cancel — customer self-cancels, applying the policy's
// refund tier by how much notice they gave. Requires an explicit confirm flag.
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  if (await rateLimit(req, 'bookingcancel', 8, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }

  const b = await getBookingByToken(token)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (b.status === 'cancelled') return NextResponse.json({ error: 'This booking is already cancelled.' }, { status: 409 })
  if (b.status === 'completed') return NextResponse.json({ error: 'This service is complete — please call us at ' + COMPANY.phoneDisplay + '.' }, { status: 409 })

  // Tenant is derived from the RECORD the unguessable token binds to — never from a
  // client param/query/body. Fail closed when tenancy is on and the record has no
  // binding; reference tenant (no-op) while TENANCY_ENABLED=false → response
  // unchanged. Booking has no tenantId field yet; the cast lets the resolver read it
  // once bindings exist (today undefined → fallback off / fail-closed on).
  const resolution = resolveTenantFromResource(b as { tenantId?: string | null }, { kind: 'booking', correlationId: token })
  if (!resolution) return NextResponse.json({ error: 'This booking is temporarily unavailable. Please try again shortly.' }, { status: 503 })
  return runWithTenant({ tenantId: resolution.tenantId }, async () => {

  const body = await req.json().catch(() => ({}))
  const now = Date.now()
  const tier = cancellationTier(hoursUntilService(b, now), false)

  // Two-step: GET-style preview (no confirm) returns the tier so the UI can warn first.
  if (body.confirm !== true) {
    return NextResponse.json({ ok: false, needsConfirm: true, tier })
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
  const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
  b.status = 'cancelled'
  b.cancelledAt = now
  b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] CANCELLED by customer · ${tier.tier} (${tier.depositRefundPct}% deposit refundable)${reason ? ` · ${reason}` : ''}`
  await saveBooking(b)
  await notifyCancelledByCustomer(b, tier.label)

  return NextResponse.json({ ok: true, tier, booking: customerView(b) })
  })
})
