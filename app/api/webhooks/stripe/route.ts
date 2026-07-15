import { NextRequest, NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { getStripe, stripeConfigured } from '../../../lib/stripe'
import { recordStripeSessionPayment } from '../../../lib/record-payment'
import { alert } from '../../../lib/alerts'

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
      // Re-fetch to be sure payment_status is current.
      const full = await getStripe().checkout.sessions.retrieve(session.id)
      await recordStripeSessionPayment(full)
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
