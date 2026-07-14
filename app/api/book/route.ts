import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../lib/platform/tenancy/with-tenant-route'
import { COMPANY } from '../../lib/company'
import { redis } from '../../lib/redis'
import {
  generateToken, nextBookingNumber, nextInvoiceNumber, saveBooking, sanitizePhotos,
  getBookingByToken, recompute, pushBookingEvent,
  SERVICE_TYPES, type Booking, type ServiceType, type Payment,
} from '../../lib/bookings'
import { isDateBookable, getDepositCents, unitsForLoad } from '../../lib/availability'
import { getStripe, stripeConfigured, grossUp } from '../../lib/stripe'
import { rateLimit } from '../../lib/rate-limit'
import { isBlockedBot } from '../../lib/botcheck'
import { emailOpsBookingCreated, siteUrl } from '../../lib/booking-emails'
import { isValidEmail } from '../../lib/validators'
import { getPromo, validatePromo, normalizeCode } from '../../lib/promo'
import { getPaymentProvider } from '../../lib/payments'
import { validateProofImage, sealAndStoreProof } from '../../lib/payment-proof'
import { notifyOwnerZelleReview } from '../../lib/booking-notify'

export const runtime = 'nodejs'

const s = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || undefined : undefined)
const IDEM_TTL_MS = 24 * 60 * 60_000

