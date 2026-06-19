import { NextRequest, NextResponse } from 'next/server'
import {
  getBookingByToken, saveBooking, customerView, dollarsToCents,
  type Payment, type PaymentMethod, type PaymentType,
} from '../../../../lib/bookings'
import { rateLimit } from '../../../../lib/rate-limit'
import { emailOpsManualPaymentSubmitted } from '../../../../lib/booking-emails'

const METHODS: PaymentMethod[] = ['zelle', 'apple_cash', 'cash', 'other']

// POST /api/booking/[token]/manual-payment — customer reports a Zelle / Apple
// Cash payment. Recorded as 'sent_by_customer' (pending) until an admin confirms.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (await rateLimit(req, 'bookingmanualpay', 8, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }

  const b = await getBookingByToken(token)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (b.status === 'cancelled') return NextResponse.json({ error: 'This booking has been cancelled.' }, { status: 409 })

  const body = await req.json().catch(() => ({}))
  const amountCents = dollarsToCents(body.amount)
  if (amountCents <= 0) return NextResponse.json({ error: 'Enter the amount you sent.' }, { status: 400 })
  const method = (METHODS.includes(body.method) ? body.method : 'other') as PaymentMethod
  const type = (['deposit', 'balance', 'full', 'partial'].includes(body.type) ? body.type : 'partial') as PaymentType

  const payment: Payment = {
    id: crypto.randomUUID(),
    type, method, status: 'sent_by_customer',
    amountCents, feeCents: 0, totalChargedCents: amountCents, netCents: amountCents,
    reference: typeof body.reference === 'string' ? body.reference.trim().slice(0, 120) : undefined,
    note: typeof body.dateSent === 'string' ? `Customer reported sent: ${body.dateSent.trim().slice(0, 40)}` : undefined,
    createdAt: Date.now(),
  }
  b.payments.push(payment)
  await saveBooking(b)
  await emailOpsManualPaymentSubmitted(b, payment)

  return NextResponse.json({ ok: true, booking: customerView(b) })
}
