// Template catalog (Phase 3). One entry per CommEvent, each with an SMS body and
// (where appropriate) a branded email. Templates are pure functions of CommContext
// — no Redis, no providers — so they render identically in preview, test, and live.
//
// Rules honored here:
//  • clear J KISS LLC branding, no spammy language (no ALL CAPS shouting, no
//    "act now", no exclamation spam);
//  • variable validation — each template declares the context keys it needs;
//    renderTemplate reports which are missing;
//  • safe fallback text — a missing variable degrades to a neutral phrase, never
//    a blank or "undefined", so a half-populated context still sends readable copy.

import { COMPANY } from '../company'
import type { CommContext } from './context'
import { withSample } from './context'
import type { CommChannel, CommEvent } from './events'
import { getEventDef } from './events'
import { emailShell, button, unsubLine, esc } from './email-shell'

const BRAND = COMPANY.legalName
const BRAND_UP = COMPANY.legalNameUpper
const STOP = ' Reply STOP to opt out.'

// value-or-fallback: templates read context through this so a missing field
// degrades gracefully instead of printing "undefined".
function v(x: string | undefined, fallback: string): string {
  const s = (x ?? '').toString().trim()
  return s ? s : fallback
}

// A pre-formatted date/window phrase with a safe fallback.
function whenText(c: CommContext): string {
  const d = (c.dateText ?? '').trim()
  const w = (c.windowText ?? '').trim()
  if (d && w) return `${d}, ${w}`
  if (d) return d
  if (w) return w
  return 'your scheduled time'
}

export type RenderedEmail = { subject: string; html: string }
export type Rendered = {
  sms?: string
  email?: RenderedEmail
  missing: string[]        // required context keys that were absent
  channels: CommChannel[]  // channels actually rendered
}

type TemplateDef = {
  event: CommEvent
  // Context keys required for a fully meaningful message. Missing keys don't block
  // rendering (safe fallbacks fill in) but are surfaced for validation/preview.
  required: (keyof CommContext)[]
  sms: (c: CommContext) => string
  email?: (c: CommContext) => RenderedEmail
}

