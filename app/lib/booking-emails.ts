import { Resend } from 'resend'
import {
  type Booking, type Payment,
  SERVICE_LABELS, fmtUSD, balanceDueCents, BOOKING_STATUS_LABEL, PAYMENT_METHOD_LABEL,
} from './bookings'
import { COMPANY, CREDENTIALS_SLASH } from './company'

// Tenant identity comes from lib/company.ts. Per-tenant resolution (a verified
// Resend sending domain per tenant, etc.) is a later step —
// see docs/opspilot-multi-tenant-roadmap.md §6.
const FROM = COMPANY.emailFrom
const OPS = [COMPANY.email, COMPANY.ownerEmail]
const RED = COMPANY.brand.red

export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || COMPANY.siteUrl).replace(/\/$/, '')
}

export function bookingLink(token: string): string {
  return `${siteUrl()}/booking/${token}`
}

export function receiptLink(token: string): string {
  return `${siteUrl()}/booking/${token}/receipt`
}

// Where the "Leave a Review" button points. Override with GOOGLE_REVIEW_URL.
export function reviewUrl(): string {
  return process.env.GOOGLE_REVIEW_URL || COMPANY.reviewUrl
}

function esc(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function resend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null
  return new Resend(process.env.RESEND_API_KEY)
}

function shell(heading: string, bodyHtml: string): string {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;color:#111">
    <div style="background:#0b0b0c;padding:22px 24px;border-radius:14px 14px 0 0">
      <p style="margin:0;font-size:20px;font-weight:800;color:#fff">${COMPANY.nameLead} <span style="color:${RED}">${COMPANY.nameAccent}</span></p>
    </div>
    <div style="border:1px solid #eee;border-top:none;border-radius:0 0 14px 14px;padding:24px">
      <h2 style="color:${RED};margin:0 0 14px;font-size:20px">${esc(heading)}</h2>
      ${bodyHtml}
      <hr style="border:none;border-top:1px solid #eee;margin:22px 0"/>
      <p style="color:#999;font-size:12px;margin:0">${COMPANY.legalName} · ${COMPANY.phoneDisplay} · ${COMPANY.email} · ${CREDENTIALS_SLASH}</p>
    </div>
  </div>`
}

function rows(pairs: [string, string | undefined][]): string {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${pairs
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#888;width:150px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`)
    .join('')}</table>`
}

function moneyBlock(b: Booking): string {
  return rows([
    ['Invoice Total', fmtUSD(b.invoiceAmountCents)],
    ['Discount' + (b.promoCode ? ` (${b.promoCode})` : ''), b.discountCents ? `– ${fmtUSD(b.discountCents)}` : undefined],
    ['Deposit', b.depositAmountCents ? fmtUSD(b.depositAmountCents) : undefined],
    ['Amount Paid', fmtUSD(b.amountPaidCents)],
    ['Balance Due', fmtUSD(balanceDueCents(b))],
  ])
}

function locationBlock(b: Booking): string {
  return rows([
    ['Pickup', b.pickupAddress],
    ['Drop-off', b.dropoffAddress],
    ['Job Site', b.jobSiteAddress],
  ])
}

async function send(args: { to: string[]; subject: string; html: string; replyTo?: string }): Promise<void> {
  const client = resend()
  if (!client) return
  try {
    await client.emails.send({ from: FROM, to: args.to, replyTo: args.replyTo, subject: args.subject, html: args.html })
  } catch (err) {
    console.error('[booking-emails]', args.subject, err)
  }
}

// Generic raw send (no booking shell) — used by owner-alert notifications & internal ops.
export async function emailRaw(args: { to: string[]; subject: string; html: string; replyTo?: string }): Promise<void> {
  return send(args)
}

// ── Customer-facing ──────────────────────────────────────────────────────────

// A free-form message the owner composes in the admin, delivered as a branded email.
// Returns true only if it actually went out (Resend configured + send succeeded) so
// the communications log can record per-channel results.
export async function emailCustomerMessage(b: Booking, text: string): Promise<boolean> {
  if (!b.customerEmail) return false
  const client = resend()
  if (!client) return false
  const para = esc(text).replace(/\n/g, '<br/>')
  const html = shell(`A message from ${COMPANY.legalName}`, `<p style="font-size:15px;line-height:1.6;color:#333;margin:0">${para}</p>`)
  try {
    await client.emails.send({
      from: FROM, to: [b.customerEmail], replyTo: COMPANY.email,
      subject: `${COMPANY.legalName} — regarding your booking (${b.bookingNumber})`, html,
    })
    return true
  } catch (err) {
    console.error('[booking-emails] customer message', err)
    return false
  }
}

export async function emailConfirmationLink(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const link = bookingLink(b.token)
  const body = `
    <p style="font-size:15px;line-height:1.6">Hi ${esc(b.customerName)}, your ${esc(SERVICE_LABELS[b.serviceType])} with ${COMPANY.legalName} is almost confirmed.</p>
    <p style="font-size:15px;line-height:1.6">Please open your secure booking page to verify your service date and arrival window, review the details, and complete any payment.</p>
    <p style="text-align:center;margin:26px 0">
      <a href="${link}" style="background:${RED};color:#fff;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;display:inline-block">View &amp; Confirm Your Booking →</a>
    </p>
    <p style="font-size:13px;color:#888">Booking ${esc(b.bookingNumber)}${b.invoiceNumber ? ` · Invoice ${esc(b.invoiceNumber)}` : ''}</p>
    ${moneyBlock(b)}`
  await send({ to: [b.customerEmail], subject: `Confirm your ${COMPANY.legalName} booking — ${b.bookingNumber}`, html: shell("You're almost booked", body) })
}

export async function emailTimeVerifiedCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">Thanks ${esc(b.customerName)} — your service time has been verified. ${COMPANY.legalName} will contact you if any adjustment is needed.</p>
    ${rows([['Service Date', b.selectedDate], ['Arrival Window', b.selectedWindow], ['Service', SERVICE_LABELS[b.serviceType]]])}
    <p style="font-size:14px;margin-top:16px">View your booking anytime: <a href="${bookingLink(b.token)}" style="color:${RED}">your booking page</a></p>`
  await send({ to: [b.customerEmail], subject: `Service time verified — ${b.bookingNumber}`, html: shell('Your service time is verified', body) })
}

