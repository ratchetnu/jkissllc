// Shared Twilio webhook primitives used by BOTH the inbound-SMS webhook
// (/api/webhooks/twilio/sms) and the delivery-status webhook
// (/api/webhooks/twilio/status): the X-Twilio-Signature verifier and the
// canonical callback base URL. Kept here (pure, no Next.js APIs) so the two
// routes and the SMS send helper can't drift on how signatures are computed or
// how the status-callback URL is built.

import crypto from 'crypto'

// Twilio X-Twilio-Signature = base64( HMAC-SHA1( authToken, URL + sortedParamKeyVal ) ).
// `url` must be the EXACT absolute URL Twilio was configured to call (including any
// query string); `params` are the POST body fields. Returns false on any missing
// input so callers fail closed.
export function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string | null): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!token || !signature) return false
  let data = url
  for (const k of Object.keys(params).sort()) data += k + params[k]
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64')
  try {
    const a = Buffer.from(expected), b = Buffer.from(signature)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch { return false }
}

// The configured public origin used to BUILD the StatusCallback URL (send helper)
// and to VERIFY it (status webhook) — the two must agree byte-for-byte or the
// signature check fails. Env-driven ONLY: we never fabricate an origin from a
// request Host header (spoofable) or a placeholder. Returns '' when unconfigured
// so the caller can fail safe (skip the callback + warn) instead of inventing one.
export function callbackBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '')
}

export const STATUS_CALLBACK_PATH = '/api/webhooks/twilio/status'

// Absolute StatusCallback URL, or '' if no base origin is configured. When a shared
// webhook secret is set (TWILIO_WEBHOOK_SECRET), it's appended as ?key=… so the
// status webhook can authenticate the callback the same way the inbound webhook does
// (the account Auth Token needed for X-Twilio-Signature isn't configured here). The
// URL carries the webhook secret but never any customer data.
export function statusCallbackUrl(): string {
  const base = callbackBaseUrl()
  if (!base) return ''
  const url = `${base}${STATUS_CALLBACK_PATH}`
  const secret = process.env.TWILIO_WEBHOOK_SECRET
  return secret ? `${url}?key=${encodeURIComponent(secret)}` : url
}
