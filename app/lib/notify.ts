import type { Booking } from './bookings'
import { SERVICE_LABELS, fmtUSD, balanceDueCents } from './bookings'
import {
  bookingLink, receiptLink,
  emailConfirmationLink, emailTimeVerifiedCustomer, emailBookingConfirmedCustomer, emailJobCompletedCustomer,
  emailPaidInFullCustomer,
  emailBookingReminderCustomer, emailPaymentReminderCustomer, emailJobTomorrowCustomer, emailReviewRequestCustomer,
} from './booking-emails'
import { sendSms, smsConfigured, toE164 } from './sms'

export type Channels = { email: boolean; sms: boolean }

function hasEmail(b: Booking): boolean {
  return !!b.customerEmail && !!process.env.RESEND_API_KEY
}
function hasSms(b: Booking): boolean {
  return smsConfigured() && !!toE164(b.customerPhone)
}

// Send the secure booking/confirmation link over every channel we have contact
// info + a configured provider for (email and/or SMS). Returns which actually went.
export async function sendConfirmationLink(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailConfirmationLink(b); out.email = true }
  if (hasSms(b)) {
    const msg = `J KISS LLC: Hi ${b.customerName}, you're almost booked (${b.bookingNumber}). Verify your service date & arrival window and view your invoice here: ${bookingLink(b.token)} Reply STOP to opt out, HELP for help.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyTimeVerified(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailTimeVerifiedCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `J Kiss LLC: Your service time is verified — ${b.selectedDate}, ${b.selectedWindow}. We'll contact you if any adjustment is needed. ${bookingLink(b.token)}`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyBookingConfirmed(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailBookingConfirmedCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `J Kiss LLC: You're officially booked (${b.bookingNumber})! ${SERVICE_LABELS[b.serviceType]} on ${b.selectedDate}, ${b.selectedWindow}. Balance due: ${fmtUSD(balanceDueCents(b))}. ${bookingLink(b.token)}`
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
    const msg = `J Kiss LLC: Paid in full — thank you, ${b.customerName}! Your receipt (${b.bookingNumber}) is here: ${receiptLink(b.token)}`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyJobCompleted(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailJobCompletedCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `J Kiss LLC: Your ${SERVICE_LABELS[b.serviceType]} (${b.bookingNumber}) is complete — thank you for your business! Balance due: ${fmtUSD(balanceDueCents(b))}.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

// ── Automated reminders (daily cron) ─────────────────────────────────────────

export async function notifyBookingReminder(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailBookingReminderCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `J Kiss LLC: Hi ${b.customerName}, don't forget to confirm your booking (${b.bookingNumber}) — verify your date & window here: ${bookingLink(b.token)} Reply STOP to opt out.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyPaymentReminder(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailPaymentReminderCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `J Kiss LLC: Reminder — a balance of ${fmtUSD(balanceDueCents(b))} is due on ${b.bookingNumber}. Pay or pay fee-free by Zelle (817-909-4312): ${bookingLink(b.token)} Reply STOP to opt out.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyJobTomorrow(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailJobTomorrowCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `J Kiss LLC: Reminder — your ${SERVICE_LABELS[b.serviceType]} (${b.bookingNumber}) is tomorrow${b.selectedWindow ? `, ${b.selectedWindow}` : ''}. Please ensure clear access. Questions? (817) 909-4312.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}

export async function notifyReviewRequest(b: Booking): Promise<Channels> {
  const out: Channels = { email: false, sms: false }
  if (hasEmail(b)) { await emailReviewRequestCustomer(b); out.email = true }
  if (hasSms(b)) {
    const msg = `J Kiss LLC: Thanks again, ${b.customerName}! How did we do? Leave a quick review here: ${receiptLink(b.token)}#review Reply STOP to opt out.`
    out.sms = await sendSms(b.customerPhone, msg)
  }
  return out
}
