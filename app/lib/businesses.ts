// Business records — editable metadata for a contract client. Routes/portals/
// invoices/templates all reference a client by free-text name; this stores the
// details worth editing (contact, address, notes) keyed by the normalized name,
// so the Businesses hub can overlay it without changing how routes are joined.
import { redis } from './redis'

// One entry per rate change, newest last. Written by the businesses API on every
// edit so the owner can see what a client used to pay and when it changed.
export type RateHistoryEntry = {
  at: number                 // when the change was made
  contractRateCents?: number // the rate as of this change (undefined = cleared)
  effectiveDate?: string     // YYYY-MM-DD the new rate starts applying
  active: boolean
  notes?: string
}

export type Business = {
  key: string            // normalized name (join key)
  name: string           // display name
  contactName?: string
  contactPhone?: string
  contactEmail?: string
  address?: string
  notes?: string
  requiresHelper?: boolean   // routes for this client need a driver + a helper

  // ── Route pricing (contract rate) ──
  // What this business pays J KISS per route. Snapshotted onto each route at
  // create time — see lib/finance.snapshotBusinessPrice. Admin-only: never
  // exposed on the public confirmation page.
  contractRateCents?: number
  billingNotes?: string        // special terms, e.g. "net-30, billed monthly"
  rateEffectiveDate?: string   // YYYY-MM-DD
  pricingActive?: boolean      // false = rate on file but not in force
  rateHistory?: RateHistoryEntry[]

  createdAt: number
  updatedAt: number
}

export const bizKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ')
const KEY = (k: string) => `biz:${k}`
const INDEX = 'biz:index'

export async function getBusiness(key: string): Promise<Business | null> {
  const raw = await redis.get(KEY(key))
  if (!raw) return null
  try { return JSON.parse(raw) as Business } catch { return null }
}

export async function saveBusiness(b: Business): Promise<void> {
  b.updatedAt = Date.now()
  await redis.set(KEY(b.key), JSON.stringify(b))
  await redis.zadd(INDEX, b.updatedAt, b.key)
}

export async function deleteBusiness(key: string): Promise<void> {
  await redis.del(KEY(key))
  await redis.zrem(INDEX, key)
}

export async function listBusinesses(limit = 500): Promise<Business[]> {
  const keys = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!keys.length) return []
  const raws = await Promise.all(keys.map(k => redis.get(KEY(k))))
  return raws
    .map(r => { try { return r ? JSON.parse(r) as Business : null } catch { return null } })
    .filter((b): b is Business => b !== null)
}