// Shared paragraph builder for emails.
const p = (html: string) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${html}</p>`

const TEMPLATES: Record<CommEvent, TemplateDef> = {
  BOOKING_RECEIVED: {
    event: 'BOOKING_RECEIVED', required: ['customerName', 'bookingNumber', 'bookingLink'],
    sms: c => `${BRAND_UP}: Hi ${v(c.customerName, 'there')}, we received your request (${v(c.bookingNumber, 'your booking')}). Review the details and confirm your time here: ${v(c.bookingLink, COMPANY.siteUrl)}${STOP}`,
    email: c => ({
      subject: `We received your request — ${v(c.bookingNumber, BRAND)}`,
      html: emailShell('Thanks — we’ve got your request',
        p(`Hi ${esc(v(c.customerName, 'there'))}, thanks for reaching out to ${esc(BRAND)}. We received your request <strong>${esc(v(c.bookingNumber, ''))}</strong> and we’re reviewing it now.`) +
        p('You can review the details and confirm your preferred time using the button below.') +
        button('Review & Confirm', c.bookingLink)),
    }),
  },

  QUOTE_SENT: {
    event: 'QUOTE_SENT', required: ['customerName', 'amountText', 'bookingLink'],
    sms: c => `${BRAND}: Hi ${v(c.customerName, 'there')}, your quote is ready${c.amountText ? ` — ${c.amountText}` : ''}. View it and book here: ${v(c.bookingLink, COMPANY.siteUrl)}${STOP}`,
    email: c => ({
      subject: `Your quote from ${BRAND}${c.amountText ? ` — ${c.amountText}` : ''}`,
      html: emailShell('Your quote is ready',
        p(`Hi ${esc(v(c.customerName, 'there'))}, here is your quote from ${esc(BRAND)}${c.amountText ? ` for <strong>${esc(c.amountText)}</strong>` : ''}.`) +
        p('Review the full details and reserve your spot whenever you’re ready.') +
        button('View Quote', c.bookingLink)),
    }),
  },

  QUOTE_REMINDER: {
    event: 'QUOTE_REMINDER', required: ['customerName', 'bookingLink'],
    sms: c => `${BRAND}: Hi ${v(c.customerName, 'there')}, just a friendly reminder your quote${c.amountText ? ` (${c.amountText})` : ''} is still available. Book here when ready: ${v(c.bookingLink, COMPANY.siteUrl)}${STOP}`,
    email: c => ({
      subject: `Your ${BRAND} quote is still available`,
      html: emailShell('Still thinking it over?',
        p(`Hi ${esc(v(c.customerName, 'there'))}, your quote${c.amountText ? ` for <strong>${esc(c.amountText)}</strong>` : ''} is still open. We’d be glad to help whenever the timing works for you.`) +
        button('View Quote', c.bookingLink) + unsubLine()),
    }),
  },

  BOOKING_CONFIRMED: {
    event: 'BOOKING_CONFIRMED', required: ['customerName', 'bookingNumber', 'bookingLink'],
    sms: c => `${BRAND}: You’re booked, ${v(c.customerName, 'thanks')} (${v(c.bookingNumber, '')}). ${whenText(c)}.${c.balanceText ? ` Balance due: ${c.balanceText}.` : ''} Details: ${v(c.bookingLink, COMPANY.siteUrl)}`,
    email: c => ({
      subject: `You’re booked — ${v(c.bookingNumber, BRAND)}`,
      html: emailShell('Your booking is confirmed',
        p(`Hi ${esc(v(c.customerName, 'there'))}, your booking <strong>${esc(v(c.bookingNumber, ''))}</strong> is confirmed for <strong>${esc(whenText(c))}</strong>.`) +
        (c.balanceText ? p(`Balance due at service: <strong>${esc(c.balanceText)}</strong>.`) : '') +
        button('View Booking', c.bookingLink)),
    }),
  },

  APPOINTMENT_REMINDER: {
    event: 'APPOINTMENT_REMINDER', required: ['customerName', 'bookingNumber'],
    sms: c => `${BRAND}: Reminder — your service (${v(c.bookingNumber, '')}) is ${whenText(c)}.${c.address ? ` At ${c.address}.` : ''} Please ensure clear access. Questions? ${COMPANY.phoneDisplay}.${STOP}`,
    email: c => ({
      subject: `Reminder: your ${BRAND} appointment is coming up`,
      html: emailShell('Your appointment is almost here',
        p(`Hi ${esc(v(c.customerName, 'there'))}, this is a reminder that your service <strong>${esc(v(c.bookingNumber, ''))}</strong> is scheduled for <strong>${esc(whenText(c))}</strong>.`) +
        (c.address ? p(`Location: ${esc(c.address)}`) : '') +
        p('Please make sure the crew has clear access when they arrive.') +
        button('View Details', c.bookingLink) + unsubLine()),
    }),
  },

  CREW_DISPATCHED: {
    event: 'CREW_DISPATCHED', required: ['customerName', 'crewName'],
    sms: c => `${BRAND}: Good news ${v(c.customerName, 'there')} — ${v(c.crewName, 'your crew')} has been dispatched for your service ${whenText(c)}.${c.trackingLink ? ` Track status: ${c.trackingLink}` : ''}`,
    email: c => ({
      subject: `Your ${BRAND} crew is on the schedule`,
      html: emailShell('Your crew has been dispatched',
        p(`Hi ${esc(v(c.customerName, 'there'))}, <strong>${esc(v(c.crewName, 'your crew'))}</strong> has been dispatched for your service on <strong>${esc(whenText(c))}</strong>.`) +
        button('Track Status', c.trackingLink)),
    }),
  },

  ON_THE_WAY: {
    event: 'ON_THE_WAY', required: ['customerName', 'crewName'],
    sms: c => `${BRAND}: ${v(c.crewName, 'Your crew')} is on the way${c.etaText ? ` — ETA ${c.etaText}` : ''}, ${v(c.customerName, 'thanks')}.${c.trackingLink ? ` Live status: ${c.trackingLink}` : ''}`,
    email: c => ({
      subject: `${BRAND}: your crew is on the way`,
      html: emailShell('On the way',
        p(`Hi ${esc(v(c.customerName, 'there'))}, <strong>${esc(v(c.crewName, 'your crew'))}</strong> is on the way${c.etaText ? ` and should arrive in <strong>${esc(c.etaText)}</strong>` : ''}.`) +
        button('Live Status', c.trackingLink)),
    }),
  },

  ETA_UPDATED: {
    event: 'ETA_UPDATED', required: ['etaText'],
    sms: c => `${BRAND}: Updated arrival estimate — ${v(c.crewName, 'your crew')} is now expected in ${v(c.etaText, 'a short while')}.${c.trackingLink ? ` ${c.trackingLink}` : ''}`,
  },

  ARRIVED: {
    event: 'ARRIVED', required: ['customerName', 'crewName'],
    sms: c => `${BRAND}: ${v(c.crewName, 'Your crew')} has arrived${c.address ? ` at ${c.address}` : ''}, ${v(c.customerName, 'thanks')}. Please meet them when you can.`,
  },

  JOB_COMPLETED: {
    event: 'JOB_COMPLETED', required: ['customerName', 'bookingNumber'],
    sms: c => `${BRAND}: Your service (${v(c.bookingNumber, '')}) is complete — thank you, ${v(c.customerName, 'so much')}!${c.balanceText ? ` Balance due: ${c.balanceText}.` : ''}`,
    email: c => ({
      subject: `Your ${BRAND} service is complete`,
      html: emailShell('All done — thank you',
        p(`Hi ${esc(v(c.customerName, 'there'))}, your service <strong>${esc(v(c.bookingNumber, ''))}</strong> is complete. It was a pleasure working with you.`) +
        (c.balanceText ? p(`Balance due: <strong>${esc(c.balanceText)}</strong>.`) : '') +
        button('View Receipt', c.invoiceLink)),
    }),
  },

  INVOICE_SENT: {
    event: 'INVOICE_SENT', required: ['customerName', 'amountText', 'invoiceLink'],
    sms: c => `${BRAND}: Your invoice${c.invoiceNumber ? ` ${c.invoiceNumber}` : ''} for ${v(c.amountText, 'your service')} is ready. View & pay securely: ${v(c.invoiceLink, COMPANY.siteUrl)}`,
    email: c => ({
      subject: `Invoice${c.invoiceNumber ? ` ${c.invoiceNumber}` : ''} from ${BRAND}`,
      html: emailShell('Your invoice is ready',
        p(`Hi ${esc(v(c.customerName, 'there'))}, your invoice${c.invoiceNumber ? ` <strong>${esc(c.invoiceNumber)}</strong>` : ''} for <strong>${esc(v(c.amountText, ''))}</strong> is ready.`) +
        (c.balanceText ? p(`Balance due: <strong>${esc(c.balanceText)}</strong>.`) : '') +
        p(`You can pay securely online, or fee-free by Zelle to ${esc(COMPANY.zelle)}.`) +
        button('View & Pay', c.invoiceLink)),
    }),
  },

  INVOICE_REMINDER: {
    event: 'INVOICE_REMINDER', required: ['customerName', 'balanceText', 'invoiceLink'],
    sms: c => `${BRAND}: Friendly reminder — a balance of ${v(c.balanceText, 'your invoice')} is due${c.invoiceNumber ? ` on ${c.invoiceNumber}` : ''}. Pay here or by Zelle (${COMPANY.zelle}): ${v(c.invoiceLink, COMPANY.siteUrl)}${STOP}`,
    email: c => ({
      subject: `Reminder: balance due${c.invoiceNumber ? ` on ${c.invoiceNumber}` : ''}`,
      html: emailShell('A quick payment reminder',
        p(`Hi ${esc(v(c.customerName, 'there'))}, a balance of <strong>${esc(v(c.balanceText, ''))}</strong> is still due${c.invoiceNumber ? ` on invoice <strong>${esc(c.invoiceNumber)}</strong>` : ''}.`) +
        p(`You can pay securely online, or fee-free by Zelle to ${esc(COMPANY.zelle)}.`) +
        button('Pay Now', c.invoiceLink) + unsubLine()),
    }),
  },

  PAYMENT_RECEIVED: {
    event: 'PAYMENT_RECEIVED', required: ['customerName'],
    sms: c => `${BRAND}: Payment received — thank you, ${v(c.customerName, 'so much')}!${c.amountText ? ` We applied ${c.amountText}.` : ''}${c.invoiceLink ? ` Receipt: ${c.invoiceLink}` : ''}`,
    email: c => ({
      subject: `Payment received — thank you`,
      html: emailShell('Payment received',
        p(`Hi ${esc(v(c.customerName, 'there'))}, we’ve received your payment${c.amountText ? ` of <strong>${esc(c.amountText)}</strong>` : ''}. Thank you!`) +
        (c.balanceText ? p(`Remaining balance: <strong>${esc(c.balanceText)}</strong>.`) : '') +
        button('View Receipt', c.invoiceLink)),
    }),
  },

  REVIEW_REQUEST: {
    event: 'REVIEW_REQUEST', required: ['customerName', 'reviewLink'],
    sms: c => `${BRAND}: Thanks again, ${v(c.customerName, 'so much')}! How did we do? A quick review really helps: ${v(c.reviewLink, COMPANY.reviewUrl)}${STOP}`,
    email: c => ({
      subject: `How did we do, ${v(c.customerName, 'thanks')}?`,
      html: emailShell('We’d love your feedback',
        p(`Hi ${esc(v(c.customerName, 'there'))}, thank you for choosing ${esc(BRAND)}. If you have a moment, a quick review would mean a lot and helps other customers find us.`) +
        button('Leave a Review', c.reviewLink) + unsubLine()),
    }),
  },

  JOB_CANCELLED: {
    event: 'JOB_CANCELLED', required: ['customerName', 'bookingNumber'],
    sms: c => `${BRAND}: Your booking ${v(c.bookingNumber, '')} has been cancelled${c.note ? `. ${c.note}` : ''}. Questions? ${COMPANY.phoneDisplay}.`,
    email: c => ({
      subject: `Your ${BRAND} booking has been cancelled`,
      html: emailShell('Booking cancelled',
        p(`Hi ${esc(v(c.customerName, 'there'))}, your booking <strong>${esc(v(c.bookingNumber, ''))}</strong> has been cancelled.`) +
        (c.note ? p(esc(c.note)) : '') +
        p(`If this was a mistake or you’d like to rebook, just reply or call ${esc(COMPANY.phoneDisplay)}.`)),
    }),
  },

  JOB_RESCHEDULED: {
    event: 'JOB_RESCHEDULED', required: ['customerName', 'bookingNumber'],
    sms: c => `${BRAND}: Your service (${v(c.bookingNumber, '')}) is rescheduled to ${whenText(c)}.${c.bookingLink ? ` Details: ${c.bookingLink}` : ''}`,
    email: c => ({
      subject: `Your ${BRAND} appointment has been rescheduled`,
      html: emailShell('Your appointment was rescheduled',
        p(`Hi ${esc(v(c.customerName, 'there'))}, your service <strong>${esc(v(c.bookingNumber, ''))}</strong> is now scheduled for <strong>${esc(whenText(c))}</strong>.`) +
        button('View Details', c.bookingLink)),
    }),
  },

  INTERNAL_DISPATCH: {
    event: 'INTERNAL_DISPATCH', required: ['crewName', 'note'],
    sms: c => `${BRAND} Dispatch: ${v(c.note, 'Please check the app for your latest assignment.')}${c.address ? ` Location: ${c.address}.` : ''}`,
  },
}

export function getTemplate(event: CommEvent): TemplateDef {
  return TEMPLATES[getEventDef(event).event]
}

// Render a template for a context. Reports missing required keys and only renders
// the channels the event supports intersected with `channels` (defaults to the
// event's own channel set). Never throws on missing data — safe fallbacks apply.
export function renderTemplate(event: CommEvent, ctx: CommContext, channels?: CommChannel[]): Rendered {
  const def = getEventDef(event)
  const t = getTemplate(event)
  const want = (channels && channels.length ? channels : def.channels)
    .filter(ch => def.channels.includes(ch))
  const missing = t.required.filter(k => {
    const val = ctx[k]
    return val === undefined || String(val).trim() === ''
  })
  const out: Rendered = { missing, channels: [] }
  if (want.includes('sms')) {
    out.sms = t.sms(ctx)
    out.channels.push('sms')
  }
  if (want.includes('email') && t.email) {
    out.email = t.email(ctx)
    out.channels.push('email')
  }
  return out
}

// A SMS/email-safe preview built from sample data merged over any partial context.
export function previewTemplate(event: CommEvent, ctx?: Partial<CommContext>): Rendered {
  return renderTemplate(event, withSample(ctx))
}
