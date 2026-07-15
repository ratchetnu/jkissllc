import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { getStripe, stripeConfigured } from '../../../../lib/stripe'
import { recordStripeSessionPayment } from '../../../../lib/record-payment'
import { siteUrl } from '../../../../lib/booking-emails'
import { resolveTenantFromStripe } from '../../../../lib/platform/tenancy/tenant-resolve'
import { runWithTenant } from '../../../../lib/platform/tenancy/context'

export const runtime = 'nodejs'

// GET — Stripe success redirect lands here with ?session_id=. We retrieve the
// session, record the payment (idempotent), then bounce back to the booking
// page. This makes payments confirm immediately even before the webhook is set.
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const base = siteUrl()
  const sessionId = new URL(req.url).searchParams.get('session_id')

  if (sessionId && stripeConfigured()) {
    try {
      const stripe = getStripe()
      const session = await stripe.checkout.sessions.retrieve(sessionId)
      if (session.metadata?.bookingToken === token) {
        // This handler loads no Booking in-scope; the payment write happens inside
        // recordStripeSessionPayment against the AMBIENT tenant. Derive that tenant
        // from the Stripe session's stamped metadata — the same tenantId pay/route
        // stamps for the session-less webhook — since the session was fetched
        // server-to-server with our secret key, so its metadata is trusted (never a
        // client value). Fail closed when tenancy is on and no binding is present;
        // reference tenant (no-op) while TENANCY_ENABLED=false → behavior unchanged.
        const resolution = resolveTenantFromStripe(session.metadata, { correlationId: token })
        if (resolution) {
          await runWithTenant({ tenantId: resolution.tenantId }, () => recordStripeSessionPayment(session))
        }
      }
    } catch (err) {
      console.error('[stripe-return]', err)
    }
  }
  return NextResponse.redirect(`${base}/booking/${token}?paid=1`)
})
