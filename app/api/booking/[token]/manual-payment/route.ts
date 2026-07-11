import { NextRequest, NextResponse } from 'next/server'
import {
  getBookingByToken, saveBooking, customerView, dollarsToCents, recompute, pushBookingEvent,
  type Payment, type PaymentMethod, type PaymentType,
} from '../../../../lib/bookings'
import { rateLimit } from '../../../../lib/rate-limit'
import { emailOpsManualPaymentSubmitted } from '../../../../lib/booking-emails'
import { validateProofImage, sealAndStoreProof } from '../../../../lib/payment-proof'
import { notifyOwnerZelleReview } from '../../../../lib/booking-notify'

export const runtime = 'nodejs'

const METHODS: PaymentMethod[] = ['zelle', 'apple_cash', 'cash', 'other']

// POST /api/booking/[token]/manual-payment — customer reports an out-of-band payment.
// Zelle now REQUIRES a payment screenshot (sealed + owner-reviewed); apple_cash/cash
// remain lightweight self-reports. Recorded as 'sent_by_customer' (pending) until an
// admin verifies it — the balance never moves on an unverified proof.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (await rateLimit(req, 'bookingmanualpay', 8, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }

  const b = await getBookingByToken(token)
  if (!b) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (b.status === 'cancelled') return NextResponse.json({ error: 'This booking has been cancelled.' }, { status: 409 })

  const body = await req.json().catch(() => ({}))
  const method = (METHODS.includes(body.method) ? body.method : 'other') as PaymentMethod
  const type = (['deposit', 'balance', 'full', 'partial'].includes(body.type) ? body.type : 'partial') as PaymentType

  // ── Zelle: mandatory sealed screenshot + owner review ──────────────────────
  if (method === 'zelle') {
    // Is this a re-upload after a rejection (a one-time replacement grant)?
    const replaceToken = typeof body.replaceToken === 'string' ? body.replaceToken : ''
    const isReplacement = !!replaceToken && b.replacementUpload?.token === replaceToken && !b.replacementUpload?.usedAt

    // Block a duplicate submission while one is already awaiting review (unless it's
    // an authorized replacement).
    const pending = b.payments.find(p => p.method === 'zelle' && p.status === 'sent_by_customer' && !!p.proofPath)
    if (pending && !isReplacement) {
      return NextResponse.json({ error: 'You already uploaded a payment confirmation — it is under review. We’ll text you once it’s verified.' }, { status: 409 })
    }

    const v = validateProofImage(body.proofImage)
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

    let proofPath: string
    try { proofPath = await sealAndStoreProof(b.token, v.buf, v.ext) }
    catch (e) { console.error('[manual-payment] seal', e); return NextResponse.json({ error: 'We could not securely store your screenshot. Please try again.' }, { status: 500 }) }

    const now = Date.now()
    const amountCents = dollarsToCents(body.amount) || b.depositAmountCents
    if (amountCents <= 0) return NextResponse.json({ error: 'Enter the amount you sent.' }, { status: 400 })

    let payment: Payment
    if (isReplacement && pending) {
      // Keep the superseded proof for audit; swap in the new one.
      pending.proofHistory = [...(pending.proofHistory ?? []), { path: pending.proofPath!, at: pending.proofUploadedAt ?? now, replacedAt: now }]
      pending.proofPath = proofPath
      pending.proofUploadedAt = now
      pending.status = 'sent_by_customer'
      pending.rejectionReason = undefined
      payment = pending
      if (b.replacementUpload) b.replacementUpload.usedAt = now
      pushBookingEvent(b, { actor: 'customer', action: 'zelle.replacement_uploaded', meta: { paymentId: payment.id } })
    } else {
      payment = {
        id: crypto.randomUUID(),
        type, method: 'zelle', status: 'sent_by_customer',
        amountCents, feeCents: 0, totalChargedCents: amountCents, netCents: amountCents,
        reference: typeof body.reference === 'string' ? body.reference.trim().slice(0, 120) : undefined,
        note: typeof body.dateSent === 'string' ? `Customer reported sent: ${body.dateSent.trim().slice(0, 40)}` : undefined,
        proofPath, proofUploadedAt: now,
        createdAt: now,
      }
      b.payments.push(payment)
      pushBookingEvent(b, { actor: 'customer', action: 'zelle.uploaded', meta: { paymentId: payment.id, amountCents } })
    }
    recompute(b)   // → pending_zelle_verification
    await saveBooking(b)
    await emailOpsManualPaymentSubmitted(b, payment).catch(() => {})
    await notifyOwnerZelleReview(b, payment, { force: isReplacement }).catch(e => console.error('[manual-payment] owner notify', e))
    return NextResponse.json({ ok: true, booking: customerView(b) })
  }

  // ── Apple Cash / cash / other: lightweight self-report (unchanged) ─────────
  const amountCents = dollarsToCents(body.amount)
  if (amountCents <= 0) return NextResponse.json({ error: 'Enter the amount you sent.' }, { status: 400 })
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
  await emailOpsManualPaymentSubmitted(b, payment).catch(() => {})
  return NextResponse.json({ ok: true, booking: customerView(b) })
}
