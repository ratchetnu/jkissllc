// Opt-out awareness (Phase 5).
//
// SMS opt-out already exists as the Redis flag `sms:optout:{e164}` (set on STOP by
// the Twilio inbound webhook, cleared on START) and is enforced inside
// sendSmsDetailed. We READ the same key here so the comms layer can report/skip
// proactively — we never invent a second SMS opt-out store.
//
// Email had NO unsubscribe store (audit gap). We add a parallel `email:optout:{email}`
// flag so email reminders honor opt-out too.

import { redis } from '../redis'
import { toE164 } from '../sms'

const smsKey = (e164: string) => `sms:optout:${e164}`
const emailKey = (norm: string) => `email:optout:${norm}`

export function normEmail(e?: string | null): string | null {
  const s = (e ?? '').trim().toLowerCase()
  return s.includes('@') ? s : null
}

// ── SMS (read-only mirror of the existing store) ──
export async function isSmsOptedOut(phone?: string | null): Promise<boolean> {
  const e164 = toE164(phone ?? '')
  if (!e164) return false
  try { return !!(await redis.get(smsKey(e164))) } catch { return false }
}

// ── Email (new store) ──
export async function isEmailOptedOut(email?: string | null): Promise<boolean> {
  const n = normEmail(email)
  if (!n) return false
  try { return !!(await redis.get(emailKey(n))) } catch { return false }
}

export async function optOutEmail(email: string): Promise<boolean> {
  const n = normEmail(email)
  if (!n) return false
  await redis.set(emailKey(n), '1')
  return true
}

export async function optInEmail(email: string): Promise<boolean> {
  const n = normEmail(email)
  if (!n) return false
  await redis.del(emailKey(n))
  return true
}