export async function emailBookingConfirmedCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">You're officially booked with ${COMPANY.legalName}. Here are your confirmed details:</p>
    ${rows([['Service Date', b.selectedDate], ['Arrival Window', b.selectedWindow], ['Service', SERVICE_LABELS[b.serviceType]]])}
    ${locationBlock(b)}
    ${moneyBlock(b)}
    <p style="font-size:14px;margin-top:16px">Manage your booking: <a href="${bookingLink(b.token)}" style="color:${RED}">your booking page</a></p>`
  await send({ to: [b.customerEmail], subject: `You're booked with ${COMPANY.legalName} — ${b.bookingNumber}`, html: shell("You're officially booked", body) })
}

export async function emailPaymentReceiptCustomer(b: Booking, p: Payment): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">We received your ${esc(PAYMENT_METHOD_LABEL[p.method])} payment. Thank you!</p>
    ${rows([
      ['Applied to Invoice', fmtUSD(p.amountCents)],
      p.feeCents ? ['Processing Fee', fmtUSD(p.feeCents)] : ['', undefined],
      ['Total Charged', fmtUSD(p.totalChargedCents)],
    ])}
    ${moneyBlock(b)}`
  await send({ to: [b.customerEmail], subject: `Payment received — ${b.bookingNumber}`, html: shell('Payment received', body) })
}

export async function emailJobCompletedCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">Thank you for choosing ${COMPANY.legalName}, ${esc(b.customerName)}. Your ${esc(SERVICE_LABELS[b.serviceType])} is complete.</p>
    ${moneyBlock(b)}
    <p style="font-size:14px;line-height:1.6;margin-top:16px">We'd love a review, and we're here whenever you need us again.</p>`
  await send({ to: [b.customerEmail], subject: `Thanks from ${COMPANY.legalName} — ${b.bookingNumber}`, html: shell('Job complete', body) })
}

