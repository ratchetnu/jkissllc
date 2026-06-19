import { Resend } from 'resend'
import {
  type Booking, type Payment,
  SERVICE_LABELS, fmtUSD, balanceDueCents, BOOKING_STATUS_LABEL, PAYMENT_METHOD_LABEL,
} from './bookings'

const FROM = 'J Kiss LLC <info@jkissllc.com>'
const OPS = ['info@jkissllc.com', 'timmothy@jkissllc.com']
const RED = '#E0002A'

export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || 'https://www.jkissllc.com').replace(/\/$/, '')
}

export function bookingLink(token: string): string {
  return `${siteUrl()}/booking/${token}`
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
      <p style="margin:0;font-size:20px;font-weight:800;color:#fff">J Kiss <span style="color:${RED}">LLC</span></p>
    </div>
    <div style="border:1px solid #eee;border-top:none;border-radius:0 0 14px 14px;padding:24px">
      <h2 style="color:${RED};margin:0 0 14px;font-size:20px">${esc(heading)}</h2>
      ${bodyHtml}
      <hr style="border:none;border-top:1px solid #eee;margin:22px 0"/>
      <p style="color:#999;font-size:12px;margin:0">J Kiss LLC · (817) 909-4312 · info@jkissllc.com · US DOT 3484556 / MC 01155352</p>
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

// ── Customer-facing ──────────────────────────────────────────────────────────

export async function emailConfirmationLink(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const link = bookingLink(b.token)
  const body = `
    <p style="font-size:15px;line-height:1.6">Hi ${esc(b.customerName)}, your ${esc(SERVICE_LABELS[b.serviceType])} with J Kiss LLC is almost confirmed.</p>
    <p style="font-size:15px;line-height:1.6">Please open your secure booking page to verify your service date and arrival window, review the details, and complete any payment.</p>
    <p style="text-align:center;margin:26px 0">
      <a href="${link}" style="background:${RED};color:#fff;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;display:inline-block">View &amp; Confirm Your Booking →</a>
    </p>
    <p style="font-size:13px;color:#888">Booking ${esc(b.bookingNumber)}${b.invoiceNumber ? ` · Invoice ${esc(b.invoiceNumber)}` : ''}</p>
    ${moneyBlock(b)}`
  await send({ to: [b.customerEmail], subject: `Confirm your J Kiss LLC booking — ${b.bookingNumber}`, html: shell("You're almost booked", body) })
}

export async function emailTimeVerifiedCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">Thanks ${esc(b.customerName)} — your service time has been verified. J Kiss LLC will contact you if any adjustment is needed.</p>
    ${rows([['Service Date', b.selectedDate], ['Arrival Window', b.selectedWindow], ['Service', SERVICE_LABELS[b.serviceType]]])}
    <p style="font-size:14px;margin-top:16px">View your booking anytime: <a href="${bookingLink(b.token)}" style="color:${RED}">your booking page</a></p>`
  await send({ to: [b.customerEmail], subject: `Service time verified — ${b.bookingNumber}`, html: shell('Your service time is verified', body) })
}

export async function emailBookingConfirmedCustomer(b: Booking): Promise<void> {
  if (!b.customerEmail) return
  const body = `
    <p style="font-size:15px;line-height:1.6">You're officially booked with J Kiss LLC. Here are your confirmed details:</p>
    ${rows([['Service Date', b.selectedDate], ['Arrival Window', b.selectedWindow], ['Service', SERVICE_LABELS[b.serviceType]]])}
    ${locationBlock(b)}
    ${moneyBlock(b)}
    <p style="font-size:14px;margin-top:16px">Manage your booking: <a href="${bookingLink(b.token)}" style="color:${RED}">your booking page</a></p>`
  await send({ to: [b.customerEmail], subject: `You're booked with J Kiss LLC — ${b.bookingNumber}`, html: shell("You're officially booked", body) })
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
    <p style="font-size:15px;line-height:1.6">Thank you for choosing J Kiss LLC, ${esc(b.customerName)}. Your ${esc(SERVICE_LABELS[b.serviceType])} is complete.</p>
    ${moneyBlock(b)}
    <p style="font-size:14px;line-height:1.6;margin-top:16px">We'd love a review, and we're here whenever you need us again.</p>`
  await send({ to: [b.customerEmail], subject: `Thanks from J Kiss LLC — ${b.bookingNumber}`, html: shell('Job complete', body) })
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

export async function emailOpsManualPaymentSubmitted(b: Booking, p: Payment): Promise<void> {
  const body = `<p style="font-size:15px">A customer reported sending a manual payment. Confirm it in the admin once funds land.</p>${rows([
    ['Method', PAYMENT_METHOD_LABEL[p.method]],
    ['Amount Reported', fmtUSD(p.amountCents)],
    ['Reference', p.reference],
  ])}${opsCustomerRows(b)}`
  await send({ to: OPS, subject: `Manual payment reported — ${b.bookingNumber} (${fmtUSD(p.amountCents)})`, html: shell('Manual payment reported', body) })
}
