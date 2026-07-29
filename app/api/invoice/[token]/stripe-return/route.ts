import { NextRequest, NextResponse } from 'next/server'
import { withPublicTokenRoute } from '../../../../lib/platform/tenancy/with-public-token-route'
import { getStripe, stripeConfigured } from '../../../../lib/stripe'
import { getInvoiceByToken, recordStripeInvoicePayment } from '../../../../lib/route-invoices'
import { siteUrl } from '../../../../lib/booking-emails'

export const runtime = 'nodejs'

// Stripe success redirect. Retrieve the session, mark the invoice paid
// (idempotent), then bounce back to the invoice page.
export const GET = withPublicTokenRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const base = siteUrl()
  const sessionId = new URL(req.url).searchParams.get('session_id')

  if (sessionId && stripeConfigured()) {
    try {
      const stripe = getStripe()
      const session = await stripe.checkout.sessions.retrieve(sessionId)
      const inv = await getInvoiceByToken(token)
      // WAVE 6D-B — the tenant now comes from the TOKEN BINDING, which
      // withPublicTokenRoute has already resolved and entered before this handler ran.
      // It used to call resolveTenantFromResource(inv), but an invoice record has no
      // tenantId field, so under tenancy that resolved to null and the mark-paid was
      // silently SKIPPED — a paid invoice would never have been marked. Reading the
      // ambient context instead is both correct and the only trusted source here.
      //
      // The Stripe trust boundary is UNCHANGED and must stay that way: the session is
      // fetched from Stripe with our secret key (so its contents are Stripe-verified,
      // never caller-supplied), it must NAME this invoice in metadata, and
      // recordStripeInvoicePayment is idempotent — no-op on void / already-paid /
      // unpaid / replayed. The public token alone authorizes nothing: without a real
      // Stripe session naming this invoice, no financial state changes.
      if (inv && session.metadata?.invoiceToken === token) {
        await recordStripeInvoicePayment(session)
      }
    } catch (err) {
      console.error('[invoice stripe-return]', err)
    }
  }
  return NextResponse.redirect(`${base}/invoice/${token}?paid=1`)
}, { expect: 'route-invoice' })