// POST /api/book — instant online booking: reserve an open date + pay a deposit by
// Stripe (redirect) or Zelle (upload a verifiable screenshot). Idempotent: a retry
// with the same idempotencyKey returns the original booking instead of duplicating.
export const POST = withTenantRoute(async (req: NextRequest) => {
  if (await rateLimit(req, 'instantbook', 8, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Request blocked. Please try again.' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const base = siteUrl()

  // ── Idempotency (request Part 1) — one booking per client key ──────────────
  const idemKey = s(body.idempotencyKey, 100)
  if (idemKey) {
    const existing = await redis.get(`bk:idem:${idemKey}`)
    if (existing && existing !== 'PENDING') {
      const prior = await getBookingByToken(existing)
      if (prior) return NextResponse.json({ ok: true, token: prior.token, bookingUrl: `${base}/booking/${prior.token}`, duplicate: true })
    }
    const claimed = await redis.setNxPx(`bk:idem:${idemKey}`, 'PENDING', 30_000)
    if (!claimed) return NextResponse.json({ error: 'This booking is already being processed — please wait a moment.' }, { status: 409 })
  }

  const name = s(body.name, 200)
  const email = s(body.email, 200)
  const phone = s(body.phone, 40)
  if (!name || (!isValidEmail(email) && !phone)) {
    return NextResponse.json({ error: 'Please enter your name and an email or phone.' }, { status: 400 })
  }

  // Payment method selection (defaults to card for backward compatibility).
  const methodId = body.paymentMethod === 'zelle' ? 'zelle' : 'stripe'
  const provider = getPaymentProvider(methodId)
  if (!provider) return NextResponse.json({ error: 'That payment method is not available right now.' }, { status: 400 })

  const serviceType = (SERVICE_TYPES.includes(body.service) ? body.service : 'other') as ServiceType
  const loadSize = s(body.loadSize, 30)
  const units = unitsForLoad(loadSize)
  const date = s(body.date, 20) || ''
  const window = s(body.window, 60)
  if (!(await isDateBookable(date, units))) {
    return NextResponse.json({ error: 'That date is no longer available for a job this size — please pick another.' }, { status: 409 })
  }

  const depositCents = await getDepositCents()
  if (depositCents <= 0) return NextResponse.json({ error: 'Online booking is not available right now.' }, { status: 503 })

  // For Zelle, the screenshot is MANDATORY and validated BEFORE any booking is
  // created — a booking is never persisted without valid proof (request Part 4).
  let proofBuf: Buffer | undefined
  let proofExt = ''
  if (provider.requiresProof) {
    const v = validateProofImage(body.proofImage)
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
    proofBuf = v.buf; proofExt = v.ext
  }

  // Optional promo (recorded; discount applied once ops prices the job).
  let promoCode: string | undefined
  const pc = normalizeCode(body.promo)
  if (pc) { const p = await getPromo(pc); const val = validatePromo(p, depositCents, Date.now()); if (val.ok) promoCode = val.promo.code }

  const now = Date.now()
  const booking: Booking = {
    token: generateToken(),
    bookingNumber: await nextBookingNumber(),
    customerName: name,
    customerPhone: phone,
    customerEmail: email,
    invoiceNumber: await nextInvoiceNumber(),
    serviceType,
    jobSiteAddress: s(body.address, 300),
    pickupAddress: s(body.pickup, 300),
    dropoffAddress: s(body.dropoff, 300),
    description: [s(body.notes, 2000), loadSize ? `Est. load: ${loadSize}` : '', s(body.debris, 40) ? `Type: ${s(body.debris, 40)}` : ''].filter(Boolean).join(' · ') || undefined,
    items: [],
    invoicePhotos: sanitizePhotos(Array.isArray(body.photos) ? body.photos.map((u: unknown) => ({ url: String(u) })) : []),
    jobUnits: units,
    invoiceAmountCents: 0,
    depositAmountCents: depositCents,
    amountPaidCents: 0,
    collectInPerson: true,
    availableDates: [date],
    availableWindows: window ? [window] : [],
    selectedDate: date,
    selectedWindow: window,
    customerTimeVerifiedAt: now,
    customerNotes: s(body.customerNotes, 2000),
    accessNotes: s(body.accessNotes, 500),
    promoCode,
    leadSource: s(body.leadSource, 120),
    marketingSource: s(body.marketingSource, 200),
    referralSource: s(body.referralSource, 120),
    idempotencyKey: idemKey,
    source: 'online',
    status: 'booking_created',
    payments: [],
    events: [],
    internalNotes: `Booked online (${provider.label})${promoCode ? ` · promo ${promoCode}` : ''}. Deposit $${(depositCents / 100).toFixed(2)} to hold ${date}. Set the final invoice + arrival window.`,
    createdAt: now,
    updatedAt: now,
  }
  pushBookingEvent(booking, { actor: 'customer', action: 'booking.created', result: methodId, meta: { method: methodId } })

  // ── Zelle: seal the proof, record a pending payment, alert the owner ───────
  if (provider.requiresProof && proofBuf) {
    let proofPath: string
    try {
      proofPath = await sealAndStoreProof(booking.token, proofBuf, proofExt)
    } catch (e) {
      console.error('[book] proof seal/store', e)
      return NextResponse.json({ error: 'We could not securely store your screenshot. Please try again.' }, { status: 500 })
    }
    const payment: Payment = {
      id: crypto.randomUUID(),
      type: 'deposit', method: 'zelle', status: 'sent_by_customer',
      amountCents: depositCents, feeCents: 0, totalChargedCents: depositCents, netCents: depositCents,
      reference: s(body.zelleReference, 120),
      proofPath, proofUploadedAt: now,
      createdAt: now,
    }
    booking.payments.push(payment)
    recompute(booking)   // → pending_zelle_verification
    pushBookingEvent(booking, { actor: 'customer', action: 'zelle.uploaded', meta: { paymentId: payment.id, amountCents: depositCents } })
    await saveBooking(booking)
    if (idemKey) { await redis.set(`bk:idem:${idemKey}`, booking.token); await redis.pexpire(`bk:idem:${idemKey}`, IDEM_TTL_MS) }
    await emailOpsBookingCreated(booking).catch(() => {})
    await notifyOwnerZelleReview(booking, payment).catch(e => console.error('[book] owner zelle notify', e))
    return NextResponse.json({ ok: true, token: booking.token, bookingUrl: `${base}/booking/${booking.token}?zelle=pending` })
  }

  // ── Stripe: persist the booking, then hand off to hosted checkout ──────────
  await saveBooking(booking)
  if (idemKey) { await redis.set(`bk:idem:${idemKey}`, booking.token); await redis.pexpire(`bk:idem:${idemKey}`, IDEM_TTL_MS) }
  await emailOpsBookingCreated(booking).catch(() => {})

  if (stripeConfigured()) {
    try {
      const { feeCents, totalCents } = grossUp(depositCents)
      const stripe = getStripe()
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: totalCents,
            product_data: {
              name: `${COMPANY.legalName} — Booking deposit (${booking.bookingNumber})`,
              description: `Reserves ${date}. $${(depositCents / 100).toFixed(2)} deposit + $${(feeCents / 100).toFixed(2)} card fee. Fully refunded if we can't make your date.`,
            },
          },
        }],
        customer_email: email || undefined,
        success_url: `${base}/api/booking/${booking.token}/stripe-return?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/booking/${booking.token}?pay=cancelled`,
        metadata: { bookingToken: booking.token, bookingNumber: booking.bookingNumber, paymentType: 'deposit', invoiceAmountCents: String(depositCents), feeCents: String(feeCents) },
      })
      return NextResponse.json({ ok: true, token: booking.token, url: session.url })
    } catch (e) {
      console.error('[book] stripe', e)
    }
  }
  return NextResponse.json({ ok: true, token: booking.token, bookingUrl: `${base}/booking/${booking.token}` })
})
