import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../lib/platform/tenancy/with-tenant-route'
import { COMPANY } from '../../lib/company'
import {
  generateToken, nextBookingNumber, nextInvoiceNumber, saveBooking, sanitizePhotos,
  getBookingByToken, recompute, pushBookingEvent,
  SERVICE_TYPES, type Booking, type ServiceType, type Payment,
} from '../../lib/bookings'
import { isDateBookable, getDepositCents, unitsForLoad } from '../../lib/availability'
import { getStripe, grossUp } from '../../lib/stripe'
import { capabilityAvailable } from '../../lib/platform/capabilities/guard'
import { rateLimit } from '../../lib/rate-limit'
import { isBlockedBot } from '../../lib/botcheck'
import { emailOpsBookingCreated, siteUrl } from '../../lib/booking-emails'
import { isValidEmail } from '../../lib/validators'
import { getPromo, validatePromo, normalizeCode } from '../../lib/promo'
import { getPaymentProvider } from '../../lib/payments'
import { validateProofImage, sealAndStoreProof } from '../../lib/payment-proof'
import { notifyOwnerZelleReview } from '../../lib/booking-notify'
import { tenantIdForOutboundMetadata } from '../../lib/platform/tenancy/tenant-resolve'
import { currentTenantId } from '../../lib/platform/tenancy/context'
import { enqueueAiJob } from '../../lib/book-now-ai'
import { finalizedBookingToken, reserveIdempotencyKey, commitIdempotently } from '../../lib/booking-idempotency'
import type { KvLock } from '../../lib/kv-lock'

export const runtime = 'nodejs'

const s = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || undefined : undefined)

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
  // FINAL first, then the lease: a retry arriving after the owner finished gets the
  // original booking rather than a 409. The lease is renewable, so it cannot expire
  // out from under a request that is still legitimately working — see
  // lib/booking-idempotency.ts for the race this closes.
  const idemKey = s(body.idempotencyKey, 100)
  let reservation: KvLock | null = null
  if (idemKey) {
    const finalized = await finalizedBookingToken(idemKey)
    if (finalized) {
      const prior = await getBookingByToken(finalized)
      if (prior) return NextResponse.json({ ok: true, token: prior.token, bookingUrl: `${base}/booking/${prior.token}`, duplicate: true })
    }
    reservation = await reserveIdempotencyKey(idemKey, 'book')
    if (!reservation) return NextResponse.json({ error: 'This booking is already being processed — please wait a moment.' }, { status: 409 })
  }
  // Everything below runs under that reservation. The `finally` releases it on EVERY
  // exit — success, validation failure, or throw — so a failed attempt never strands
  // the key and the customer's corrected resubmission is not told "already
  // processing". Release is compare-and-delete: it can only ever free OUR lease.
  try {

  // Another request won the atomic finalization for this key, so this one must not
  // persist. Hand the customer the winner's booking if it has landed; otherwise the
  // winner is still mid-save, and a retry moments later will find it.
  const concededTo = async (winnerToken: string | null) => {
    const prior = winnerToken ? await getBookingByToken(winnerToken) : null
    if (prior) return NextResponse.json({ ok: true, token: prior.token, bookingUrl: `${base}/booking/${prior.token}`, duplicate: true })
    return NextResponse.json({ error: 'This booking is already being processed — please wait a moment.' }, { status: 409 })
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

  // ── Durable photo AI (parity with persistQuoteRequest) ────────────────────
  // /api/book is a TERMINAL intake, not a draft: it is the sibling of "Request My
  // Quote" on the same wizard step, and nothing downstream ever enqueues for it —
  // record-payment, the Stripe webhook and the cron all leave it alone, because
  // runDueAiJobs selects on `isDue`, which requires an aiJob to ALREADY exist.
  // Without this call every photo-bearing eligible booking reserved through this
  // route stranded with an empty AI panel forever.
  //
  // Eligibility is NOT re-litigated here: enqueueAiJob gates itself on needsAiJob,
  // so the one predicate (junk always, moving behind AI_PHOTO_ESTIMATE_MOVING,
  // "other" never) governs both intake paths. It is idempotent per booking token +
  // photo set, so no photos, an ineligible family, or a retry all correctly produce
  // nothing. It only mutates booking.aiJob — both save paths below persist it.
  //
  // Fail-soft: a queue failure must never cost the customer their reservation, so
  // it is recorded on the audit trail (where the owner's "Re-run analysis" control
  // reads from) rather than thrown.
  try {
    enqueueAiJob(booking, { tenantId: currentTenantId(), initiatedBy: 'system' })
  } catch (e) {
    console.error('[book] enqueue ai job', e)
    pushBookingEvent(booking, {
      actor: 'system', action: 'ai.failed', result: 'enqueue_failed',
      meta: { photoVersion: booking.invoicePhotos?.length ?? 0, recoverable: true },
    })
  }

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
    const zelleCommit = await commitIdempotently(idemKey, booking.token, () => saveBooking(booking))
    if (!zelleCommit.ok) return await concededTo(zelleCommit.winnerToken)
    await emailOpsBookingCreated(booking).catch(() => {})
    await notifyOwnerZelleReview(booking, payment).catch(e => console.error('[book] owner zelle notify', e))
    return NextResponse.json({ ok: true, token: booking.token, bookingUrl: `${base}/booking/${booking.token}?zelle=pending` })
  }

  // ── Stripe: persist the booking, then hand off to hosted checkout ──────────
  const commit = await commitIdempotently(idemKey, booking.token, () => saveBooking(booking))
  if (!commit.ok) return await concededTo(commit.winnerToken)
  await emailOpsBookingCreated(booking).catch(() => {})

  // Card checkout is OPTIONAL here by design: a business with no card processor
  // still books, still gets a confirmed record, and still lands on its booking page
  // to pay by Zelle/cash/check. `capabilityAvailable` replaces the raw env read so
  // an owner who has deliberately turned cards off gets the same graceful path as an
  // owner who never configured them.
  if (await capabilityAvailable('payments-stripe')) {
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
        // Stamp the originating tenant so the later (session-less) webhook can
        // resolve it via resolveTenantFromStripe. Returns 'jkiss' while tenancy off.
        metadata: { bookingToken: booking.token, bookingNumber: booking.bookingNumber, paymentType: 'deposit', invoiceAmountCents: String(depositCents), feeCents: String(feeCents), tenantId: tenantIdForOutboundMetadata() },
      })
      return NextResponse.json({ ok: true, token: booking.token, url: session.url })
    } catch (e) {
      console.error('[book] stripe', e)
    }
  }
  return NextResponse.json({ ok: true, token: booking.token, bookingUrl: `${base}/booking/${booking.token}` })

  } finally {
    // Always, on every path. Once the booking is finalized the mapping above is what
    // answers retries, so dropping the lease here is what lets the NEXT legitimate
    // request through instead of making it wait out a lease.
    await reservation?.release()
  }
})
