// Schema bridges (Phase 2). This is the ONE comms file permitted to import the
// business schema — it translates the records that exist today into the flat,
// decoupled `CommContext`. Everything else in app/lib/comms/ stays schema-free.
//
// Callers migrating an existing notify.ts flow onto the event model do:
//   dispatchComm('BOOKING_CONFIRMED', fromBooking(b), { actor })
// which reuses the same links, money formatting, and branding the emails use.

import type { Booking } from '../bookings'
import { fmtUSD, balanceDueCents, SERVICE_LABELS } from '../bookings'
import { bookingLink, receiptLink, reviewUrl } from '../booking-emails'
import { toE164 } from '../sms'
import type { RouteInvoice } from '../route-invoices'
import { COMPANY } from '../company'
import type { CommContext } from './context'

function crewLabel(b: Booking): string | undefined {
  const parts = [b.assignedTo, b.assignedHelper].filter(Boolean) as string[]
  return parts.length ? parts.join(' & ') : undefined
}

// Booking → CommContext. A quote is just a booking in an early status, so this
// bridge also serves QUOTE_SENT / QUOTE_REMINDER.
export function fromBooking(b: Booking): CommContext {
  const token = b.token
  return {
    customerId: undefined,
    customerName: b.customerName,
    phone: toE164(b.customerPhone) ?? b.customerPhone ?? undefined,
    email: b.customerEmail,
    jobId: b.bookingNumber,
    bookingId: token,
    bookingNumber: b.bookingNumber,
    quoteId: b.bookingNumber,
    invoiceNumber: b.invoiceNumber,
    dateText: b.selectedDate || undefined,
    windowText: b.selectedWindow || undefined,
    address: b.jobSiteAddress || b.pickupAddress || b.dropoffAddress || undefined,
    crewName: crewLabel(b),
    amountText: typeof b.invoiceAmountCents === 'number' ? fmtUSD(b.invoiceAmountCents) : undefined,
    balanceText: fmtUSD(balanceDueCents(b)),
    bookingLink: bookingLink(token),
    invoiceLink: receiptLink(token),
    trackingLink: bookingLink(token),
    reviewLink: reviewUrl(),
    note: b.serviceType ? SERVICE_LABELS[b.serviceType] : undefined,
  }
}

// RouteInvoice (B2B) → CommContext for INVOICE_SENT / INVOICE_REMINDER.
export function fromRouteInvoice(inv: RouteInvoice): CommContext {
  const total = (inv.lines ?? []).reduce((s, l) => s + (l.amountCents ?? 0), 0)
  const paid = inv.amountPaidCents ?? 0
  return {
    customerName: inv.clientName || inv.businessName,
    email: inv.clientEmail,
    invoiceNumber: inv.invoiceNumber,
    amountText: fmtUSD(total),
    balanceText: fmtUSD(Math.max(0, total - paid)),
    invoiceLink: `${(process.env.NEXT_PUBLIC_SITE_URL || COMPANY.siteUrl).replace(/\/$/, '')}/invoice/${inv.token}`,
    note: inv.businessName,
  }
}
</content>