export async function emailPaidInFullCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const receipt = receiptLink(b.token)
  const body = `
    <p style="font-size:15px;line-height:1.6">Thank you, ${esc(b.customerName)} — your invoice is <strong>paid in full</strong>. We appreciate your business!</p>
    <p style="text-align:center;margin:24px 0">
      <a href="${receipt}" style="background:${RED};color:#fff;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;display:inline-block">View Your Paid Receipt →</a>
    </p>
    ${moneyBlock(b)}
    ${b.loyaltyCode ? `<div style="margin-top:22px;background:#0b0b0c;border-radius:12px;padding:18px;text-align:center;color:#fff">
      <p style="margin:0 0 6px;font-size:15px;font-weight:800">10% off your next job</p>
      <p style="margin:0 0 12px;font-size:13px;color:#b5b7bd;line-height:1.55">Use this code next time, or share it with a friend for their first booking:</p>
      <p style="margin:0;display:inline-block;background:${RED};color:#fff;font-weight:800;letter-spacing:2px;font-size:18px;padding:10px 20px;border-radius:8px">${esc(b.loyaltyCode)}</p>
    </div>` : ''}
    <div style="margin-top:22px;background:#fafafa;border:1px solid #eee;border-radius:12px;padding:18px;text-align:center">
      <p style="margin:0 0 6px;font-size:15px;font-weight:700">How did we do?</p>
      <p style="margin:0 0 14px;font-size:13px;color:#666;line-height:1.55">Leave a quick star rating right on your receipt — about 30 seconds. (Totally optional.)</p>
      <a href="${receipt}#review" style="background:#0b0b0c;color:#fff;font-weight:700;text-decoration:none;padding:11px 22px;border-radius:9px;display:inline-block;font-size:14px">Leave a Review →</a>
    </div>`
  await send({ to: [b.customerEmail], subject: `Paid in full — your ${COMPANY.legalName} receipt (${b.bookingNumber})`, html: shell('Paid in full — thank you!', body) })
}

// ── Automated reminders (sent by the daily cron) ─────────────────────────────

export async function emailBookingReminderCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const link = bookingLink(b.token)
  const body = `
    <p style="font-size:15px;line-height:1.6">Hi ${esc(b.customerName)}, just a friendly reminder to finish confirming your ${esc(SERVICE_LABELS[b.serviceType])} with ${COMPANY.legalName}. It only takes a minute.</p>
    <p style="text-align:center;margin:26px 0">
      <a href="${link}" style="background:${RED};color:#fff;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;display:inline-block">Confirm Your Booking →</a>
    </p>
    ${moneyBlock(b)}`
  await send({ to: [b.customerEmail], subject: `Reminder: confirm your ${COMPANY.legalName} booking — ${b.bookingNumber}`, html: shell('Finish confirming your booking', body) })
}

export async function emailPaymentReminderCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const link = bookingLink(b.token)
  const body = `
    <p style="font-size:15px;line-height:1.6">Hi ${esc(b.customerName)}, this is a friendly reminder that a balance of <strong>${fmtUSD(balanceDueCents(b))}</strong> remains on your ${COMPANY.legalName} invoice.</p>
    <p style="text-align:center;margin:26px 0">
      <a href="${link}" style="background:${RED};color:#fff;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;display:inline-block">View Invoice &amp; Pay →</a>
    </p>
    <p style="font-size:13px;color:#888">You can also pay fee-free by Zelle to jkissbiz@gmail.com — include ${esc(b.invoiceNumber ?? b.bookingNumber)} in the memo.</p>
    ${moneyBlock(b)}`
  await send({ to: [b.customerEmail], subject: `Balance reminder — ${COMPANY.legalName} ${b.bookingNumber}`, html: shell('A balance is due', body) })
}

