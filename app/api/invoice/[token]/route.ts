// PUBLIC invoice API — the token IS the credential. Returns a scrubbed invoice
// (no route tokens / internal ids) and starts a Stripe Checkout for the balance.
import { NextRequest, NextResponse } from 'next/server'
import { withPublicTokenRoute } from '../../../lib/platform/tenancy/with-public-token-route'
import { getInvoiceByToken, subtotalCents, balanceCents } from '../../../lib/route-invoices'
import { COMPANY } from '../../../lib/company'
import { getStripe, stripeConfigured, requireCardPayments, grossUp } from '../../../lib/stripe'
import { CapabilityUnavailableError, capabilityErrorBody } from '../../../lib/platform/capabilities/guard'
import { siteUrl } from '../../../lib/booking-emails'
import { rateLimit } from '../../../lib/rate-limit'
import { resolveTenantFromResource, tenantIdForOutboundMetadata } from '../../../lib/platform/tenancy/tenant-resolve'
import { runWithTenant } from '../../../lib/platform/tenancy/context'

export const runtime = 'nodejs'

function publicView(inv: NonNullable<Awaited<ReturnType<typeof getInvoiceByToken>>>) {
  return {
    invoiceNumber: inv.invoiceNumber,
    businessName: inv.businessName,
    clientName: inv.clientName,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    lines: inv.lines.map(l => ({ routeNumber: l.routeNumber, routeDate: l.routeDate, description: l.description, amountCents: l.amountCents })),
    notes: inv.notes,
    status: inv.status,
    subtotalCents: subtotalCents(inv),
    amountPaidCents: inv.amountPaidCents,
    balanceCents: balanceCents(inv),
    paidAt: inv.paidAt,
    stripeConfigured: stripeConfigured(),
  }
}

export const GET = withPublicTokenRoute(async (_req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const inv = await getInvoiceByToken(token)
  if (!inv || inv.status === 'void') return NextResponse.json({ error: 'not_found' }, { status: 404 })
  // Tenant is derived from the RECORD the unguessable token binds to — never from a
  // client param/query/body. Fail closed when tenancy is on and the record has no
  // binding; reference tenant (no-op) while TENANCY_ENABLED=false → response
  // unchanged. Invoice has no tenantId field yet; the cast lets the resolver read it
  // once bindings exist (today undefined → fallback off / fail-closed on).
  const resolution = resolveTenantFromResource(inv as { tenantId?: string | null }, { kind: 'invoice', correlationId: token })
  if (!resolution) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return runWithTenant({ tenantId: resolution.tenantId }, async () =>
    NextResponse.json({ invoice: publicView(inv) }),
  )
}, { expect: 'route-invoice' })

export const POST = withPublicTokenRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  if (await rateLimit(req, 'invoicepay', 12, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }
  const inv = await getInvoiceByToken(token)
  if (!inv || inv.status === 'void') return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (inv.status === 'paid' || balanceCents(inv) <= 0) return NextResponse.json({ error: 'This invoice is already paid.' }, { status: 409 })

  // Tenant is derived from the RECORD the unguessable token binds to — never from a
  // client param/query/body. Fail closed when tenancy is on and the record has no
  // binding; reference tenant (no-op) while TENANCY_ENABLED=false → response
  // unchanged. Invoice has no tenantId field yet; the cast lets the resolver read it
  // once bindings exist (today undefined → fallback off / fail-closed on).
  const resolution = resolveTenantFromResource(inv as { tenantId?: string | null }, { kind: 'invoice', correlationId: token })
  if (!resolution) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return runWithTenant({ tenantId: resolution.tenantId }, async () => {

  // Card-payment capability gate, inside the invoice's own tenant scope. An invoice
  // is a RECORD and remains payable by every offline method when this is off — which
  // is why the refusal names an alternative instead of reporting a failure.
  try {
    await requireCardPayments()
  } catch (err) {
    if (err instanceof CapabilityUnavailableError) {
      return NextResponse.json({
        ...capabilityErrorBody(err),
        error: `Card payment isn’t available for this invoice — contact ${COMPANY.legalName} to pay.`,
      }, { status: err.httpStatus })
    }
    throw err
  }

  const net = balanceCents(inv)
  const { feeCents, totalCents } = grossUp(net)
  try {
    const stripe = getStripe()
    const base = siteUrl()
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: totalCents,
          product_data: {
            name: `${COMPANY.legalName} — Invoice ${inv.invoiceNumber}`,
            description: `${inv.businessName} · balance ${(net / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} + ${(feeCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} card processing fee`,
          },
        },
      }],
      customer_email: inv.clientEmail || undefined,
      success_url: `${base}/api/invoice/${inv.token}/stripe-return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/invoice/${inv.token}?pay=cancelled`,
      metadata: {
        invoiceToken: inv.token, invoiceNumber: inv.invoiceNumber, netCents: String(net), feeCents: String(feeCents),
        // Stamp the originating tenant so the (session-less) webhook backstop can
        // resolve this route-invoice session via resolveTenantFromStripe — matching
        // the booking pay route. Returns 'jkiss' while TENANCY_ENABLED=false.
        tenantId: tenantIdForOutboundMetadata(),
      },
    })
    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error('[invoice/pay]', err)
    return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 500 })
  }
  })
}, { expect: 'route-invoice' })
