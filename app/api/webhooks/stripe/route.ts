import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { getStripe, stripeConfigured } from '../../../lib/stripe'
import { recordStripeSessionPayment } from '../../../lib/record-payment'
import { recordStripeInvoicePayment } from '../../../lib/route-invoices'
import { alert } from '../../../lib/alerts'
import { resolveTenantFromStripe } from '../../../lib/platform/tenancy/tenant-resolve'
import { withBackgroundTenant } from '../../../lib/platform/tenancy/request-context'
import { checkCapability } from '../../../lib/platform/capabilities/guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Stripe webhook — confirms booking payments server-side. The success-URL return
// path also records payments, so this is the durable backstop (recording is
// idempotent per session id).
export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!stripeConfigured() || !secret) {
    return NextResponse.json({ error: 'stripe not configured' }, { status: 503 })
  }

  const signature = req.headers.get('stripe-signature')
  if (!signature) return NextResponse.json({ error: 'missing signature' }, { status: 400 })

  const rawBody = await req.text()
  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret)
  } catch (err) {
    console.warn('[stripe-webhook] signature verification failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 })
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object as Stripe.Checkout.Session
      // Signature is verified (constructEvent above), so the metadata is trusted:
      // resolve the originating tenant from the tenantId stamped at session
      // creation. While tenancy is off this yields the reference tenant; when on
      // WITHOUT metadata it returns null → fail closed (skip + alert), never a
      // silent cross-tenant write.
      const resolution = resolveTenantFromStripe(session.metadata, { correlationId: event.id })
      if (!resolution) {
        await alert({
          type: 'stripe_webhook_tenant_unresolved', severity: 'ERROR', route: '/api/webhooks/stripe',
          errorClass: 'missing_tenant_metadata', correlationId: event.id,
          meta: { eventType: event.type, sessionId: session.id },
        }).catch(alertErr => console.error('[stripe-webhook] tenant alert failed:', alertErr))
      } else {
        // Run the recorder (and its downstream redis/audit/notify writes) inside
        // the resolved tenant scope so record-payment inherits tenant context.
        await withBackgroundTenant('webhook', async () => {
          // ── Deliberate carve-out from the disabled-capability webhook policy ──
          //
          // The sibling webhooks (inbound SMS, inbound email) DISCARD an
          // authenticated event when the capability is off, because an inbound
          // message is new work being pushed at us. A checkout completion is the
          // opposite: it is the confirmation of a charge THIS deployment created,
          // against a card the customer has already been debited. Dropping it does
          // not decline anything — the money has moved either way; it only loses our
          // record of it, leaving a paid booking marked unpaid.
          //
          // So a VERIFIED payment confirmation is always recorded, even if the owner
          // switched card payments off while a checkout was in flight. What the
          // capability state changes is the ALERT: an arriving payment for a channel
          // nobody expects to be live is worth a human look.
          const cardPayments = await checkCapability('payments-stripe')
          if (cardPayments.state !== 'ready') {
            await alert({
              type: 'stripe_payment_while_capability_off', severity: 'ERROR', route: '/api/webhooks/stripe',
              errorClass: cardPayments.code, correlationId: event.id,
              meta: { eventType: event.type, sessionId: session.id, capabilityState: cardPayments.state },
            }).catch(alertErr => console.error('[stripe-webhook] capability alert failed:', alertErr))
          }
          // Re-fetch to be sure payment_status is current.
          const full = await getStripe().checkout.sessions.retrieve(session.id)
          // Dispatch by lane: a B2B route-invoice session carries invoiceToken and is
          // marked paid via the idempotent invoice recorder (this webhook is its durable
          // backstop — previously only the success-URL return path marked it, so closing
          // the tab could leave a paid invoice unmarked); everything else is a booking.
          if (full.metadata?.invoiceToken) {
            await recordStripeInvoicePayment(full)
          } else {
            await recordStripeSessionPayment(full)
          }
        }, resolution.tenantId)
      }
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err)
    // Surface the failure to the alert pipeline. SAFE fields only — the event
    // type and Stripe object id (session/paymentIntent), NEVER card data — and
    // alert() is fail-soft, so a broken alert path can't break the webhook.
    const obj = event.data.object as unknown as { id?: string; payment_intent?: string }
    try {
      await alert({
        type: 'stripe_webhook_failed', severity: 'ERROR', route: '/api/webhooks/stripe',
        errorClass: err instanceof Error ? err.name : 'unknown',
        correlationId: event.id,
        meta: {
          eventType: event.type,
          ...(obj?.id ? { sessionId: obj.id } : {}),
          ...(typeof obj?.payment_intent === 'string' ? { paymentIntent: obj.payment_intent } : {}),
        },
      })
    } catch (alertErr) {
      console.error('[stripe-webhook] alert failed:', alertErr)
    }
    // 200 anyway — the return-path/idempotent recorder will reconcile, and we
    // don't want Stripe to hammer retries on a transient KV blip.
  }

  return NextResponse.json({ received: true })
}
