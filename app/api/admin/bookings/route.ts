import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import {
  listBookings, saveBooking, generateToken, nextBookingNumber, nextInvoiceNumber, dollarsToCents, sanitizePhotos,
  SERVICE_TYPES, type Booking, type ServiceType,
} from '../../../lib/bookings'
import { emailOpsBookingCreated } from '../../../lib/booking-emails'
import { sendConfirmationLink } from '../../../lib/notify'
import { str, strList, num } from '../../../lib/validators'

export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const items = await listBookings(500)
    return NextResponse.json({ items })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/bookings GET]', err)
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))

  const customerName = str(body.customerName, 200)
  if (!customerName) return NextResponse.json({ error: 'Customer name is required.' }, { status: 400 })

  const serviceType = (SERVICE_TYPES.includes(body.serviceType) ? body.serviceType : 'other') as ServiceType
  const now = Date.now()

  try {
    const booking: Booking = {
      token: generateToken(),
      bookingNumber: await nextBookingNumber(),
      customerName,
      customerPhone: str(body.customerPhone, 40),
      customerEmail: str(body.customerEmail, 200),
      invoiceNumber: str(body.invoiceNumber, 60) ?? await nextInvoiceNumber(),
      invoiceDate: str(body.invoiceDate, 40),
      serviceType,
      pickupAddress: str(body.pickupAddress, 300),
      dropoffAddress: str(body.dropoffAddress, 300),
      jobSiteAddress: str(body.jobSiteAddress, 300),
      description: str(body.description, 2000),
      items: strList(body.items, 80),
      invoicePhotos: sanitizePhotos(body.invoicePhotos),
      invoiceAmountCents: dollarsToCents(body.invoiceAmount ?? 0),
      discountCents: dollarsToCents(body.discountAmount ?? 0) || undefined,
      depositAmountCents: dollarsToCents(body.depositAmount ?? 0),
      amountPaidCents: 0,
      collectInPerson: body.collectInPerson === true || body.collectInPerson === 'true' || body.collectInPerson === 'on',
      crewSize: num(body.crewSize),
      estimatedHours: num(body.estimatedHours),
      availableDates: strList(body.availableDates, 60),
      availableWindows: strList(body.availableWindows, 20),
      selectedDate: str(body.selectedDate, 20),
      selectedWindow: str(body.selectedWindow, 40),
      internalNotes: str(body.internalNotes, 2000),
      assignedTo: str(body.assignedTo, 80),
      status: 'booking_created',
      payments: [],
      createdAt: now,
      updatedAt: now,
    }
    await saveBooking(booking)
    await emailOpsBookingCreated(booking)

    // Auto-send the customer their confirmation link the moment a real booking is
    // created (default on; the form can opt out with sendLinkNow:false). Only fires
    // when we have a way to reach them and there's an invoice to confirm — never on a
    // bare draft. Non-fatal: a send failure must not fail booking creation.
    const wantLink = body.sendLinkNow !== false && body.sendLinkNow !== 'false'
    const reachable = Boolean(booking.customerEmail || booking.customerPhone)
    let linkChannels: { email: boolean; sms: boolean } | null = null
    if (wantLink && reachable && booking.invoiceAmountCents > 0) {
      try {
        linkChannels = await sendConfirmationLink(booking)
        booking.confirmationLinkSentAt = Date.now()
        booking.confirmationLinkSentBy = 'admin (auto)'
        booking.status = 'confirmation_link_sent'
        await saveBooking(booking)
      } catch (e) {
        console.error('[admin/bookings POST] auto send-link failed', e)
      }
    }
    return NextResponse.json({ ok: true, booking, linkChannels })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'save failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/bookings POST]', err)
    return NextResponse.json({ error: 'save failed' }, { status: 500 })
  }
}