export async function emailJobTomorrowCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">Hi ${esc(b.customerName)}, a quick heads-up — your ${esc(SERVICE_LABELS[b.serviceType])} with ${COMPANY.legalName} is <strong>tomorrow</strong>.</p>
    ${rows([['Date', b.selectedDate], ['Arrival Window', b.selectedWindow], ['Service', SERVICE_LABELS[b.serviceType]], ['Your Crew', [b.assignedTo, b.assignedHelper].filter(Boolean).join(' & ') || undefined]])}
    ${locationBlock(b)}
    <p style="font-size:14px;line-height:1.6;margin-top:14px">Please make sure the crew has clear access. Questions? Call or text ${COMPANY.phoneDisplay}.</p>`
  await send({ to: [b.customerEmail], subject: `Reminder: your ${COMPANY.legalName} service is tomorrow — ${b.bookingNumber}`, html: shell('See you tomorrow', body) })
}

export async function emailReviewRequestCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const receipt = receiptLink(b.token)
  const body = `
    <p style="font-size:15px;line-height:1.6">Hi ${esc(b.customerName)}, thanks again for choosing ${COMPANY.legalName} for your ${esc(SERVICE_LABELS[b.serviceType])}. How did we do?</p>
    <p style="font-size:14px;line-height:1.6;color:#555">A quick star rating takes about 30 seconds and really helps our small business.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="${receipt}#review" style="background:${RED};color:#fff;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;display:inline-block">Leave a Quick Review →</a>
    </p>`
  await send({ to: [b.customerEmail], subject: `How did we do? — ${COMPANY.legalName} ${b.bookingNumber}`, html: shell('Mind leaving a review?', body) })
}

// ── Rescheduling ─────────────────────────────────────────────────────────────

export async function emailRescheduledCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">Hi ${esc(b.customerName)}, your ${COMPANY.legalName} service has been <strong>rescheduled</strong>. Here are your updated details:</p>
    ${rows([['Service Date', b.selectedDate], ['Arrival Window', b.selectedWindow], ['Service', SERVICE_LABELS[b.serviceType]]])}
    <p style="font-size:14px;margin-top:14px">View your booking: <a href="${bookingLink(b.token)}" style="color:${RED}">your booking page</a></p>`
  await send({ to: [b.customerEmail], subject: `Your ${COMPANY.legalName} service was rescheduled — ${b.bookingNumber}`, html: shell('Your service is rescheduled', body) })
}

export async function emailRescheduleRequestAck(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">Thanks ${esc(b.customerName)} — we got your reschedule request and will reach out shortly to confirm a new time. Your current booking remains as-is until then.</p>
    ${rows([['Requested', b.rescheduleRequest?.requestedDate], ['Note', b.rescheduleRequest?.note]])}`
  await send({ to: [b.customerEmail], subject: `We received your reschedule request — ${b.bookingNumber}`, html: shell('Reschedule request received', body) })
}

export async function emailCancelledCustomer(b: Booking, tierLabel: string): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">Hi ${esc(b.customerName)}, your ${COMPANY.legalName} booking <strong>${esc(b.bookingNumber)}</strong> has been <strong>cancelled</strong> as requested.</p>
    <div style="margin:14px 0;background:#fafafa;border:1px solid #eee;border-radius:10px;padding:14px">
      <p style="margin:0;font-size:14px;line-height:1.55"><strong>Deposit / refund:</strong> ${esc(tierLabel)}</p>
    </div>
    <p style="font-size:14px;line-height:1.6">Any eligible refund or credit will be processed within a few business days. Questions? Call or text ${COMPANY.phoneDisplay}.</p>`
  await send({ to: [b.customerEmail], subject: `Cancelled — ${COMPANY.legalName} ${b.bookingNumber}`, html: shell('Your booking is cancelled', body) })
}

// Human-readable date for a yyyy-mm-dd string (parsed LOCAL so it doesn't slip).
function niceDate(iso?: string): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || ''
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

// The customer-facing continuation message — shared by the admin "copy" button,
// the email, and the SMS so the wording is identical everywhere.
export function continuationMessage(b: Booking): string {
  const c = b.continuation
  const svc = (SERVICE_LABELS[b.serviceType] ?? 'job').toLowerCase()
  const because = c?.reason ? ` because ${c.reason}` : ' in one trip'
  const when = c?.returnDate ? ` on ${niceDate(c.returnDate)}${c?.returnWindow ? ` (${c.returnWindow})` : ''}` : ' soon'
  const remaining = c?.remainingWork ? ` to finish ${c.remainingWork}` : ' to finish the remaining work'
  return `Hi ${b.customerName}, we started your ${svc} but couldn't complete everything${because}. We'd like to return${when}${remaining}. Please confirm this works (or pick another date) here: ${bookingLink(b.token)} — ${COMPANY.legalName}`
}

