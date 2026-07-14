// Outbound SMS delivery-status webhook (Twilio StatusCallback). Twilio POSTs here as
// each message we send moves queued → sent → delivered (or → undelivered/failed). We
// verify the X-Twilio-Signature, record a per-MessageSid status entry (idempotently),
// correlate it back to the originating message/booking when known, and raise the
// existing owner alert on a first-time terminal failure. We never store the message
// body, never log full phone numbers, and always return 2xx so Twilio doesn't retry.
//
// SETUP: outbound sends attach StatusCallback = {PUBLIC_BASE_URL}/api/webhooks/twilio/
// status (see app/lib/sms.ts). Signature auth needs TWILIO_AUTH_TOKEN set; with it
// unset this endpoint fails closed. No secret is placed in the callback URL.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { verifyTwilioSignature, callbackBaseUrl, STATUS_CALLBACK_PATH } from '../../../../lib/twilio-webhook'
import { toE164 } from '../../../../lib/sms'
import { COMPANY } from '../../../../lib/company'
import { recordDeliveryStatus, maskPhone, isTerminalFailure } from '../../../../lib/sms-status'
import { getMessageByProviderId, setMessageDeliveryStatus } from '../../../../lib/messages'
import { sendOwnerAlert, getOwnerAlertConfig } from '../../../../lib/owner-alerts'
import { withBackgroundTenant } from '../../../../lib/platform/tenancy/request-context'
import { activeTenantIds } from '../../../../lib/platform/tenancy/tenant-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Map a Twilio MessageStatus to the message-ledger lifecycle status we persist.
function ledgerStatus(twilioStatus: string): 'sent' | 'delivered' | 'failed' | null {
  switch (twilioStatus) {
    case 'delivered': return 'delivered'
    case 'undelivered': case 'failed': return 'failed'
    case 'sent': return 'sent'
    default: return null   // queued/accepted/sending/scheduled — no ledger transition
  }
}

