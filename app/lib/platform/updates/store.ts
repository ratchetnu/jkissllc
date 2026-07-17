// ── Operion Update Center — durable store (platform:* global key family) ─────
// JSON blob + zset index + incr counter, mirroring bookings.ts / audit.ts. The
// `platform:` prefix is on the never-tenant-scoped allowlist (keys.ts) — this is
// intentionally global platform-owner data, independent of any tenant.

import { redis } from '../../redis'
import type { PlatformBusiness, PlatformUpdate, UpdateCompatibility, PlatformRelease, DeploymentRecord } from './types'

const K_BIZ = 'platform:business:'
const K_BIZ_IDX = 'platform:business:index'
const K_UPD = 'platform:update:'
const K_UPD_IDX = 'platform:update:index'
const K_UPD_CTR = 'platform:update:counter'
const K_COMPAT = 'platform:compat:'          // platform:compat:{updateKey} -> Record<bizId, UpdateCompatibility>
const K_REL = 'platform:release:'
const K_REL_IDX = 'platform:release:index'
const K_DEP = 'platform:deployment:'
const K_DEP_IDX = 'platform:deployment:index'
const K_DEP_CTR = 'platform:deployment:counter'

function parse<T>(raw: string | null): T | null { if (!raw) return null; try { return JSON.parse(raw) as T } catch { return null } }
async function loadMany<T>(prefix: string, ids: string[]): Promise<T[]> {
  // Batch the reads instead of a serial await-in-loop; ids are pre-ordered by the
  // caller's zrevrange, so parsing in place preserves order and filtering.
  const raws = await Promise.all(ids.map((id) => redis.get(prefix + id)))
  return raws.map((r) => parse<T>(r)).filter((v): v is T => v !== null)
}

// ── Businesses ───────────────────────────────────────────────────────────────
export async function getBusiness(id: string): Promise<PlatformBusiness | null> { return parse(await redis.get(K_BIZ + id)) }
export async function saveBusiness(b: PlatformBusiness): Promise<void> {
  await redis.set(K_BIZ + b.id, JSON.stringify(b))
  await redis.zadd(K_BIZ_IDX, b.updatedAt, b.id)
}
export async function listBusinesses(limit = 100): Promise<PlatformBusiness[]> {
  return loadMany(K_BIZ, await redis.zrevrange(K_BIZ_IDX, 0, Math.max(0, limit - 1)))
}

// ── Updates ──────────────────────────────────────────────────────────────────
export async function nextUpdateKey(): Promise<string> { return `UPD-${1000 + (await redis.incr(K_UPD_CTR))}` }
export async function getUpdate(key: string): Promise<PlatformUpdate | null> { return parse(await redis.get(K_UPD + key)) }
export async function saveUpdate(u: PlatformUpdate): Promise<void> {
  await redis.set(K_UPD + u.key, JSON.stringify(u))
  await redis.zadd(K_UPD_IDX, u.updatedAt, u.key)
}
export async function listUpdates(limit = 500): Promise<PlatformUpdate[]> {
  return loadMany(K_UPD, await redis.zrevrange(K_UPD_IDX, 0, Math.max(0, limit - 1)))
}

// ── Compatibility (one blob per update: bizId -> record) ─────────────────────
export async function getCompatMap(updateKey: string): Promise<Record<string, UpdateCompatibility>> {
  return parse<Record<string, UpdateCompatibility>>(await redis.get(K_COMPAT + updateKey)) ?? {}
}
export async function saveCompat(c: UpdateCompatibility): Promise<void> {
  const map = await getCompatMap(c.updateKey)
  map[c.businessId] = c
  await redis.set(K_COMPAT + c.updateKey, JSON.stringify(map))
}
export async function listCompat(updateKey: string): Promise<UpdateCompatibility[]> {
  return Object.values(await getCompatMap(updateKey))
}

// ── Releases ─────────────────────────────────────────────────────────────────
export async function getRelease(version: string): Promise<PlatformRelease | null> { return parse(await redis.get(K_REL + version)) }
export async function saveRelease(r: PlatformRelease): Promise<void> {
  await redis.set(K_REL + r.version, JSON.stringify(r))
  await redis.zadd(K_REL_IDX, r.updatedAt, r.version)
}
export async function listReleases(limit = 100): Promise<PlatformRelease[]> {
  return loadMany(K_REL, await redis.zrevrange(K_REL_IDX, 0, Math.max(0, limit - 1)))
}

// ── Deployments ──────────────────────────────────────────────────────────────
export async function nextDeploymentId(): Promise<string> { return `DEP-${1000 + (await redis.incr(K_DEP_CTR))}` }
export async function getDeployment(id: string): Promise<DeploymentRecord | null> { return parse(await redis.get(K_DEP + id)) }
export async function saveDeployment(d: DeploymentRecord): Promise<void> {
  await redis.set(K_DEP + d.id, JSON.stringify(d))
  await redis.zadd(K_DEP_IDX, d.updatedAt, d.id)
}
export async function listDeployments(limit = 200): Promise<DeploymentRecord[]> {
  return loadMany(K_DEP, await redis.zrevrange(K_DEP_IDX, 0, Math.max(0, limit - 1)))
}
export async function listDeploymentsForUpdate(updateKey: string): Promise<DeploymentRecord[]> {
  return (await listDeployments(500)).filter((d) => d.updateKeys.includes(updateKey))
}
