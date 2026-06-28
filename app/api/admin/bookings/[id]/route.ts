import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import {
  getBookingByToken, saveBooking, deleteBooking, recompute, balanceDueCents, dollarsToCents,
  paymentSummaryStatus, sanitizePhotos,
  SERVICE_TYPES, type Booking, type ServiceType, type Payment, type PaymentMethod, type PaymentType,
  type BookingStatus,
} from '../../../../lib/bookings'
import { getPolicyVersion, getCurrentPolicy } from '../../../../lib/policy'
import { sendConfirmationLink, notifyJobCompleted, notifyBookingConfirmed, notifyPaidInFull } from '../../../../lib/notify'
import { emailOpsPaymentReceived, emailPaymentReceiptCustomer, emailRefundCustomer } from '../../../../lib/booking-emails'
import { str, strList, num } from '../../../../lib/validators'
import { ensureLoyaltyCode } from '../../../../lib/promo'
import { getStripe, stripeConfigured } from '../../../../lib/stripe'

export const runtime = 'nodejs'

const METHODS: PaymentMethod[] = ['stripe', 'zelle', 'apple_cash', 'cash', 'other']

function addConfirmedPayment(b: Booking, p: { amountCents: number; method: PaymentMethod; type: PaymentType; note?: string; reference?: string }): Payment {
  const now = Date.now()
  const payment: Payment = {
    id: crypto.randomUUID(),
    type: p.type, method: p.method, status: 'confirmed',
    amountCents: p.amountCents, feeCents: 0, totalChargedCents: p.amountCents, netCents: p.amountCents,
    note: p.note, reference: p.reference,
    createdAt: now, confirmedAt: now,
  }
  b.payments.push(payment)
  return payment
}

