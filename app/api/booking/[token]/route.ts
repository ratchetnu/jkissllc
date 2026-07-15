import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { getBookingByToken, saveBooking, customerView } from '../../../lib/bookings'
import { getCurrentPolicy, getPolicyVersion } from '../../../lib/policy'
import { emailOpsBookingViewed } from '../../../lib/booking-emails'
import { resolveTenantFromResource } from '../../../lib/platform/tenancy/tenant-resolve'
import { runWithTenant } from '../../../lib/platform/tenancy/context'

// GET /api/booking/[token] — customer-safe booking + the policy to display.
// Also records the first view (chargeback evidence) without leaking internals.
export const GET = withTenantRoute(async (_req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
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

  // Tenant is derived from the RECORD the unguessable token binds to — never from a
  // client param/query/body. Fail closed when tenancy is on and the record has no
  // binding; reference tenant (no-op) while TENANCY_ENABLED=false → response
  // unchanged. Booking has no tenantId field yet; the cast lets the resolver read it
  // once bindings exist (today undefined → fallback off / fail-closed on).
  const resolution = resolveTenantFromResource(booking as { tenantId?: string | null }, { kind: 'booking', correlationId: token })
  if (!resolution) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return runWithTenant({ tenantId: resolution.tenantId }, async () => {

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
  })
})
