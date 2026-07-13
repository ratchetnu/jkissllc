import { COMPANY } from './company'
import { sendSmsDetailed, toE164 } from './sms'
import { emailRaw } from './booking-emails'
import { getOwnerAlertConfig } from './owner-alerts'
import {
  saveBooking, fmtUSD, balanceDueCents, effectiveServiceDate,
  pushBookingEvent, recordNotificationAttempt, lastNotification,
  SERVICE_LABELS,
  type Booking, type Payment, type NotificationKind,
} from './bookings'

// Owner-notification LEDGER (request Part 7). Unlike the existing fire-and-forget
// ops emails, every owner alert here is recorded on the booking with its channel,
// provider id, status, error, and retry count — deduped so a booking never double-
// texts, and resendable from the admin. This is the reliability backbone the request
// asks for ("Store attempt / status / provider id / failure reason / retry count").

const BASE = (process.env.NEXT_PUBLIC_SITE_URL || COMPANY.siteUrlApex).replace(/\/$/, '')

// Deep link the owner taps to review a booking in OpsPilot (the dashboard opens it
// via ?b=<bookingNumber>). This is the "Secure OpsPilot link".
export function ownerBookingUrl(b: Booking): string {
  return `${BASE}/admin/bookings?b=${encodeURIComponent(b.bookingNumber)}`
}

function svcDateLabel(b: Booking): string {
  const d = effectiveServiceDate(b)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return b.selectedWindow ? `TBD, ${b.selectedWindow}` : 'To be scheduled'
  const dt = new Date(`${d}T12:00:00Z`)
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) + (b.selectedWindow ? `, ${b.selectedWindow}` : '')
}

function locationLabel(b: Booking): string {
  return b.jobSiteAddress || b.pickupAddress || '—'
}

// ── Core sender: one owner notification, fully ledgered ──────────────────────
type OwnerMessage = { sms: string; emailSubject: string; emailHtml: string }

async function sendOwnerNotification(
  b: Booking, kind: NotificationKind, msg: OwnerMessage, opts: { force?: boolean; resend?: boolean } = {},
): Promise<{ sent: boolean; deduped: boolean }> {
  // Dedupe — don't re-alert for the same event unless explicitly forced/resent.
  const prior = lastNotification(b, kind)
  if (prior && prior.status === 'sent' && !opts.force && !opts.resend) {
    return { sent: true, deduped: true }
  }
  const retryBase = prior ? prior.retryCount + 1 : 0

  const cfg = await getOwnerAlertConfig().catch(() => null)
  const smsTo = cfg?.smsTo || process.env.OWNER_SMS || ''
  const emailTo = cfg?.emailTo || COMPANY.ownerEmail
  const wantSms = (cfg?.sms ?? true) && !!toE164(smsTo)
  const wantEmail = (cfg?.email ?? true) && !!emailTo

  let anySent = false

  if (wantSms) {
    const r = await sendSmsDetailed(smsTo, msg.sms)
    recordNotificationAttempt(b, {
      kind, channel: 'sms', to: toE164(smsTo) || smsTo,
      status: r.ok ? 'sent' : 'failed', providerId: r.ok ? r.sid : undefined,
      error: r.ok ? undefined : r.error, retryCount: retryBase,
    })
    if (r.ok) anySent = true
  }

  if (wantEmail) {
    // emailRaw now returns the provider result — a Resend `.error` (unverified
    // domain, bad key, rate limit) is a FAILURE recorded in the ledger, not a
    // silent success.
    const r = await emailRaw({ to: [emailTo], subject: msg.emailSubject, html: msg.emailHtml })
    recordNotificationAttempt(b, {
      kind, channel: 'email', to: emailTo,
      status: r.ok ? 'sent' : 'failed', providerId: r.ok ? r.id : undefined,
      error: r.ok ? undefined : r.error, retryCount: retryBase,
    })
    if (r.ok) anySent = true
  }

  pushBookingEvent(b, {
    actor: 'system',
    action: opts.resend ? 'notification.resent' : anySent ? 'notification.sent' : 'notification.failed',
    result: anySent ? 'sent' : 'failed',
    meta: { kind },
  })
  await saveBooking(b)
  return { sent: anySent, deduped: false }
}

// ── Templates ────────────────────────────────────────────────────────────────

/**
 * A new Book Now request came in (status quote_received) — alert the owner on the
 * durable ledger (email + optional SMS), NOT the old fire-and-forget email. Skipped
 * for sandbox test records. Idempotent per booking (dedup by kind).
 */
