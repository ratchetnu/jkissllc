// SMS via Twilio REST API (no SDK — direct fetch). Gated on Twilio env vars so
// the app runs fine without SMS configured; functions no-op and report false.
//
// Required: TWILIO_ACCOUNT_SID (AC…) — scopes the send URL.
// Auth (either): TWILIO_API_KEY_SID (SK…) + TWILIO_API_KEY_SECRET   [recommended]
//            or: TWILIO_AUTH_TOKEN
// Sender (either): TWILIO_FROM (a Twilio number)  or  TWILIO_MESSAGING_SERVICE_SID (MG…)

import { redis } from './redis'

function authPair(): { user: string; pass: string } | null {
  if (process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET) {
    return { user: process.env.TWILIO_API_KEY_SID, pass: process.env.TWILIO_API_KEY_SECRET }
  }
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    return { user: process.env.TWILIO_ACCOUNT_SID, pass: process.env.TWILIO_AUTH_TOKEN }
  }
  return null
}

export function smsConfigured(): boolean {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    authPair() &&
    (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID)
  )
}

// Best-effort E.164 for US numbers. Returns null if it can't form a plausible
// number, so we never hand Twilio garbage.
export function toE164(raw: string | undefined | null): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  if (raw.trim().startsWith('+') && digits.length >= 11) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}

// Rich result for callers that need the Twilio MessageSid / accept status (e.g.
// admin sends that surface the SID + delivery tracking). `status` is Twilio's
// initial value — usually 'queued' or 'accepted' for a Messaging Service send.
export type SmsDetail =
  | { ok: true; sid: string; status: string }
  | { ok: false; error: string; code?: number; httpStatus?: number }

export async function sendSmsDetailed(to: string | undefined | null, body: string): Promise<SmsDetail> {
  if (!smsConfigured()) return { ok: false, error: 'SMS is not configured (missing Twilio credentials).' }
  const dest = toE164(to)
  if (!dest) return { ok: false, error: `Invalid phone number: ${to}` }

  // Honor app-level opt-out (set when a customer texts STOP). Twilio also blocks
  // opted-out numbers; we skip proactively so reminders don't even attempt a send.
  try { if (await redis.get(`sms:optout:${dest}`)) return { ok: false, error: 'Recipient has opted out of SMS (STOP).' } } catch { /* non-fatal */ }

  const accountSid = process.env.TWILIO_ACCOUNT_SID!
  const auth = authPair()!
  const params = new URLSearchParams()
  params.set('To', dest)
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    params.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID)
  } else {
    params.set('From', process.env.TWILIO_FROM!)
  }
  params.set('Body', body)

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      cache: 'no-store',
    })
    const data = await res.json().catch(() => ({} as Record<string, unknown>))
    if (!res.ok) {
      const msg = (data as { message?: string }).message || `Twilio error (HTTP ${res.status})`
      console.error('[sms] twilio error', res.status, msg)
      return { ok: false, error: msg, code: (data as { code?: number }).code, httpStatus: res.status }
    }
    return { ok: true, sid: (data as { sid: string }).sid, status: (data as { status: string }).status }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error sending SMS'
    console.error('[sms] send failed', msg)
    return { ok: false, error: msg }
  }
}

// Look up the current delivery status of a previously-sent message. Returns null
// if SMS isn't configured or Twilio can't be reached.
export async function getSmsStatus(sid: string): Promise<{ status: string; errorCode: number | null; errorMessage: string | null } | null> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const auth = authPair()
  if (!accountSid || !auth) return null
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}` },
      cache: 'no-store',
    })
    if (!res.ok) return null
    const d = await res.json()
    return { status: d.status, errorCode: d.error_code ?? null, errorMessage: d.error_message ?? null }
  } catch {
    return null
  }
}

// Boolean convenience wrapper — preserves the original signature for the many
// fire-and-forget callers (reminders, alerts) that only care if it went out.
export async function sendSms(to: string | undefined | null, body: string): Promise<boolean> {
  return (await sendSmsDetailed(to, body)).ok
}