export async function emailContinuationCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const c = b.continuation
  const link = bookingLink(b.token)
  const svc = (SERVICE_LABELS[b.serviceType] ?? 'job').toLowerCase()
  const because = c?.reason ? ` because ${esc(c.reason)}` : ''
  const body = `
    <p style="font-size:15px;line-height:1.6">Hi ${esc(b.customerName)}, we started your ${esc(svc)} but couldn't finish everything in one trip${because}. We'd like to come back to wrap it up — please confirm the return time below works for you.</p>
    ${rows([['Proposed return date', c?.returnDate ? niceDate(c.returnDate) : 'Please pick a date'], ['Arrival window', c?.returnWindow], ['Remaining work', c?.remainingWork]])}
    <p style="text-align:center;margin:22px 0">
      <a href="${link}" style="display:inline-block;background:${RED};color:#fff;font-weight:700;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:10px">Confirm your return visit →</a>
    </p>
    <p style="font-size:13px;color:#888;margin-top:8px;text-align:center">If that date doesn’t work, you can request a different one from the same page.</p>
    <p style="font-size:13px;color:#888;margin-top:12px">Questions? Call or text ${COMPANY.phoneDisplay}. Your booking ${esc(b.bookingNumber)} stays the same — no need to rebook.</p>`
  await send({ to: [b.customerEmail], subject: `Confirm your return visit — ${COMPANY.legalName} ${b.bookingNumber}`, html: shell('Confirm your return visit', body) })
}

// Ops alert: the customer confirmed the proposed return date.
export async function emailOpsReturnConfirmed(b: Booking): Promise<void> {
  const c = b.continuation
  const body = `${opsCustomerRows(b)}
    ${rows([['Confirmed return', c?.returnDate ? niceDate(c.returnDate) : '—'], ['Arrival window', c?.returnWindow], ['Remaining work', c?.remainingWork]])}
    <p style="font-size:14px;margin-top:10px;color:#0a7a2f"><strong>The customer confirmed this return date.</strong> You’re good to schedule the crew.</p>
    <p style="font-size:13px;margin-top:8px">Booking: <a href="${bookingLink(b.token)}">${esc(b.bookingNumber)}</a></p>`
  await send({ to: OPS, subject: `Return confirmed — ${b.bookingNumber} (${b.customerName})`, html: shell('Customer confirmed the return date', body) })
}

// Ops alert: the customer asked for a different return date.
export async function emailOpsReturnChangeRequest(b: Booking): Promise<void> {
  const r = b.continuation?.returnChangeRequest
  const body = `${opsCustomerRows(b)}
    ${rows([['Currently proposed', b.continuation?.returnDate ? niceDate(b.continuation.returnDate) : '—'], ['Customer prefers', r?.requestedDate ? niceDate(r.requestedDate) : '—'], ['Their note', r?.note]])}
    <p style="font-size:14px;margin-top:10px"><strong>The customer requested a different return date.</strong> Reach out to coordinate, then update + re-save the continuation to send a fresh confirmation.</p>
    <p style="font-size:13px;margin-top:8px">Booking: <a href="${bookingLink(b.token)}">${esc(b.bookingNumber)}</a></p>`
  await send({ to: OPS, subject: `Return-date change requested — ${b.bookingNumber} (${b.customerName})`, html: shell('Customer requested a different return date', body) })
}

