// Business records — editable metadata for a contract client. Routes/portals/
// invoices/templates all reference a client by free-text name; this stores the
// details worth editing (contact, address, notes) keyed by the normalized name,
// so the Businesses hub can overlay it without changing how routes are joined.
import { redis } from './redis'
import { stableId, isStableId, looksNameDerived } from './platform/tenancy/stable-id'

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

  // Opaque, rename-safe identity (tenant-isolation doc 07). Absent until the
  // stable-id migration assigns one; `key` remains the join key either way, so a
  // record without this behaves exactly as it always has.
  stableId?: string
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

// TENANCY (H-KEY-1): bizKey is derived from the business NAME. Two properties:
//  1) The Redis-KEY collision ("Rooms To Go" → `biz:rooms to go`) is now handled by
//     the isolation chokepoint: `biz:` is NOT platform-global, so redis.ts routes
//     it through scopeKey → `t:{tid}:biz:rooms to go` when TENANCY_ENABLED. Two
//     tenants no longer overwrite each other's contract rates at rest. (Proven in
//     scripts/name-derived-keys.test.ts.)
//  2) The RESIDUAL defect the chokepoint CANNOT fix: bizKey is also a map key INSIDE
//     persisted staff records (Staff.payByBusiness — app/lib/staff.ts), i.e. inside
//     a JSON VALUE, not a Redis key. A prefix can't reach it, and a name is not a
//     durable identity (a rename moves the override). This needs a DATA MIGRATION to
//     opaque stable ids — see the forward-path helpers below and
//     docs/opspilot-os/tenant-isolation/07-name-derived-key-migration.md.
export const bizKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ')
const KEY = (k: string) => `biz:${k}`
const INDEX = 'biz:index'

// ── Forward path (doc 07): stable-id identity for businesses — PROPOSAL, NOT wired
// The migration replaces name-derived identity with an opaque, rename-safe stableId:
//   • `biz:id:{stableId}`         — canonical record (opaque)
//   • `biz:byname:{normalized}` → stableId — lookup for the legacy name join
// Staff.payByBusiness is then rekeyed from bizKey(name) → stableId during the data
// run. These builders MATERIALIZE that scheme; the live getters/setters below stay
// name-keyed for compatibility until cutover.
export const newBizId = () => stableId('biz')
export const bizIdKey = (id: string) => `biz:id:${id}`
export const bizNameIndexKey = (name: string) => `biz:byname:${bizKey(name)}`
/** Guard: true when a business identity is (unsafely) name-derived rather than a stableId. */
export const isNameDerivedBizKey = (k: string) => !isStableId(k) && looksNameDerived(k)

/**
 * Resolve a business's rename-safe id from its name, or null when it has not been
 * through the stable-id migration. Callers pass the result to `resolveCrewPay` as
 * the preferred pay-map key; a null simply means "resolve by name, as before".
 */
export async function getBusinessStableId(name: string): Promise<string | null> {
  const id = await redis.get(bizNameIndexKey(name))
  return id && isStableId(id) ? id : null
}

/**
 * Assign a stableId to a business and publish the name→id index. Idempotent: a
 * record that already has one is returned untouched, so re-running the migration
 * cannot mint a second identity for the same business.
 *
 * Writes the index only after the record itself carries the id, so a crash between
 * the two leaves a business with an id and no index (harmless — pay resolution
 * falls back to the name) rather than an index pointing at an id nobody holds.
 */
export async function ensureBusinessStableId(b: Business, id: string = newBizId()): Promise<string> {
  if (b.stableId) return b.stableId
  b.stableId = id
  await saveBusiness(b)
  await redis.set(bizNameIndexKey(b.name), id)
  return id
}

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
