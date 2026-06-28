import type Stripe from 'stripe'
import {
  getBookingByToken, saveBooking, recompute, paymentSummaryStatus,
  type Booking, type Payment, type PaymentType,
} from './bookings'
import { emailOpsPaymentReceived, emailPaymentReceiptCustomer } from './booking-emails'
import { notifyBookingConfirmed, notifyPaidInFull } from './notify'
import { ensureLoyaltyCode } from './promo'

// Record a paid Stripe Checkout Session against its booking. Idempotent: a
// session is only ever applied once (deduped by session id), so the webhook and
// the success-URL return path can both call this safely.
export async function recordStripeSessionPayment(session: Stripe.Checkout.Session): Promise<Booking | null> {
  const token = session.metadata?.bookingToken
  if (!token) return null
  const b = await getBookingByToken(token)
  if (!b) return null

  if (b.payments.some(p => p.stripeSessionId === session.id)) return b // already applied
  if (session.payment_status !== 'paid') return b

  const amountCents = parseInt(session.metadata?.invoiceAmountCents ?? '0', 10) || 0
  const feeCents = parseInt(session.metadata?.feeCents ?? '0', 10) || 0
  const totalCents = session.amount_total ?? amountCents + feeCents
  const type = (session.metadata?.paymentType as PaymentType) || 'partial'
  const pi = session.payment_intent
  const now = Date.now()

  const wasConfirmed = b.status === 'confirmed'
  const wasPaidInFull = paymentSummaryStatus(b) === 'paid_in_full'
  const payment: Payment = {
    id: crypto.randomUUID(),
    type, method: 'stripe', status: 'confirmed',
    amountCents, feeCents, totalChargedCents: totalCents, netCents: amountCents,
    stripeSessionId: session.id,
    stripePaymentIntentId: typeof pi === 'string' ? pi : pi?.id,
    createdAt: now, confirmedAt: now,
  }
  b.payments.push(payment)
  recompute(b)
  const nowPaidInFull = !wasPaidInFull && paymentSummaryStatus(b) === 'paid_in_full'
  if (nowPaidInFull && !b.loyaltyCode) {
    try { b.loyaltyCode = await ensureLoyaltyCode(b.token, b.bookingNumber, Date.now()) } catch (e) { console.error('[loyalty]', e) }
  }
  await saveBooking(b)

  await emailOpsPaymentReceived(b, payment)
  await emailPaymentReceiptCustomer(b, payment)
  if (!wasConfirmed && b.status === 'confirmed') await notifyBookingConfirmed(b)
  if (nowPaidInFull) await notifyPaidInFull(b)
  return b
}
