import type Stripe from 'stripe'
import {
  getBookingByToken, saveBooking, recompute, paymentSummaryStatus, pushBookingEvent,
  type Booking, type Payment, type PaymentType,
} from './bookings'
import { emailOpsPaymentReceived, emailPaymentReceiptCustomer } from './booking-emails'
import { notifyBookingConfirmed, notifyPaidInFull } from './notify'
import { notifyOwnerNewConfirmedBooking } from './booking-notify'
import { ensureLoyaltyCode } from './promo'
import { onPaymentCaptured } from './intake-workflow'

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
  pushBookingEvent(b, { actor: 'stripe', action: 'stripe.verified', result: 'paid', meta: { sessionId: session.id, amountCents } })
  recompute(b)
  const justConfirmed = !wasConfirmed && b.status === 'confirmed'
  if (justConfirmed) {
    pushBookingEvent(b, { actor: 'system', action: 'booking.confirmed', meta: { via: 'stripe' } })
    pushBookingEvent(b, { actor: 'system', action: 'customer.confirmation' })
  }
  const nowPaidInFull = !wasPaidInFull && paymentSummaryStatus(b) === 'paid_in_full'
  if (nowPaidInFull && !b.loyaltyCode) {
    try { b.loyaltyCode = await ensureLoyaltyCode(b.token, b.bookingNumber, Date.now()) } catch (e) { console.error('[loyalty]', e) }
  }
  await saveBooking(b)

  // Governed intake: publish PaymentReceived (+ DepositPaid/BookingCreated on first
  // confirm). Flag-gated + fail-soft — never affects payment capture or emails.
  await onPaymentCaptured(b, { amountCents, method: 'stripe', justConfirmed })

  // Sandbox records never send automatic customer/owner comms.
  if (!b.isTest) {
    await emailOpsPaymentReceived(b, payment)
    await emailPaymentReceiptCustomer(b, payment)
    if (justConfirmed) {
      await notifyBookingConfirmed(b)                                 // customer confirmation
      await notifyOwnerNewConfirmedBooking(b, payment).catch(e => console.error('[record-payment] owner notify', e))
    }
    if (nowPaidInFull) await notifyPaidInFull(b)
  }
  return b
}