export async function emailRefundCustomer(b: Booking, refundCents: number): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">Hi ${esc(b.customerName)}, a refund of <strong>${fmtUSD(refundCents)}</strong> has been issued to your original payment method for booking <strong>${esc(b.bookingNumber)}</strong>.</p>
    <p style="font-size:14px;line-height:1.6;color:#555">It typically takes 5–10 business days to appear, depending on your bank. Questions? Call or text ${COMPANY.phoneDisplay}.</p>`
  await send({ to: [b.customerEmail], subject: `Refund issued — ${fmtUSD(refundCents)} · ${COMPANY.legalName} ${b.bookingNumber}`, html: shell('Your refund is on the way', body) })
}

export async function emailOpsCancelledByCustomer(b: Booking, tierLabel: string): Promise<void> {
  const body = `${opsCustomerRows(b)}
    ${rows([['Service Date', b.selectedDate || b.availableDates?.[0]], ['Deposit/Refund tier', tierLabel], ['Amount Paid', fmtUSD(b.amountPaidCents)]])}
    <p style="font-size:13px;margin-top:10px">Process any refund/credit per the tier above. Link: <a href="${bookingLink(b.token)}">${bookingLink(b.token)}</a></p>`
  await send({ to: OPS, subject: `Customer cancelled — ${b.bookingNumber} (${b.customerName})`, html: shell('Customer cancelled their booking', body) })
}

export async function emailOpsRescheduled(b: Booking): Promise<void> {
  const req = b.rescheduleRequest
  const body = `${opsCustomerRows(b)}
    ${req
      ? rows([['Requested Date', req.requestedDate], ['Customer Note', req.note]])
      : rows([['New Service Date', b.selectedDate], ['New Arrival Window', b.selectedWindow], ['Reschedules', String(b.rescheduleCount ?? 1)]])}
    <p style="font-size:13px;margin-top:10px">Link: <a href="${bookingLink(b.token)}">${bookingLink(b.token)}</a></p>`
  await send({ to: OPS, subject: `${req ? 'Reschedule request' : 'Booking rescheduled'} — ${b.bookingNumber} (${b.customerName})`, html: shell(req ? 'Customer requested a reschedule' : 'Customer rescheduled', body) })
}

// ── Ops-facing ───────────────────────────────────────────────────────────────

function opsCustomerRows(b: Booking): string {
  return rows([
    ['Booking #', b.bookingNumber],
    ['Invoice #', b.invoiceNumber],
    ['Customer', b.customerName],
    ['Phone', b.customerPhone],
    ['Email', b.customerEmail],
    ['Service', SERVICE_LABELS[b.serviceType]],
    ['Status', BOOKING_STATUS_LABEL[b.status]],
  ])
}

export async function emailOpsBookingCreated(b: Booking): Promise<void> {
  const body = `${opsCustomerRows(b)}${locationBlock(b)}${moneyBlock(b)}
    <p style="font-size:13px;margin-top:14px">Link: <a href="${bookingLink(b.token)}">${bookingLink(b.token)}</a></p>`
  await send({ to: OPS, subject: `Booking created — ${b.bookingNumber} (${b.customerName})`, html: shell('Booking created', body) })
}

export async function emailOpsBookingViewed(b: Booking): Promise<void> {
  await send({ to: OPS, subject: `Customer viewed booking — ${b.bookingNumber}`, html: shell('Customer opened their booking', opsCustomerRows(b)) })
}

export async function emailOpsTimeVerified(b: Booking): Promise<void> {
  const body = `${rows([
    ['Service Date', b.selectedDate],
    ['Arrival Window', b.selectedWindow],
    ['Gate Code', b.gateCode],
    ['Parking', b.parkingNotes],
    ['Access', b.accessNotes],
    ['Special Instructions', b.specialInstructions],
    ['Customer Notes', b.customerNotes],
  ])}${opsCustomerRows(b)}`
  await send({ to: OPS, subject: `Time verified — ${b.bookingNumber} (${b.customerName})`, html: shell('Customer verified service time', body) })
}

export async function emailOpsPaymentReceived(b: Booking, p: Payment): Promise<void> {
  const body = `${rows([
    ['Method', PAYMENT_METHOD_LABEL[p.method]],
    ['Type', p.type],
    ['Applied to Invoice', fmtUSD(p.amountCents)],
    ['Processing Fee', fmtUSD(p.feeCents)],
    ['Total Charged', fmtUSD(p.totalChargedCents)],
    ['Stripe Session', p.stripeSessionId],
  ])}${opsCustomerRows(b)}${moneyBlock(b)}`
  await send({ to: OPS, subject: `Payment received — ${b.bookingNumber} (${fmtUSD(p.amountCents)})`, html: shell('Stripe payment received', body) })
}

export async function emailOpsReviewLeft(b: Booking, rating: number, text?: string): Promise<void> {
  const stars = '★★★★★'.slice(0, rating) + '☆☆☆☆☆'.slice(0, 5 - rating)
  const body = `<p style="font-size:15px">A customer left a review on the website.</p>${rows([
    ['Rating', `${stars} (${rating}/5)`],
    ['Review', text || '(no comment)'],
  ])}${opsCustomerRows(b)}
    <p style="font-size:13px;margin-top:14px">Manage it in the admin: <a href="${siteUrl()}/admin/reviews">/admin/reviews</a></p>`
  await send({ to: OPS, subject: `New ${rating}★ review — ${b.bookingNumber} (${b.customerName})`, html: shell('New customer review', body) })
}

export async function emailOpsManualPaymentSubmitted(b: Booking, p: Payment): Promise<void> {
  const body = `<p style="font-size:15px">A customer reported sending a manual payment. Confirm it in the admin once funds land.</p>${rows([
    ['Method', PAYMENT_METHOD_LABEL[p.method]],
    ['Amount Reported', fmtUSD(p.amountCents)],
    ['Reference', p.reference],
  ])}${opsCustomerRows(b)}`
  await send({ to: OPS, subject: `Manual payment reported — ${b.bookingNumber} (${fmtUSD(p.amountCents)})`, html: shell('Manual payment reported', body) })
}
