import { COMPANY } from './company'
import { sendSmsDetailed, toE164 } from './sms'
import { emailRaw } from './booking-emails'
import { recordMessage, type MsgKind } from './messages'
import type { ReminderChannel } from './reminder-templates'

// Crew delivery layer — fans ONE internal message out across the rails a crew member
// has (in-app + SMS + email), reusing the existing providers (Twilio via sendSms,
// Resend via emailRaw, the Messages hub via recordMessage). This is the crew-side
// mirror of lib/notify.ts; it never re-implements a provider.
//
// `push` has no web-push transport yet, so it degrades to an in-app message (nothing
// is dropped) and is reported truthfully as delivered-in-app. Real web-push can be
// wired here later without changing any caller. See docs/opspilot-future-improvements.

const BASE = (process.env.NEXT_PUBLIC_SITE_URL || COMPANY.siteUrlApex).replace(/\/$/, '')

export type CrewRecipient = {
  id: string
  name: string
  phone?: string
  email?: string
}

export type DeliverOpts = {
  staff: CrewRecipient
  title: string
  message: string
  channels: ReminderChannel[]
  kind: MsgKind
  reminderId?: string
  ackUrl?: string          // public one-tap acknowledgement link (if the send requires ack)
  tags?: string[]
}

export type DeliverResult = {
  channelResults: Partial<Record<ReminderChannel, boolean>>
  messageId?: string       // the in-app Message id (present whenever inapp/push ran)
  anyDelivered: boolean
}

function smsBody(o: DeliverOpts): string {
  const tail = o.ackUrl ? ` Respond: ${o.ackUrl}` : ''
  return `${COMPANY.legalName}: ${o.message}${tail} Reply STOP to opt out.`
}

function emailHtml(o: DeliverOpts): string {
  const cta = o.ackUrl
    ? `<p style="margin:22px 0 8px"><a href="${o.ackUrl}" style="display:inline-block;background:#E0002A;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">Open &amp; Respond</a></p>`
    : ''
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
    <h2 style="font-size:19px;margin:0 0 8px">${escapeHtml(o.title)}</h2>
    <p style="font-size:15px;line-height:1.5;color:#333;margin:0">${escapeHtml(o.message)}</p>
    ${cta}
    <p style="font-size:12px;color:#888;margin-top:20px">Sent by ${escapeHtml(COMPANY.legalName)} dispatch. Manage everything in your crew portal: <a href="${BASE}/portal" style="color:#E0002A">${BASE}/portal</a></p>
  </div>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c))
}

// Deliver to one crew member. In-app is always the system of record for a crew
// message; SMS/email are best-effort and gated on having contact info + a provider.
export async function deliverToCrew(o: DeliverOpts): Promise<DeliverResult> {
  const results: Partial<Record<ReminderChannel, boolean>> = {}
  let messageId: string | undefined

  const wantsInApp = o.channels.includes('inapp') || o.channels.includes('push')

  // 1) In-app (and push, which currently rides in-app) — the durable copy the crew
  //    portal and the ops Crew thread both read.
  if (wantsInApp) {
    try {
      const m = await recordMessage({
        direction: 'outbound',
        channel: 'system',
        provider: 'system',
        body: o.message,
        subject: o.title,
        staffId: o.staff.id,
        crewName: o.staff.name,
        kind: o.kind,
        reminderId: o.reminderId,
        status: 'delivered',
        unread: false,
        tags: o.tags ?? [o.kind],
      })
      messageId = m.id
      if (o.channels.includes('inapp')) results.inapp = true
      if (o.channels.includes('push')) results.push = true
    } catch (e) {
      console.error('[crew-notify] in-app record failed', e)
      if (o.channels.includes('inapp')) results.inapp = false
      if (o.channels.includes('push')) results.push = false
    }
  }

  // 2) SMS — reuse the Twilio layer (honors per-phone opt-out + E.164 normalization).
  if (o.channels.includes('sms')) {
    if (toE164(o.staff.phone)) {
      const r = await sendSmsDetailed(o.staff.phone, smsBody(o))
      results.sms = r.ok
    } else {
      results.sms = false
    }
  }

  // 3) Email — reuse Resend via emailRaw.
  if (o.channels.includes('email')) {
    if (o.staff.email && process.env.RESEND_API_KEY) {
      try {
        await emailRaw({ to: [o.staff.email], subject: `${COMPANY.legalName}: ${o.title}`, html: emailHtml(o) })
        results.email = true
      } catch (e) {
        console.error('[crew-notify] email failed', e)
        results.email = false
      }
    } else {
      results.email = false
    }
  }

  const anyDelivered = Object.values(results).some(Boolean)
  return { channelResults: results, messageId, anyDelivered }
}

// The public one-tap acknowledgement link an SMS/email recipient taps.
export function ackUrlFor(token: string): string {
  return `${BASE}/ack/${token}`
}
