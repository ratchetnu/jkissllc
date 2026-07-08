// OpsPilot early-access waitlist.
//
// The first piece of OpsPilot-as-a-product that touches storage. Kept in its own
// namespace (`opspilot:*`) rather than folded into the J KISS operational keys,
// because these records belong to the PLATFORM, not to the tenant that happens to
// be running on it today. When multi-tenancy lands, J KISS's operational keys get
// tenant-prefixed and these do not — they stay global to OpsPilot.
// See docs/opspilot-multi-tenant-roadmap.md.

import { redis } from './redis'

export type WaitlistEntry = {
  email: string
  company?: string
  fleetSize?: string
  /** Which page the request came from — tells us what copy is converting. */
  source: string
  createdAt: number
}

// Email, normalized, is the identity. Re-submitting updates rather than duplicates.
const emailKey = (email: string) => email.trim().toLowerCase()
const KEY = (e: string) => `opspilot:waitlist:${emailKey(e)}`
const INDEX = 'opspilot:waitlist:index'

export async function addToWaitlist(entry: WaitlistEntry): Promise<void> {
  await redis.set(KEY(entry.email), JSON.stringify({ ...entry, email: emailKey(entry.email) }))
  await redis.zadd(INDEX, entry.createdAt, emailKey(entry.email))
}

export async function listWaitlist(limit = 500): Promise<WaitlistEntry[]> {
  const keys = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!keys.length) return []
  const raws = await Promise.all(keys.map(k => redis.get(KEY(k))))
  return raws
    .map(r => { try { return r ? JSON.parse(r) as WaitlistEntry : null } catch { return null } })
    .filter((e): e is WaitlistEntry => e !== null)
}

export async function waitlistCount(): Promise<number> {
  return redis.zcard(INDEX)
}
