import type { Booking } from './bookings'
import { COMPANY } from './company'
import { SERVICE_LABELS, fmtUSD, balanceDueCents } from './bookings'
import {
  bookingLink, receiptLink,
  emailConfirmationLink, emailTimeVerifiedCustomer, emailBookingConfirmedCustomer, emailJobCompletedCustomer,
  emailPaidInFullCustomer,
  emailBookingReminderCustomer, emailPaymentReminderCustomer, emailJobTomorrowCustomer, emailReviewRequestCustomer,
  emailRescheduledCustomer, emailRescheduleRequestAck, emailOpsRescheduled,
  emailCancelledCustomer, emailOpsCancelledByCustomer,
  emailContinuationCustomer, continuationMessage,
  emailOpsReturnConfirmed, emailOpsReturnChangeRequest,
  emailCustomerMessage,
} from './booking-emails'
import { sendSms, sendSmsDetailed, smsConfigured, toE164 } from './sms'
import { recordMessage } from './messages'

export type Channels = { email: boolean; sms: boolean }

/**
 * The outcome of trying to hand a customer their secure link.
 *
 * `email`/`sms` now mean "this channel ACTUALLY delivered", not "we had an address
 * and a key". The distinction matters the moment either channel is optional: a
 * business that has switched email off was previously told the link had been sent.
 */
export type LinkDelivery = Channels & {
  /** True when at least one channel delivered. */
  delivered: boolean
  /** Why nothing went out — safe to show an admin. Never a credential. */
  reason?: string
}

function hasEmail(b: Booking): boolean {
  return !!b.customerEmail && !!process.env.RESEND_API_KEY
}
function hasSms(b: Booking): boolean {
  return smsConfigured() && !!toE164(b.customerPhone)
}

// Send the secure booking/confirmation link over every channel we have contact
// info + a configured provider for (email and/or SMS). Returns which actually went.
export async function sendConfirmationLink(b: Booking): Promise<LinkDelivery> {
  const out: LinkDelivery = { email: false, sms: false, delivered: false }
  const reasons: string[] = []

  // The provider RESULT decides, not the presence of an address. Both channels are
  // optional capabilities now, and either can refuse.
  if (b.customerEmail) {
    const r = await emailConfirmationLink(b)
    out.email = r.ok
    if (!r.ok) reasons.push(`email: ${r.error ?? 'not sent'}`)
  } else {
    reasons.push('email: no address on file')
  }

  if (toE164(b.customerPhone)) {
    const msg = `${COMPANY.legalNameUpper}: Hi ${b.customerName}, you're almost booked (${b.bookingNumber}). Verify your service date & arrival window and view your invoice here: ${bookingLink(b.token)} Reply STOP to opt out, HELP for help.`
    const r = await sendSmsDetailed(b.customerPhone, msg)
    out.sms = r.ok
    if (!r.ok) reasons.push(`sms: ${r.error}`)
  } else {
    reasons.push('sms: no usable phone number on file')
  }

  out.delivered = out.email || out.sms
  if (!out.delivered) out.reason = reasons.join(' · ')
  return out
}

