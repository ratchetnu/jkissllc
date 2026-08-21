// ── Twilio configuration predicate — a dependency-free LEAF ──────────────────
//
// Extracted from lib/sms.ts so the readiness layer and the send path can share one
// definition without importing each other. lib/sms.ts pulls in Redis, tenant
// bindings and async-hooks; the capability guards it now consults transitively
// reach provider-readiness, and provider-readiness must not reach back into the
// send path. This file has NO imports, so the cycle cannot form and the predicate
// still cannot drift — sms.ts re-exports exactly this function.
//
// Presence only: no value is returned, logged, or compared.

export type TwilioEnv = Record<string, string | undefined>

/**
 * Exactly what a real Twilio send needs. An account SID alone cannot send, and
 * must not read as configured — asserting a single-key proxy here is what made
 * health report "ok" for a Twilio that could not deliver anything.
 */
export function twilioConfigured(env: TwilioEnv): boolean {
  // Trim-aware presence. A variable that EXISTS but is blank is ABSENT: copying
  // `.env.example` leaves every Twilio name defined with an empty value, and raw
  // truthiness treated a whitespace-only string as a real credential — so a fresh
  // deployment read as "SMS configured" and would have handed Twilio a blank
  // account SID. The readiness layer trims, and this is the predicate it shares.
  const set = (v: string | undefined) => typeof v === 'string' && v.trim().length > 0
  const auth = (set(env.TWILIO_API_KEY_SID) && set(env.TWILIO_API_KEY_SECRET))
    || (set(env.TWILIO_ACCOUNT_SID) && set(env.TWILIO_AUTH_TOKEN))
  return !!(
    set(env.TWILIO_ACCOUNT_SID) &&
    auth &&
    (set(env.TWILIO_FROM) || set(env.TWILIO_MESSAGING_SERVICE_SID))
  )
}
