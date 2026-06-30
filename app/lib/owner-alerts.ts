// Owner alerts — notify the business when a customer replies. Channels (SMS / email)
// and destinations are RUNTIME-EDITABLE: stored in Redis, defaulted from env vars,
// so the owner can toggle "text me / email me" from the admin without a redeploy.
//
// Env defaults:
//   OWNER_SMS          owner phone for alert texts (e.g. +18179094312)
//   OWNER_EMAIL        owner email for alert emails (default timmothy@jkissllc.com)
//   OWNER_ALERT_SMS    "false" to disable SMS alerts by default
//   OWNER_ALERT_EMAIL  "false" to disable email alerts by default

import { redis } from './redis'
import { sendSms } from './sms'
import { emailRaw } from './booking-emails'

const KEY = 'settings:owner_alerts'

export type OwnerAlertConfig = {
  sms: boolean       // text the owner on a new reply
  email: boolean     // email the owner on a new reply
  smsTo: string      // owner phone
  emailTo: string    // owner email
}

function envDefaults(): OwnerAlertConfig {
  return {
    sms: (process.env.OWNER_ALERT_SMS ?? 'true') !== 'false',
    email: (process.env.OWNER_ALERT_EMAIL ?? 'true') !== 'false',
    smsTo: process.env.OWNER_SMS ?? '',
    emailTo: process.env.OWNER_EMAIL ?? 'timmothy@jkissllc.com',
  }
}

export async function getOwnerAlertConfig(): Promise<OwnerAlertConfig> {
  const def = envDefaults()
  try {
    const raw = await redis.get(KEY)
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<OwnerAlertConfig>) }
  } catch { /* fall back to env defaults */ }
  return def
}

export async function setOwnerAlertConfig(patch: Partial<OwnerAlertConfig>): Promise<OwnerAlertConfig> {
  const cur = await getOwnerAlertConfig()
  const next: OwnerAlertConfig = {
    sms: typeof patch.sms === 'boolean' ? patch.sms : cur.sms,
    email: typeof patch.email === 'boolean' ? patch.email : cur.email,
    smsTo: typeof patch.smsTo === 'string' ? patch.smsTo.trim() : cur.smsTo,
    emailTo: typeof patch.emailTo === 'string' ? patch.emailTo.trim() : cur.emailTo,
  }
  await redis.set(KEY, JSON.stringify(next))
  return next
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Fire-and-forget owner alert about an inbound customer reply. Never throws —
// a failed alert must not break the webhook that received the reply.
export async function notifyOwnerOfReply(opts: {
  via: 'text' | 'email'           // how the customer reached out (for the message copy)
  customerName?: string
  fromPhone?: string
  fromEmail?: string
  bookingNumber?: string
  preview: string
  adminUrl: string
}): Promise<void> {
  let cfg: OwnerAlertConfig
  try { cfg = await getOwnerAlertConfig() } catch { return }

  const who = opts.customerName || opts.fromPhone || opts.fromEmail || 'A customer'
  const ref = opts.bookingNumber ? ` (${opts.bookingNumber})` : ''
  const previewSms = opts.preview.length > 200 ? opts.preview.slice(0, 197) + '…' : opts.preview

  if (cfg.sms && cfg.smsTo) {
    const body = `J KISS: ${who}${ref} replied by ${opts.via}: "${previewSms}" — open: ${opts.adminUrl}`
    try { await sendSms(cfg.smsTo, body) } catch (e) { console.error('[owner-alert sms]', e) }
  }
  if (cfg.email && cfg.emailTo) {
    const html =
      `<p style="font-size:15px;margin:0 0 8px"><strong>${esc(who)}</strong>${ref ? ' ' + esc(ref.trim()) : ''} replied by ${opts.via}:</p>` +
      `<blockquote style="border-left:3px solid #ccc;margin:0 0 12px;padding:6px 12px;color:#333;white-space:pre-wrap">${esc(opts.preview)}</blockquote>` +
      (opts.fromPhone ? `<p style="margin:2px 0;color:#555">Phone: ${esc(opts.fromPhone)}</p>` : '') +
      (opts.fromEmail ? `<p style="margin:2px 0;color:#555">Email: ${esc(opts.fromEmail)}</p>` : '') +
      `<p style="margin:14px 0 0"><a href="${esc(opts.adminUrl)}" style="background:#1a3a6b;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">Open in admin →</a></p>`
    try { await emailRaw({ to: [cfg.emailTo], subject: `New customer reply${ref} — ${who}`, html }) } catch (e) { console.error('[owner-alert email]', e) }
  }
}
