import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { getStripe, stripeConfigured } from '../../../../lib/stripe'
import { getInvoiceByToken, recordStripeInvoicePayment } from '../../../../lib/route-invoices'
import { siteUrl } from '../../../../lib/booking-emails'
import { resolveTenantFromResource } from '../../../../lib/platform/tenancy/tenant-resolve'
import { runWithTenant } from '../../../../lib/platform/tenancy/context'

export const runtime = 'nodejs'

// Stripe success redirect. Retrieve the session, mark the invoice paid
// (idempotent), then bounce back to the invoice page.
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const base = siteUrl()
  const sessionId = new URL(req.url).searchParams.get('session_id')

  if (sessionId && stripeConfigured()) {
    try {
      const stripe = getStripe()
      const session = await stripe.checkout.sessions.retrieve(sessionId)
      const inv = await getInvoiceByToken(token)
      // Tenant is derived from the loaded invoice RECORD (the token binds to exactly
      // one invoice) — never from a client value. Fail closed when tenancy is on and
      // the record has no binding; reference tenant (no-op) while TENANCY_ENABLED=
      // false → the mark-paid write runs exactly as today. Invoice has no tenantId
      // field yet; the cast lets the resolver read it once bindings exist.
      const resolution = inv ? resolveTenantFromResource(inv as { tenantId?: string | null }, { kind: 'invoice', correlationId: token }) : null
      // Guard that this session belongs to THIS invoice URL, then apply the SAME
      // idempotent transition the webhook backstop uses (recordStripeInvoicePayment):
      // it no-ops on void / already-paid / unpaid / replayed sessions.
      if (inv && resolution && session.metadata?.invoiceToken === token) {
        await runWithTenant({ tenantId: resolution.tenantId }, async () => {
          await recordStripeInvoicePayment(session)
        })
      }
    } catch (err) {
      console.error('[invoice stripe-return]', err)
    }
  }
  return NextResponse.redirect(`${base}/invoice/${token}?paid=1`)
})