export async function notifyOwnerNewSubmission(b: Booking, opts: { force?: boolean; resend?: boolean } = {}) {
  if (b.isTest) return { sent: false, deduped: false } // sandbox records never alert
  const url = ownerBookingUrl(b)
  const est = (b.aiEstimate && !b.aiEstimate.override)
    ? `$${b.aiEstimate.pricing.lowUsd}–$${b.aiEstimate.pricing.highUsd}`
    : (b.invoiceAmountCents > 0 ? fmtUSD(b.invoiceAmountCents) : 'to be priced')
  const sms =
    `${COMPANY.legalNameUpper}: NEW BOOK NOW REQUEST\n` +
    `Booking: ${b.bookingNumber}\n` +
    `Customer: ${b.customerName}\n` +
    `Service: ${SERVICE_LABELS[b.serviceType]}\n` +
    `Location: ${locationLabel(b)}\n` +
    `Est: ${est}\n` +
    `Review: ${url}`
  const emailHtml =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">` +
    `<h2 style="margin:0 0 8px">New Book Now request</h2>` +
    `<p style="margin:0 0 12px;color:#333">A customer submitted a request on your site. Review, price, and send a quote.</p>` +
    `<table style="font-size:14px;color:#222">` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Booking</td><td><strong>${b.bookingNumber}</strong></td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Customer</td><td>${b.customerName}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Service</td><td>${SERVICE_LABELS[b.serviceType]}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Location</td><td>${locationLabel(b)}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Photos</td><td>${b.invoicePhotos?.length ?? 0}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Estimate</td><td>${est}</td></tr></table>` +
    `<p style="margin:16px 0 0"><a href="${url}" style="background:${COMPANY.brand.red};color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px;display:inline-block">Review in OpsPilot</a></p></div>`
  return sendOwnerNotification(b, 'new_submission', { sms, emailSubject: `New Book Now request — ${b.bookingNumber}`, emailHtml }, opts)
}

/**
 * The durable server-side AI worker reached a terminal outcome for a Book Now
 * request — tell the owner. 'completed' → estimate ready to approve; 'manual_review'
 * → needs a human look; 'failed' → processing failed after retries (price by hand).
 * Ledgered + deduped per kind. Skipped for sandbox test records + customer never told.
 */
export async function notifyOwnerAiOutcome(b: Booking, status: 'completed' | 'manual_review' | 'failed', opts: { force?: boolean; resend?: boolean } = {}) {
  if (b.isTest) return { sent: false, deduped: false }
  const url = ownerBookingUrl(b)
  const kind = status === 'completed' ? 'ai_ready' : status === 'manual_review' ? 'ai_manual_review' : 'ai_failed'
  const headline =
    status === 'completed' ? 'AI estimate ready for approval'
      : status === 'manual_review' ? 'AI flagged this request for manual review'
        : 'AI processing failed — price this request by hand'
  const est = b.aiEstimate?.pricing ? `$${b.aiEstimate.pricing.lowUsd}–$${b.aiEstimate.pricing.highUsd}` : '—'
  const errLine = status === 'failed' && b.aiJob?.errorCode ? `\nReason: ${b.aiJob.errorCode}` : ''
  const sms =
    `${COMPANY.legalNameUpper}: ${headline.toUpperCase()}\n` +
    `Booking: ${b.bookingNumber}\n` +
    `Service: ${SERVICE_LABELS[b.serviceType]}\n` +
    (status === 'failed' ? '' : `Est: ${est}\n`) +
    `${errLine ? errLine.trim() + '\n' : ''}` +
    `Open: ${url}`
  const emailHtml =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">` +
    `<h2 style="margin:0 0 8px">${headline}</h2>` +
    `<table style="font-size:14px;color:#222">` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Booking</td><td><strong>${b.bookingNumber}</strong></td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Service</td><td>${SERVICE_LABELS[b.serviceType]}</td></tr>` +
    (status === 'failed'
      ? `<tr><td style="padding:2px 10px 2px 0;color:#666">Reason</td><td>${b.aiJob?.errorCode ?? 'unknown'}${b.aiJob?.attempts ? ` (after ${b.aiJob.attempts} attempts)` : ''}</td></tr>`
      : `<tr><td style="padding:2px 10px 2px 0;color:#666">Estimate</td><td>${est}</td></tr>`) +
    `</table>` +
    `<p style="margin:16px 0 0"><a href="${url}" style="background:${COMPANY.brand.red};color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px;display:inline-block">Open in OpsPilot</a></p></div>`
  return sendOwnerNotification(b, kind, { sms, emailSubject: `${headline} — ${b.bookingNumber}`, emailHtml }, opts)
}

/** Immediately after a Zelle proof is uploaded — owner must review it. */
export async function notifyOwnerZelleReview(b: Booking, payment: Payment, opts: { force?: boolean; resend?: boolean } = {}) {
  const url = ownerBookingUrl(b)
  const sms =
    `${COMPANY.legalNameUpper}: ZELLE PAYMENT REVIEW REQUIRED\n` +
    `Booking: ${b.bookingNumber}\n` +
    `Customer: ${b.customerName}\n` +
    `Deposit: ${fmtUSD(payment.amountCents)}\n` +
    `Service Date: ${svcDateLabel(b)}\n` +
    `Review: ${url}`
  const emailHtml =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">` +
    `<h2 style="margin:0 0 8px">Zelle payment review required</h2>` +
    `<p style="margin:0 0 12px;color:#333">A customer uploaded a Zelle payment screenshot. Verify it before confirming.</p>` +
    `<table style="font-size:14px;color:#222">` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Booking</td><td><strong>${b.bookingNumber}</strong></td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Customer</td><td>${b.customerName}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Deposit</td><td>${fmtUSD(payment.amountCents)}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Service date</td><td>${svcDateLabel(b)}</td></tr></table>` +
    `<p style="margin:16px 0 0"><a href="${url}" style="background:${COMPANY.brand.red};color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px;display:inline-block">Review in OpsPilot</a></p></div>`
  return sendOwnerNotification(b, 'zelle_review', { sms, emailSubject: `Zelle review required — ${b.bookingNumber}`, emailHtml }, opts)
}

/** After a Stripe payment verifies (webhook/return) and the booking is Confirmed. */
export async function notifyOwnerNewConfirmedBooking(b: Booking, payment: Payment, opts: { force?: boolean; resend?: boolean } = {}) {
  const url = ownerBookingUrl(b)
  const sms =
    `${COMPANY.legalNameUpper}: NEW CONFIRMED BOOKING\n` +
    `Booking: ${b.bookingNumber}\n` +
    `Customer: ${b.customerName}\n` +
    `Service: ${SERVICE_LABELS[b.serviceType]}\n` +
    `Date: ${svcDateLabel(b)}\n` +
    `Location: ${locationLabel(b)}\n` +
    `Deposit Paid: ${fmtUSD(payment.amountCents)}\n` +
    `Balance: ${fmtUSD(balanceDueCents(b))}\n` +
    `${url}`
  const emailHtml =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">` +
    `<h2 style="margin:0 0 8px">New confirmed booking</h2>` +
    `<table style="font-size:14px;color:#222">` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Booking</td><td><strong>${b.bookingNumber}</strong></td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Customer</td><td>${b.customerName}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Service</td><td>${SERVICE_LABELS[b.serviceType]}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Date</td><td>${svcDateLabel(b)}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Location</td><td>${locationLabel(b)}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Deposit paid</td><td>${fmtUSD(payment.amountCents)}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0;color:#666">Balance</td><td>${fmtUSD(balanceDueCents(b))}</td></tr></table>` +
    `<p style="margin:16px 0 0"><a href="${url}" style="background:${COMPANY.brand.red};color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px;display:inline-block">Open in OpsPilot</a></p></div>`
  return sendOwnerNotification(b, 'new_confirmed_booking', { sms, emailSubject: `New confirmed booking — ${b.bookingNumber}`, emailHtml }, opts)
}

