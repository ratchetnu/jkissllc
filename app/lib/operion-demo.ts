// Operion demo / access requests.
//
// The richer sibling of the early-access waitlist (lib/opspilot-waitlist.ts). The
// public /operion product page captures a qualified lead — industry, team size,
// current tools, the operational problem they're trying to solve — so J KISS can
// have a real conversation instead of just an email on a list.
//
// Like the waitlist, these records belong to the PLATFORM, not to the tenant that
// happens to run on it today, so they live in their own `operion:demo:*` namespace
// and stay global when multi-tenancy lands. See docs/opspilot-multi-tenant-roadmap.md.

import { redis } from './redis'

export type DemoRequest = {
  businessName: string
  contactName: string
  email: string
  phone?: string
  industry?: string
  teamSize?: string
  currentTools?: string
  challenge?: string
  /** Modules the operator is most interested in (from the page's checkbox set). */
  interests?: string[]
  message?: string
  /** Which page/section converted — tells us what copy is working. */
  source: string
  createdAt: number
}

// Email, normalized, is the identity. Re-submitting updates rather than duplicates.
const emailKey = (email: string) => email.trim().toLowerCase()
const KEY = (e: string) => `operion:demo:${emailKey(e)}`
const INDEX = 'operion:demo:index'

export async function addDemoRequest(entry: DemoRequest): Promise<void> {
  await redis.set(KEY(entry.email), JSON.stringify({ ...entry, email: emailKey(entry.email) }))
  await redis.zadd(INDEX, entry.createdAt, emailKey(entry.email))
}

export async function listDemoRequests(limit = 500): Promise<DemoRequest[]> {
  const keys = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!keys.length) return []
  const raws = await Promise.all(keys.map(k => redis.get(KEY(k))))
  return raws
    .map(r => { try { return r ? JSON.parse(r) as DemoRequest : null } catch { return null } })
    .filter((e): e is DemoRequest => e !== null)
}

export async function demoRequestCount(): Promise<number> {
  return redis.zcard(INDEX)
}