// GET — full booking (admin sees everything: payments, internal notes, the IP /
// UA agreement audit trail) plus the exact accepted policy text for evidence.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const b = await getBookingByToken(id)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const policy = b.agreementPolicyVersion
    ? (await getPolicyVersion(b.agreementPolicyVersion)) ?? (await getCurrentPolicy())
    : null
  return NextResponse.json({ booking: b, acceptedPolicy: policy })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  await deleteBooking(id)
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const b = await getBookingByToken(id)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const action: string = body.action ?? 'update'
  const wasConfirmed = b.status === 'confirmed'
  const wasPaidInFull = paymentSummaryStatus(b) === 'paid_in_full'
  let extra: Record<string, unknown> = {}
  let refundedNowCents = 0

  switch (action) {
    case 'update': {
      const f = body.fields ?? body
      if (str(f.customerName, 200)) b.customerName = str(f.customerName, 200)!
      if ('customerPhone' in f) b.customerPhone = str(f.customerPhone, 40)
      if ('customerEmail' in f) b.customerEmail = str(f.customerEmail, 200)
      if ('invoiceNumber' in f) b.invoiceNumber = str(f.invoiceNumber, 60)
      if ('invoiceDate' in f) b.invoiceDate = str(f.invoiceDate, 40)
      if (f.serviceType && SERVICE_TYPES.includes(f.serviceType)) b.serviceType = f.serviceType as ServiceType
      if ('pickupAddress' in f) b.pickupAddress = str(f.pickupAddress, 300)
      if ('dropoffAddress' in f) b.dropoffAddress = str(f.dropoffAddress, 300)
      if ('jobSiteAddress' in f) b.jobSiteAddress = str(f.jobSiteAddress, 300)
      if ('description' in f) b.description = str(f.description, 2000)
      if ('items' in f) b.items = strList(f.items, 80)
      if ('invoicePhotos' in f) b.invoicePhotos = sanitizePhotos(f.invoicePhotos)
      if ('invoiceAmount' in f) b.invoiceAmountCents = dollarsToCents(f.invoiceAmount)
      if ('discountAmount' in f) b.discountCents = dollarsToCents(f.discountAmount) || undefined
      if ('depositAmount' in f) b.depositAmountCents = dollarsToCents(f.depositAmount)
      if ('crewSize' in f) b.crewSize = num(f.crewSize)
      if ('estimatedHours' in f) b.estimatedHours = num(f.estimatedHours)
      if ('availableDates' in f) b.availableDates = strList(f.availableDates, 60)
      if ('availableWindows' in f) b.availableWindows = strList(f.availableWindows, 20)
      if ('selectedDate' in f) b.selectedDate = str(f.selectedDate, 20)
      if ('selectedWindow' in f) b.selectedWindow = str(f.selectedWindow, 40)
      if ('internalNotes' in f) b.internalNotes = str(f.internalNotes, 2000)
      if ('assignedTo' in f) b.assignedTo = str(f.assignedTo, 80)
      if ('assignedHelper' in f) b.assignedHelper = str(f.assignedHelper, 80)
      if ('disposalEstimate' in f) b.disposalEstimateCents = dollarsToCents(f.disposalEstimate) || undefined
      if ('disposalActual' in f) b.disposalActualCents = dollarsToCents(f.disposalActual) || undefined
      if ('collectInPerson' in f) b.collectInPerson = f.collectInPerson === true || f.collectInPerson === 'true' || f.collectInPerson === 'on'
      if (f.status && (Object.keys(STATUS_SET) as BookingStatus[]).includes(f.status)) b.status = f.status as BookingStatus
      break
    }
    case 'send-link': {
      const channels = await sendConfirmationLink(b)
      b.confirmationLinkSentAt = Date.now()
      b.confirmationLinkSentBy = 'admin'
      if (['quote_received', 'pending_payment', 'payment_received', 'booking_created'].includes(b.status)) {
        b.status = 'confirmation_link_sent'
      }
      extra = { channels }
      break
    }
    case 'confirm-payment': {
      // Confirm a customer-reported (pending) manual payment.
      const p = b.payments.find(x => x.id === body.paymentId)
      if (!p) return NextResponse.json({ error: 'payment not found' }, { status: 404 })
      if (p.status === 'confirmed') return NextResponse.json({ error: 'Already confirmed.' }, { status: 400 })
      p.status = 'confirmed'
      p.confirmedAt = Date.now()
      if (str(body.note, 500)) p.note = `${p.note ? p.note + ' · ' : ''}${str(body.note, 500)}`
      await sendReceipts(b, p)
      break
    }
    case 'void-payment': {
      // Remove a payment record (e.g. a customer re-reported a payment that was
      // already recorded — confirming it would double-count). Recompute drops it
      // from Amount Paid. Logged to the audit trail for chargeback evidence.
      const idx = b.payments.findIndex(x => x.id === body.paymentId)
      if (idx === -1) return NextResponse.json({ error: 'payment not found' }, { status: 404 })
      const [removed] = b.payments.splice(idx, 1)
      const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      const why = str(body.reason, 200)
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] Voided payment: $${(removed.amountCents / 100).toFixed(2)} · ${removed.method} · ${removed.type} · ${removed.status}${why ? ` — ${why}` : ''}`
      break
    }
    case 'record-payment':
    case 'mark-deposit-paid':
    case 'mark-balance-paid':
    case 'mark-paid-full': {
      const method = (METHODS.includes(body.method) ? body.method : 'cash') as PaymentMethod
      const balance = balanceDueCents(b)
      let amountCents: number
      let type: PaymentType
      if (action === 'mark-deposit-paid') {
        amountCents = Math.max(0, Math.min(b.depositAmountCents - b.amountPaidCents, balance)); type = 'deposit'
      } else if (action === 'mark-paid-full') {
        amountCents = balance; type = 'full'
      } else if (action === 'mark-balance-paid') {
        amountCents = balance; type = 'balance'
      } else {
        amountCents = dollarsToCents(body.amount); type = (['deposit', 'balance', 'full', 'partial'].includes(body.type) ? body.type : 'partial')
      }
      if (amountCents <= 0) return NextResponse.json({ error: 'Nothing due / invalid amount.' }, { status: 400 })
      // Block accidental double-entry of the same manual payment (same reference).
      const ref = str(body.reference, 120)
      if (ref && b.payments.some(p => p.reference === ref && p.status === 'confirmed')) {
        return NextResponse.json({ error: `A payment with reference "${ref}" is already recorded.` }, { status: 409 })
      }
      const p = addConfirmedPayment(b, { amountCents, method, type, reference: ref, note: str(body.note, 500) })
      await sendReceipts(b, p)
      break
    }
    case 'send-receipt': {
      // Re-send the final paid receipt link (email + SMS if configured). Useful
      // when SMS isn't available yet and the link must go out manually too.
      if (paymentSummaryStatus(b) !== 'paid_in_full') {
        return NextResponse.json({ error: 'The paid receipt is available once the invoice is paid in full.' }, { status: 400 })
      }
      const channels = await notifyPaidInFull(b)
      extra = { channels }
      break
    }
    case 'mark-completed': {
      // Guard accounting: a job shouldn't be completed with no invoice total set
      // (e.g. an instant online booking still showing $0 until ops prices it).
      if (b.invoiceAmountCents <= 0) {
        return NextResponse.json({ error: 'Set the final invoice amount before marking this job completed.' }, { status: 400 })
      }
      b.status = 'completed'
      b.completedAt = Date.now()
      break
    }
    case 'cancel': {
      b.status = 'cancelled'
      b.cancelledAt = Date.now()
      if (str(body.reason, 500)) b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[CANCELLED] ${str(body.reason, 500)}`
      break
    }
    case 'add-note': {
      const note = str(body.note, 1000)
      if (!note) return NextResponse.json({ error: 'note required' }, { status: 400 })
      const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] ${note}`
      break
    }
    case 'archive': {
      b.archived = true
      b.archivedAt = Date.now()
      break
    }
    case 'unarchive': {
      b.archived = false
      b.archivedAt = undefined
      break
    }
    case 'assign': {
      if ('assignedTo' in body) b.assignedTo = str(body.assignedTo, 80)
      if ('assignedHelper' in body) b.assignedHelper = str(body.assignedHelper, 80)
      break
    }
    case 'set-disposal': {
      if ('disposalEstimate' in body) b.disposalEstimateCents = dollarsToCents(body.disposalEstimate) || undefined
      if ('disposalActual' in body) b.disposalActualCents = dollarsToCents(body.disposalActual) || undefined
      break
    }
    case 'refund': {
      // One-click Stripe refund for the eligible amount. Records a negative payment
      // so Amount Paid drops, and emails the customer. Zelle/cash refunds are manual.
      const refundCents = dollarsToCents(body.amount)
      if (refundCents <= 0) return NextResponse.json({ error: 'Enter a refund amount.' }, { status: 400 })
      if (!stripeConfigured()) return NextResponse.json({ error: 'Stripe is not configured — refund manually for Zelle/cash.' }, { status: 503 })

      const stripePaid = b.payments.filter(p => p.method === 'stripe' && p.status === 'confirmed' && p.amountCents > 0 && p.stripePaymentIntentId)
      if (stripePaid.length === 0) return NextResponse.json({ error: 'No Stripe payment to refund here — issue Zelle/cash refunds manually and use Void if needed.' }, { status: 400 })
      // Per-intent already-refunded (refund records carry their intent).
      const refundedByIntent = new Map<string, number>()
      for (const p of b.payments) if (p.amountCents < 0 && p.stripePaymentIntentId) refundedByIntent.set(p.stripePaymentIntentId, (refundedByIntent.get(p.stripePaymentIntentId) ?? 0) - p.amountCents)
      const availFor = (p: Payment) => p.amountCents - (refundedByIntent.get(p.stripePaymentIntentId!) ?? 0)
      const maxRefund = stripePaid.reduce((s, p) => s + Math.max(0, availFor(p)), 0)
      if (refundCents > maxRefund) return NextResponse.json({ error: `Max refundable on the Stripe charge${stripePaid.length > 1 ? 's' : ''} is $${(maxRefund / 100).toFixed(2)}.` }, { status: 400 })

      // Split the refund across charges (largest available first).
      const stripe = getStripe()
      let remaining = refundCents
      const ids: string[] = []
      try {
        for (const p of [...stripePaid].sort((a, c) => availFor(c) - availFor(a))) {
          if (remaining <= 0) break
          const amt = Math.min(remaining, Math.max(0, availFor(p)))
          if (amt <= 0) continue
          const refund = await stripe.refunds.create({ payment_intent: p.stripePaymentIntentId!, amount: amt })
          b.payments.push({
            id: crypto.randomUUID(), type: 'partial', method: 'stripe', status: 'confirmed',
            amountCents: -amt, feeCents: 0, totalChargedCents: -amt, netCents: -amt,
            stripePaymentIntentId: p.stripePaymentIntentId,
            note: 'Refund issued (Stripe)', reference: refund.id, createdAt: Date.now(), confirmedAt: Date.now(),
          })
          ids.push(refund.id); remaining -= amt
        }
      } catch (e) {
        console.error('[refund]', e)
        return NextResponse.json({ error: 'Stripe refund failed — check the dashboard and try again.' }, { status: 502 })
      }
      const stamp = new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })
      b.internalNotes = `${b.internalNotes ? b.internalNotes + '\n' : ''}[${stamp}] Refunded $${((refundCents - remaining) / 100).toFixed(2)} via Stripe (${ids.join(', ')})`
      extra = { refundIds: ids }
      refundedNowCents = refundCents - remaining
      break
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  if (action !== 'mark-completed' && action !== 'cancel') recompute(b)
  // Confirming a payment locks the booking in: if there's a single scheduled date
  // and the customer hasn't picked one yet, that date becomes the confirmed
  // service date (so it reads "confirmed" everywhere, not "awaiting customer").
  if (!b.selectedDate && b.amountPaidCents > 0 && b.availableDates.length === 1) {
    b.selectedDate = b.availableDates[0]
  }
  // On the transition to paid-in-full, issue a 10%-off loyalty/referral code (once)
  // before persisting so the receipt + email can show it.
  const nowPaidInFull = !wasPaidInFull && paymentSummaryStatus(b) === 'paid_in_full'
  if (nowPaidInFull && !b.loyaltyCode) {
    try { b.loyaltyCode = await ensureLoyaltyCode(b.token, b.bookingNumber, Date.now()) } catch (e) { console.error('[loyalty]', e) }
  }
  await saveBooking(b)

  // Side-effect notifications after persistence.
  if (action === 'refund' && refundedNowCents > 0) await emailRefundCustomer(b, refundedNowCents)
  if (action === 'mark-completed') await notifyJobCompleted(b)
  if (!wasConfirmed && b.status === 'confirmed' && action !== 'send-link') await notifyBookingConfirmed(b)
  // On the transition to paid-in-full, send the customer their final paid receipt
  // link (which carries the optional review prompt + their loyalty code).
  if (nowPaidInFull) await notifyPaidInFull(b)

  return NextResponse.json({ ok: true, booking: b, ...extra })
}

async function sendReceipts(b: Booking, p: Payment): Promise<void> {
  recompute(b)
  await emailOpsPaymentReceived(b, p)
  await emailPaymentReceiptCustomer(b, p)
}

const STATUS_SET: Record<BookingStatus, true> = {
  quote_received: true, pending_payment: true, payment_received: true, booking_created: true,
  confirmation_link_sent: true, customer_viewed: true, time_verification_pending: true,
  time_verified: true, confirmed: true, completed: true, cancelled: true,
}
