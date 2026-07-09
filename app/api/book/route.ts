import { NextRequest, NextResponse } from 'next/server'
import { COMPANY } from '../../lib/company'
import {
  generateToken, nextBookingNumber, nextInvoiceNumber, saveBooking, sanitizePhotos,
  SERVICE_TYPES, type Booking, type ServiceType,
} from '../../lib/bookings'
import { isDateBookable, getDepositCents, unitsForLoad } from '../../lib/availability'
import { getStripe, stripeConfigured, grossUp } from '../../lib/stripe'
import { rateLimit } from '../../lib/rate-limit'
import { isBlockedBot } from '../../lib/botcheck'
import { emailOpsBookingCreated, siteUrl } from '../../lib/booking-emails'
import { isValidEmail } from '../../lib/validators'
import { getPromo, validatePromo, normalizeCode } from '../../lib/promo'

export const runtime = 'nodejs'

const s = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || undefined : undefined)

// POST /api/book — instant online booking: reserve an open date + pay a deposit.
export async function POST(req: NextRequest) {
  if (await rateLimit(req, 'instantbook', 8, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait a few minutes.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Request blocked. Please try again.' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const name = s(body.name, 200)
  const email = s(body.email, 200)
  const phone = s(body.phone, 40)
  if (!name || (!isValidEmail(email) && !phone)) {
    return NextResponse.json({ error: 'Please enter your name and an email or phone.' }, { status: 400 })
  }
  const serviceType = (SERVICE_TYPES.includes(body.service) ? body.service : 'other') as ServiceType
  const loadSize = s(body.loadSize, 30)
  const units = unitsForLoad(loadSize)
  const date = s(body.date, 20) || ''
  const window = s(body.window, 60)
  // Re-validate server-side using the job's size (bigger jobs need more open room).
  if (!(await isDateBookable(date, units))) {
    return NextResponse.json({ error: 'That date is no longer available for a job this size — please pick another.' }, { status: 409 })
  }

  const depositCents = await getDepositCents()
  if (depositCents <= 0) return NextResponse.json({ error: 'Online booking is not available right now.' }, { status: 503 })

  // Optional promo (recorded; the discount is applied once ops prices the job).
  let promoCode: string | undefined
  const pc = normalizeCode(body.promo)
  if (pc) { const p = await getPromo(pc); const v = validatePromo(p, depositCents, Date.now()); if (v.ok) promoCode = v.promo.code }

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
    description: [s(body.notes, 2000), loadSize ? `Est. load: ${loadSize}` : '', s(body.debris, 40) ? `Type: ${s(body.debris, 40)}` : ''].filter(Boolean).join(' · ') || undefined,
    items: [],
    invoicePhotos: sanitizePhotos(Array.isArray(body.photos) ? body.photos.map((u: unknown) => ({ url: String(u) })) : []),
    jobUnits: units,
    invoiceAmountCents: 0,          // ops sets the real total after assessing the job
    depositAmountCents: depositCents,
    amountPaidCents: 0,
    collectInPerson: true,          // remaining balance handled after the job
    availableDates: [date],
    availableWindows: window ? [window] : [],
    selectedDate: date,
    selectedWindow: window,
    customerTimeVerifiedAt: now,    // customer chose the date + window themselves
    promoCode,
    source: 'online',               // self-service deposit hold — eligible for cleanup
    status: 'booking_created',
    payments: [],
    internalNotes: `Booked online${promoCode ? ` · promo ${promoCode}` : ''}. Deposit $${(depositCents / 100).toFixed(2)} to hold ${date}. Set the final invoice + arrival window.`,
    createdAt: now,
    updatedAt: now,
  }
  await saveBooking(booking)
  await emailOpsBookingCreated(booking)

  const base = siteUrl()
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
  // No card processing available — hand back the booking page to arrange the deposit.
  return NextResponse.json({ ok: true, token: booking.token, bookingUrl: `${base}/booking/${booking.token}` })
}
