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
  const auth = !!(
    (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) ||
    (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN)
  )
  return !!(
    env.TWILIO_ACCOUNT_SID &&
    auth &&
    (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID)
  )
}