export async function POST(req: NextRequest) {
  const raw = await req.text()
  const form = new URLSearchParams(raw)
  const params: Record<string, string> = {}
  form.forEach((v, k) => { params[k] = v })

  // Auth: accept EITHER a valid shared secret (?key=…, TWILIO_WEBHOOK_SECRET — the
  // same scheme the inbound webhook uses) OR a valid Twilio signature
  // (TWILIO_AUTH_TOKEN). Either proof suffices. Fail closed (503) when neither secret
  // is configured; reject (403) when configured but unproven.
  const token = process.env.TWILIO_AUTH_TOKEN
  const secret = process.env.TWILIO_WEBHOOK_SECRET
  if (!token && !secret) {
    console.error('[twilio-status] fail-closed: neither TWILIO_WEBHOOK_SECRET nor TWILIO_AUTH_TOKEN configured')
    return new NextResponse('webhook not configured', { status: 503 })
  }
  let authed = false
  if (secret) {
    const key = req.nextUrl.searchParams.get('key') ?? ''
    try { if (key.length === secret.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(secret))) authed = true } catch { /* not authed */ }
  }
  if (!authed && token) {
    const base = callbackBaseUrl() || `https://${req.headers.get('host') ?? 'www.jkissllc.com'}`
    const url = `${base}${STATUS_CALLBACK_PATH}${req.nextUrl.search || ''}`
    authed = verifyTwilioSignature(url, params, req.headers.get('x-twilio-signature'))
  }
  if (!authed) { console.warn('[twilio-status] webhook auth failed'); return new NextResponse('forbidden', { status: 403 }) }

  const messageSid = params.MessageSid || params.SmsSid || ''
  const status = (params.MessageStatus || params.SmsStatus || '').toLowerCase()
  const errorCode = params.ErrorCode && /^\d+$/.test(params.ErrorCode) ? parseInt(params.ErrorCode, 10) : undefined
  // Ack malformed callbacks with 200 so Twilio doesn't retry a payload we can't use.
  if (!messageSid || !status) return new NextResponse(null, { status: 204 })

  // Single-tenant deployment → the deployment's own tenant (trusted internal
  // mapping, NEVER the unsigned payload); pooled → map MessageSid/number → tenant.
  const tenantId = activeTenantIds()[0]
  return withBackgroundTenant('webhook', async () => {
    // Correlate to the originating outbound message (and its booking) when we recorded
    // one. Best-effort: most automated sends aren't in the message ledger, so this is
    // frequently null — booking stays "unknown", which is fine.
    let bookingToken: string | undefined
    let bookingNumber: string | undefined
    let notificationType: string | undefined
    try {
      const m = await getMessageByProviderId(messageSid)
      if (m) {
        bookingToken = m.bookingToken
        bookingNumber = m.bookingNumber
        notificationType = m.kind ?? (m.bookingToken ? 'customer' : undefined)
      }
    } catch (e) { console.error('[twilio-status] correlate failed', e) }

    // Record the status (idempotent per SID; repeated callbacks don't duplicate or
    // re-alert). Never throws — a callback arriving before the ledger write is visible
    // just creates the record fresh.
    const { record, shouldAlert } = await recordDeliveryStatus({
      sid: messageSid,
      status,
      errorCode,
      toMasked: maskPhone(params.To),
      bookingToken, bookingNumber, notificationType,
      now: Date.now(),
    })

    // Reflect terminal status onto the correlated ledger message (idempotent no-op if
    // unknown or unchanged) — no new timeline entry is created.
    const ls = ledgerStatus(status)
    if (ls) { try { await setMessageDeliveryStatus(messageSid, ls) } catch (e) { console.error('[twilio-status] ledger update failed', e) } }

    // Raise the existing owner alert on a FIRST-TIME terminal failure — but never for a
    // message that was itself sent to the owner's own alert number (that would loop:
    // the alert SMS could fail and re-alert). Guarded destination-based.
    if (shouldAlert && isTerminalFailure(status)) {
      try {
        const cfg = await getOwnerAlertConfig().catch(() => null)
        const ownerSms = toE164(cfg?.smsTo || process.env.OWNER_SMS || '')
        const destIsOwner = ownerSms && toE164(params.To) === ownerSms
        if (!destIsOwner) {
          const ref = record.bookingNumber ? ` — ${record.bookingNumber}` : ''
          const cls = record.errorClass ? ` (${record.errorClass})` : ''
          const code = record.errorCode != null ? ` code ${record.errorCode}` : ''
          const to = record.toMasked ? ` to ${record.toMasked}` : ''
          const smsBody = `${COMPANY.shortNameUpper}: SMS ${status}${to}${cls}${code}${ref}. Check the inbox.`
          const emailHtml =
            `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">` +
            `<h2 style="margin:0 0 8px">SMS delivery ${status}</h2>` +
            `<table style="font-size:14px;color:#222">` +
            `<tr><td style="padding:2px 10px 2px 0;color:#666">Recipient</td><td>${record.toMasked ?? 'unknown'}</td></tr>` +
            (record.bookingNumber ? `<tr><td style="padding:2px 10px 2px 0;color:#666">Booking</td><td>${record.bookingNumber}</td></tr>` : '') +
            (record.notificationType ? `<tr><td style="padding:2px 10px 2px 0;color:#666">Type</td><td>${record.notificationType}</td></tr>` : '') +
            `<tr><td style="padding:2px 10px 2px 0;color:#666">Status</td><td>${status}</td></tr>` +
            (record.errorClass ? `<tr><td style="padding:2px 10px 2px 0;color:#666">Reason</td><td>${record.errorClass}</td></tr>` : '') +
            (record.errorCode != null ? `<tr><td style="padding:2px 10px 2px 0;color:#666">Code</td><td>${record.errorCode}</td></tr>` : '') +
            `</table></div>`
          await sendOwnerAlert({ smsBody, emailSubject: `SMS ${status}${ref}`, emailHtml })
        }
      } catch (e) { console.error('[twilio-status] failure alert failed', e) }
    }

    return new NextResponse(null, { status: 204 })
  }, tenantId)
}
