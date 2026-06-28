import { NextRequest, NextResponse } from 'next/server'
import {
  getBookingByToken, balanceDueCents, fmtUSD,
  SERVICE_LABELS, type PaymentType,
} from '../../../../lib/bookings'
import { getStripe, stripeConfigured, grossUp } from '../../../../lib/stripe'
import { rateLimit } from '../../../../lib/rate-limit'
import { siteUrl } from '../../../../lib/booking-emails'

export const runtime = 'nodejs'

// POST /api/booking/[token]/pay — start a Stripe Checkout for deposit / balance
// / full. Card payments are grossed up so J Kiss nets the invoice amount.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (await rateLimit(req, 'bookingpay', 12, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }
  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'Card payments are not available right now — please use Zelle or Apple Pay below.' }, { status: 503 })
  }

  const b = await getBookingByToken(token)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (b.status === 'cancelled') return NextResponse.json({ error: 'This booking has been cancelled.' }, { status: 409 })

  const body = await req.json().catch(() => ({}))
  const kind = (['deposit', 'balance', 'full'].includes(body.kind) ? body.kind : 'balance') as 'deposit' | 'balance' | 'full'

  const balance = balanceDueCents(b)
  let net: number
  let type: PaymentType
  if (kind === 'deposit') {
    // When the final invoice isn't set yet (instant online bookings, invoice=0),
    // the deposit isn't capped by the (zero) balance — let them pay the deposit.
    net = b.invoiceAmountCents === 0
      ? Math.max(0, b.depositAmountCents - b.amountPaidCents)
      : Math.max(0, Math.min(b.depositAmountCents - b.amountPaidCents, balance))
    type = 'deposit'
  } else {
    net = balance
    type = kind === 'full' ? 'full' : 'balance'
  }
  if (net <= 0) return NextResponse.json({ error: 'There is no balance due on this booking.' }, { status: 400 })

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
            name: `J Kiss LLC — ${SERVICE_LABELS[b.serviceType]} (${b.bookingNumber})`,
            description: `${kind === 'deposit' ? 'Deposit' : kind === 'full' ? 'Full balance' : 'Balance'} ${fmtUSD(net)} + ${fmtUSD(feeCents)} card processing fee`,
          },
        },
      }],
      customer_email: b.customerEmail || undefined,
      success_url: `${base}/api/booking/${b.token}/stripe-return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/booking/${b.token}?pay=cancelled`,
      metadata: {
        bookingToken: b.token,
        bookingNumber: b.bookingNumber,
        paymentType: type,
        invoiceAmountCents: String(net),
        feeCents: String(feeCents),
      },
    })
    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error('[booking/pay]', err)
    return NextResponse.json({ error: 'Could not start checkout. Please try again or use Zelle/Apple Pay.' }, { status: 500 })
  }
}