export async function notifyTimeVerified(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailTimeVerifiedCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `${COMPANY.legalName}: Your service time is verified — ${b.selectedDate}, ${b.selectedWindow}. We'll contact you if any adjustment is needed. ${bookingLink(b.token)}`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyBookingConfirmed(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailBookingConfirmedCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `${COMPANY.legalName}: You're officially booked (${b.bookingNumber})! ${SERVICE_LABELS[b.serviceType]} on ${b.selectedDate}, ${b.selectedWindow}. Balance due: ${fmtUSD(balanceDueCents(b))}. ${bookingLink(b.token)}`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

// Fired once an invoice flips to paid-in-full: sends the final paid receipt link
// (which also carries the optional review prompt).
export async function notifyPaidInFull(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailPaidInFullCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `${COMPANY.legalName}: Paid in full — thank you, ${b.customerName}! Your receipt (${b.bookingNumber}) is here: ${receiptLink(b.token)}`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyJobCompleted(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailJobCompletedCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `${COMPANY.legalName}: Your ${SERVICE_LABELS[b.serviceType]} (${b.bookingNumber}) is complete — thank you for your business! Balance due: ${fmtUSD(balanceDueCents(b))}.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

// ── Automated reminders (daily cron) ─────────────────────────────────────────

export async function notifyBookingReminder(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  // The provider RESULT decides, not the presence of an address. `hasEmail` only ever
  // meant "there is an address and a key", so a send that was refused or failed still
  // reported success — and the daily cron then stamped its one-shot marker, silently
  // consuming a reminder the customer never received. With email and SMS now optional
  // per business, that would have burned every reminder for every booking.
  if (b.customerEmail) out.email = (await emailBookingReminderCustomer(b)).ok
  if (toE164(b.customerPhone)) {
    const msg = `${COMPANY.legalName}: Hi ${b.customerName}, don't forget to confirm your booking (${b.bookingNumber}) — verify your date & window here: ${bookingLink(b.token)} Reply STOP to opt out.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyPaymentReminder(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  // The provider RESULT decides, not the presence of an address. `hasEmail` only ever
  // meant "there is an address and a key", so a send that was refused or failed still
  // reported success — and the daily cron then stamped its one-shot marker, silently
  // consuming a reminder the customer never received. With email and SMS now optional
  // per business, that would have burned every reminder for every booking.
  if (b.customerEmail) out.email = (await emailPaymentReminderCustomer(b)).ok
  if (toE164(b.customerPhone)) {
    const msg = `${COMPANY.legalName}: Reminder — a balance of ${fmtUSD(balanceDueCents(b))} is due on ${b.bookingNumber}. Pay or pay fee-free by Zelle (${COMPANY.zelle}): ${bookingLink(b.token)} Reply STOP to opt out.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyJobTomorrow(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  // The provider RESULT decides, not the presence of an address. `hasEmail` only ever
  // meant "there is an address and a key", so a send that was refused or failed still
  // reported success — and the daily cron then stamped its one-shot marker, silently
  // consuming a reminder the customer never received. With email and SMS now optional
  // per business, that would have burned every reminder for every booking.
  if (b.customerEmail) out.email = (await emailJobTomorrowCustomer(b)).ok
  if (toE164(b.customerPhone)) {
    const msg = `${COMPANY.legalName}: Reminder — your ${SERVICE_LABELS[b.serviceType]} (${b.bookingNumber}) is tomorrow${b.selectedWindow ? `, ${b.selectedWindow}` : ''}. Please ensure clear access. Questions? ${COMPANY.phoneDisplay}.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyReviewRequest(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  // The provider RESULT decides, not the presence of an address. `hasEmail` only ever
  // meant "there is an address and a key", so a send that was refused or failed still
  // reported success — and the daily cron then stamped its one-shot marker, silently
  // consuming a reminder the customer never received. With email and SMS now optional
  // per business, that would have burned every reminder for every booking.
  if (b.customerEmail) out.email = (await emailReviewRequestCustomer(b)).ok
  if (toE164(b.customerPhone)) {
    const msg = `${COMPANY.legalName}: Thanks again, ${b.customerName}! How did we do? Leave a quick review here: ${receiptLink(b.token)}#review Reply STOP to opt out.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

// Customer self-rescheduled to a new available slot — confirm to them + alert ops.
export async function notifyRescheduled(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailRescheduledCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `${COMPANY.legalName}: Your service (${b.bookingNumber}) is rescheduled to ${b.selectedDate}${b.selectedWindow ? `, ${b.selectedWindow}` : ''}. ${bookingLink(b.token)}`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  await emailOpsRescheduled(b)
  return out
}

// Customer requested a custom new date — ack to them + alert ops to coordinate.
export async function notifyRescheduleRequest(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailRescheduleRequestAck(b); out.email = true }
  await emailOpsRescheduled(b)
  return out
}

// Multi-day job continuation — ask the customer to confirm the return visit.
export async function notifyContinuation(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailContinuationCustomer(b); out.email = true }
  if (hasSms(b)) { out.sms = await sendSms(b.customerPhone, continuationMessage(b)) }
  return out
}

// Customer confirmed the proposed return date — ack to them + alert ops.
export async function notifyReturnConfirmed(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  const c = b.continuation
  if (hasSms(b)) {
    const msg = `${COMPANY.legalName}: Thanks ${b.customerName}! Your return visit is confirmed${c?.returnDate ? ` for ${c.returnDate}${c.returnWindow ? `, ${c.returnWindow}` : ''}` : ''}. See you then. ${bookingLink(b.token)}`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  await emailOpsReturnConfirmed(b)
  return out
}

// Customer asked for a different return date — alert ops to coordinate.
export async function notifyReturnChangeRequest(b: Booking): Promise<Channels> {
  await emailOpsReturnChangeRequest(b)
  return { email: false, sms: false }
}

// Ad-hoc message the owner composes (e.g. an apology/cancellation, a heads-up) sent
// straight to the customer. Free-form body, sent verbatim. `channel` chooses which
// rails to use; each is still gated on having contact info + a configured provider.
export async function notifyCustomerMessage(b: Booking, bodyText: string, channel: 'sms' | 'email' | 'both' = 'both'): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  const text = bodyText.trim()
  if (!text) return out
  if ((channel === 'sms' || channel === 'both') && hasSms(b)) out.sms = await sendSms(b.customerPhone, text)
  if ((channel === 'email' || channel === 'both') && hasEmail(b)) out.email = await emailCustomerMessage(b, text)
  // Log the admin reply into the communications timeline so the booking shows both sides.
  if (out.sms || out.email) {
    try {
      await recordMessage({
        direction: 'outbound', channel: out.sms ? 'sms' : 'email', provider: out.sms ? 'twilio' : 'resend',
        body: text, to: out.sms ? (toE164(b.customerPhone) ?? b.customerPhone ?? undefined) : b.customerEmail,
        customerName: b.customerName, customerPhone: toE164(b.customerPhone) ?? undefined, customerEmail: b.customerEmail,
        bookingToken: b.token, bookingNumber: b.bookingNumber, status: 'sent', tags: ['admin-message'],
      })
    } catch (e) { console.error('[notify] log admin message failed', e) }
  }
  return out
}

// Customer cancelled their own booking — confirm to them (with refund terms) + alert ops.
export async function notifyCancelledByCustomer(b: Booking, tierLabel: string): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailCancelledCustomer(b, tierLabel); out.email = true }
  if (hasSms(b)) {
    const msg = `${COMPANY.legalName}: Your booking ${b.bookingNumber} is cancelled. ${tierLabel} Questions? ${COMPANY.phoneDisplay}.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  await emailOpsCancelledByCustomer(b, tierLabel)
  return out
}
