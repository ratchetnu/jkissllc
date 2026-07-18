// ── Persistent tenant registry ───────────────────────────────────────────────
//
// The canonical, DURABLE list of tenants. The typed `Tenant` model already lives
// in types.ts and the reference seed in jkiss.ts; THIS module is the read/write
// store that persists them, so tenant resolution and background fan-out can stop
// depending on a hardcoded array (`activeTenantIds()` in tenant-store.ts).
//
// Storage — the PLATFORM-GLOBAL keyspace (the `platform:` allowlist in keys.ts).
// A tenant RECORD describes the platform's roster, not any tenant's own data, so
// it is NEVER tenant-prefixed; that invariant is asserted here via `platformKey()`.
// A tenant's OWN data lives under `t:{id}:` and is untouched by this registry, so
// nothing here can leak one tenant's records into another's namespace.
//
// Additive + reversible: no live customer path reads this yet, and while
// TENANCY_ENABLED=false the application behaves byte-identically. The registry
// simply records that the single production tenant is J KISS LLC.

import { redis } from '../../redis'
import { platformKey, normalizeTenantId } from './keys'
import { JKISS_TENANT } from './jkiss'
import { DEFAULT_TENANT_ID, type Tenant } from './types'

/** Sorted set of known tenant ids (score = createdAt). Platform-global. */
const INDEX_KEY = platformKey('platform:tenant:index')

/** The record key for one tenant. Asserts the id is an opaque slug, never a name. */
function tenantRecordKey(id: string): string {
  return platformKey(`platform:tenant:${normalizeTenantId(id)}`)
}

/** Read a tenant by its opaque id. Returns null when unknown. */
export async function getTenant(id: string): Promise<Tenant | null> {
  let key: string
  try {
    key = tenantRecordKey(id)
  } catch {
    return null // a malformed / name-derived id is never a valid tenant
  }
  const raw = await redis.get(key)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Tenant
  } catch {
    return null
  }
}

/** Every registered tenant, in registration order. */
export async function listTenants(): Promise<Tenant[]> {
  const ids = await redis.zrange(INDEX_KEY, 0, -1)
  const out: Tenant[] = []
  for (const id of ids) {
    const t = await getTenant(id)
    if (t) out.push(t)
  }
  return out
}

/**
 * Create or update a tenant record. Rejects a display-name id up front (the id
 * MUST be an opaque slug — never "J Kiss LLC", an email, or any user-facing
 * label), so a tenant boundary can never be derived from a name.
 */
export async function upsertTenant(t: Tenant): Promise<Tenant> {
  const id = normalizeTenantId(t.id) // throws on a name-derived id
  const record: Tenant = { ...t, id }
  await redis.set(tenantRecordKey(id), JSON.stringify(record))
  await redis.zadd(INDEX_KEY, record.createdAt, id)
  return record
}

/**
 * Idempotently ensure the reference tenant (J KISS LLC) exists, seeded BYTE-FOR-
 * BYTE from JKISS_TENANT. Returns the existing record unchanged if already
 * present, so re-running never mutates a live record. This is the single-tenant
 * compatibility mapping: it records today's production tenant without changing any
 * behavior.
 */
export async function ensureReferenceTenant(): Promise<Tenant> {
  const existing = await getTenant(DEFAULT_TENANT_ID)
  if (existing) return existing
  return upsertTenant(JKISS_TENANT)
}

/**
 * The active tenant ids from the persisted registry (status === 'active'). Falls
 * back to the reference tenant when the registry is empty (not yet provisioned),
 * so background fan-out keeps working with zero new state — single-tenant
 * continuity. This is the durable counterpart to the static `activeTenantIds()`.
 */
export async function activeTenantIdsFromRegistry(): Promise<string[]> {
  const tenants = await listTenants()
  const active = tenants.filter((t) => t.status === 'active').map((t) => t.id)
  return active.length ? active : [DEFAULT_TENANT_ID]
}
