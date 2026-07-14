import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { getStripe, stripeConfigured } from '../../../../lib/stripe'
import { recordStripeSessionPayment } from '../../../../lib/record-payment'
import { siteUrl } from '../../../../lib/booking-emails'

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
        await recordStripeSessionPayment(session)
      }
    } catch (err) {
      console.error('[stripe-return]', err)
    }
  }
  return NextResponse.redirect(`${base}/booking/${token}?paid=1`)
})