/** Owner-initiated resend of the most relevant pending owner notification. */
export async function resendOwnerNotification(b: Booking, kind: NotificationKind, payment?: Payment): Promise<{ sent: boolean }> {
  if (kind === 'new_submission') return notifyOwnerNewSubmission(b, { resend: true })
  if (kind === 'zelle_review' && payment) return notifyOwnerZelleReview(b, payment, { resend: true })
  if (kind === 'new_confirmed_booking' && payment) return notifyOwnerNewConfirmedBooking(b, payment, { resend: true })
  return { sent: false }
}

// ── Customer: proof rejected → upload a new one ──────────────────────────────
export async function notifyCustomerZelleRejected(b: Booking, reason: string, replacementUrl: string): Promise<void> {
  const firstName = b.customerName.split(' ')[0] || 'there'
  if (b.customerPhone && toE164(b.customerPhone)) {
    await sendSmsDetailed(b.customerPhone,
      `${COMPANY.legalName}: We couldn't verify your Zelle payment for booking ${b.bookingNumber}. ${reason} Please re-upload your confirmation here: ${replacementUrl}`)
  }
  if (b.customerEmail && process.env.RESEND_API_KEY) {
    try {
      await emailRaw({
        to: [b.customerEmail],
        subject: `Action needed — re-upload your payment for ${b.bookingNumber}`,
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px">` +
          `<h2 style="margin:0 0 8px">We couldn't verify your payment yet</h2>` +
          `<p style="color:#333;font-size:15px;line-height:1.5">Hi ${firstName}, we weren't able to verify your Zelle payment for booking <strong>${b.bookingNumber}</strong>.</p>` +
          `<p style="color:#333;font-size:15px;line-height:1.5"><strong>Reason:</strong> ${reason}</p>` +
          `<p style="margin:18px 0"><a href="${replacementUrl}" style="background:${COMPANY.brand.red};color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;display:inline-block">Upload a new confirmation</a></p>` +
          `<p style="color:#888;font-size:12px">Your booking is still held — this just confirms your deposit.</p></div>`,
      })
    } catch (e) { console.error('[booking-notify] customer reject email', e) }
  }
  pushBookingEvent(b, { actor: 'system', action: 'notification.sent', result: 'sent', meta: { kind: 'zelle_rejected_customer' } })
}
