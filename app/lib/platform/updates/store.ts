// ── Operion Update Center — durable store (platform:* global key family) ─────
// JSON blob + zset index + incr counter, mirroring bookings.ts / audit.ts. The
// `platform:` prefix is on the never-tenant-scoped allowlist (keys.ts) — this is
// intentionally global platform-owner data, independent of any tenant.

import { redis } from '../../redis'
import type {
  PlatformBusiness, PlatformUpdate, UpdateCompatibility, PlatformRelease, DeploymentRecord,
  BaselineAdoptionRecord, ReleasePackage,
} from './types'

const K_BIZ = 'platform:business:'
const K_BIZ_IDX = 'platform:business:index'
const K_UPD = 'platform:update:'
const K_UPD_IDX = 'platform:update:index'
const K_UPD_CTR = 'platform:update:counter'
const K_COMPAT = 'platform:compat:'          // platform:compat:{updateKey} -> Record<bizId, UpdateCompatibility>
const K_REL = 'platform:release:'
const K_REL_IDX = 'platform:release:index'
const K_REL_CTR = 'platform:release:counter'
const K_DEP = 'platform:deployment:'
const K_DEP_IDX = 'platform:deployment:index'
const K_DEP_CTR = 'platform:deployment:counter'
const K_BASELINE = 'platform:baseline-adoption:'
const K_BASELINE_IDX = 'platform:baseline-adoption:index'
const K_BASELINE_CTR = 'platform:baseline-adoption:counter'
const K_PACKAGE = 'platform:release-package:'
const K_PACKAGE_IDX = 'platform:release-package:index'
const K_PACKAGE_CTR = 'platform:release-package:counter'
const K_PACKAGE_VERSION = 'platform:release-package-version:'

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
const releaseStorageId = (record: Pick<PlatformRelease, 'id' | 'version'>): string => record.id ?? record.version
export async function nextReleaseId(): Promise<string> { return `REL-${1000 + (await redis.incr(K_REL_CTR))}` }
export async function getRelease(idOrVersion: string): Promise<PlatformRelease | null> { return parse(await redis.get(K_REL + idOrVersion)) }
export async function saveRelease(r: PlatformRelease): Promise<void> {
  const id = releaseStorageId(r)
  await redis.set(K_REL + id, JSON.stringify(r))
  await redis.zadd(K_REL_IDX, r.updatedAt, id)
}
export async function listReleases(limit = 100): Promise<PlatformRelease[]> {
  return loadMany(K_REL, await redis.zrevrange(K_REL_IDX, 0, Math.max(0, limit - 1)))
}

// ── Authored release packages ───────────────────────────────────────────────
export async function nextReleasePackageId(): Promise<string> {
  return `RPK-${1000 + (await redis.incr(K_PACKAGE_CTR))}`
}
export async function getReleasePackage(id: string): Promise<ReleasePackage | null> {
  return parse(await redis.get(K_PACKAGE + id))
}
export async function listReleasePackages(limit = 200): Promise<ReleasePackage[]> {
  return loadMany(K_PACKAGE, await redis.zrevrange(K_PACKAGE_IDX, 0, Math.max(0, limit - 1)))
}
export async function saveReleasePackage(record: ReleasePackage): Promise<void> {
  const script = `
    local current = redis.call('GET', KEYS[1])
    if current then
      local decoded = cjson.decode(current)
      if decoded.status == 'approved' or decoded.rolloutId then return -1 end
    end
    redis.call('SET', KEYS[1], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
    return 1
  `
  const result = await redis.eval(
    script,
    [K_PACKAGE + record.id, K_PACKAGE_IDX],
    [JSON.stringify(record), String(record.updatedAt), record.id],
  )
  if (result !== 1 && result !== '1') throw new Error('APPROVED_RELEASE_PACKAGE_IMMUTABLE')
}

export type RolloutWrite = 'saved' | 'already_created' | 'stale_package' | 'invalid_status' | 'release_collision'

/**
 * Atomically creates one product-scoped rollout record from an approved package
 * and links the package to it. This writes internal records only: it cannot
 * publish, dispatch automation, call a deployment provider, or change a site.
 */
export async function saveRolloutForApprovedPackage(
  release: PlatformRelease & { id: string; packageId: string; targetProduct: string },
  linkedPackage: ReleasePackage & { rolloutId: string; rolloutCreatedAt: number },
  expectedPackageUpdatedAt: number,
): Promise<RolloutWrite> {
  const script = `
    local package = redis.call('GET', KEYS[1])
    if not package then return -1 end
    local decodedPackage = cjson.decode(package)
    if decodedPackage.rolloutId then return 2 end
    if tonumber(decodedPackage.updatedAt) ~= tonumber(ARGV[5]) then return -1 end
    if decodedPackage.status ~= 'approved' then return -2 end
    if redis.call('EXISTS', KEYS[3]) == 1 then return -3 end

    redis.call('SET', KEYS[3], ARGV[1])
    redis.call('ZADD', KEYS[4], ARGV[2], ARGV[3])
    redis.call('SET', KEYS[1], ARGV[4])
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[6])
    return 1
  `
  const result = await redis.eval(
    script,
    [K_PACKAGE + linkedPackage.id, K_PACKAGE_IDX, K_REL + release.id, K_REL_IDX],
    [
      JSON.stringify(release), String(release.updatedAt), release.id,
      JSON.stringify(linkedPackage), String(expectedPackageUpdatedAt), linkedPackage.id,
    ],
  )
  if (result === 1 || result === '1') return 'saved'
  if (result === 2 || result === '2') return 'already_created'
  if (result === -2 || result === '-2') return 'invalid_status'
  if (result === -3 || result === '-3') return 'release_collision'
  return 'stale_package'
}

export type ReadyPackageWrite = 'saved' | 'stale_package' | 'stale_business' | 'duplicate'
export type PackageApprovalEvidence = {
  updateKey: string
  updateUpdatedAt: number
  compatibilityUpdatedAt: number
}
export type ApprovedPackageWrite =
  | 'saved' | 'stale_package' | 'stale_business' | 'stale_update' | 'stale_compatibility' | 'invalid_status'

/**
 * Atomically reserves product+channel+version and marks the package Ready.
 * The business timestamp check prevents a baseline changing between policy
 * evaluation and persistence.
 */
export async function saveReadyReleasePackage(
  record: ReleasePackage,
  expectedPackageUpdatedAt: number,
  expectedBusinessUpdatedAt: number,
): Promise<ReadyPackageWrite> {
  // SemVer build metadata does not affect precedence. Reserve the precedence
  // identity so concurrent 1.3.0+build.1 / 1.3.0+build.2 proposals still collide.
  const versionIdentity = record.proposedVersion.split('+', 1)[0]
  const reservation = `${K_PACKAGE_VERSION}${record.targetProduct}:${record.channel}:${versionIdentity}`
  const script = `
    local package = redis.call('GET', KEYS[1])
    if not package then return -1 end
    local decodedPackage = cjson.decode(package)
    if tonumber(decodedPackage.updatedAt) ~= tonumber(ARGV[3]) then return -1 end
    local business = redis.call('GET', KEYS[4])
    if not business then return -2 end
    local decodedBusiness = cjson.decode(business)
    if tonumber(decodedBusiness.updatedAt) ~= tonumber(ARGV[4]) then return -2 end
    local holder = redis.call('GET', KEYS[3])
    if holder and holder ~= ARGV[2] then
      local holderPackage = redis.call('GET', ARGV[6] .. holder)
      if holderPackage then
        local decodedHolder = cjson.decode(holderPackage)
        if decodedHolder.status ~= 'cancelled' and decodedHolder.status ~= 'superseded' then return -3 end
      end
    end
    if not holder or holder ~= ARGV[2] then redis.call('SET', KEYS[3], ARGV[2]) end
    redis.call('SET', KEYS[1], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[5], ARGV[2])
    return 1
  `
  const result = await redis.eval(
    script,
    [K_PACKAGE + record.id, K_PACKAGE_IDX, reservation, K_BIZ + record.targetProduct],
    [
      JSON.stringify(record), record.id, String(expectedPackageUpdatedAt),
      String(expectedBusinessUpdatedAt), String(record.updatedAt), K_PACKAGE,
    ],
  )
  if (result === 1 || result === '1') return 'saved'
  if (result === -2 || result === '-2') return 'stale_business'
  if (result === -3 || result === '-3') return 'duplicate'
  return 'stale_package'
}

/**
 * Atomically seals an approved package only while every record used by the
 * approval policy still matches the evidence the route evaluated.
 *
 * This deliberately does not create a PlatformRelease or call a deployment
 * provider. Approved packages remain immutable authored artifacts until the
 * later rollout-record increment can give releases a product-safe identity.
 */
export async function saveApprovedReleasePackage(
  record: ReleasePackage,
  expectedPackageUpdatedAt: number,
  expectedBusinessUpdatedAt: number,
  evidence: PackageApprovalEvidence[],
): Promise<ApprovedPackageWrite> {
  const keys = [
    K_PACKAGE + record.id,
    K_PACKAGE_IDX,
    K_BIZ + record.targetProduct,
    ...evidence.flatMap((item) => [K_UPD + item.updateKey, K_COMPAT + item.updateKey]),
  ]
  const args = [
    JSON.stringify(record),
    record.id,
    String(expectedPackageUpdatedAt),
    String(expectedBusinessUpdatedAt),
    String(record.updatedAt),
    record.targetProduct,
    String(evidence.length),
    ...evidence.flatMap((item) => [String(item.updateUpdatedAt), String(item.compatibilityUpdatedAt)]),
  ]
  const script = `
    local package = redis.call('GET', KEYS[1])
    if not package then return -1 end
    local decodedPackage = cjson.decode(package)
    if tonumber(decodedPackage.updatedAt) ~= tonumber(ARGV[3]) then return -1 end
    if decodedPackage.status ~= 'ready_for_approval' then return -5 end

    local business = redis.call('GET', KEYS[3])
    if not business then return -2 end
    local decodedBusiness = cjson.decode(business)
    if tonumber(decodedBusiness.updatedAt) ~= tonumber(ARGV[4]) then return -2 end

    local count = tonumber(ARGV[7])
    for i = 1, count do
      local updateKeyIndex = 4 + ((i - 1) * 2)
      local compatKeyIndex = updateKeyIndex + 1
      local expectedUpdateAt = tonumber(ARGV[8 + ((i - 1) * 2)])
      local expectedCompatAt = tonumber(ARGV[9 + ((i - 1) * 2)])

      local update = redis.call('GET', KEYS[updateKeyIndex])
      if not update then return -3 end
      local decodedUpdate = cjson.decode(update)
      if tonumber(decodedUpdate.updatedAt) ~= expectedUpdateAt then return -3 end

      local compatMap = redis.call('GET', KEYS[compatKeyIndex])
      if not compatMap then return -4 end
      local decodedCompatMap = cjson.decode(compatMap)
      local compatibility = decodedCompatMap[ARGV[6]]
      if not compatibility then return -4 end
      if tonumber(compatibility.updatedAt) ~= expectedCompatAt then return -4 end
    end

    redis.call('SET', KEYS[1], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[5], ARGV[2])
    return 1
  `
  const result = await redis.eval(script, keys, args)
  if (result === 1 || result === '1') return 'saved'
  if (result === -2 || result === '-2') return 'stale_business'
  if (result === -3 || result === '-3') return 'stale_update'
  if (result === -4 || result === '-4') return 'stale_compatibility'
  if (result === -5 || result === '-5') return 'invalid_status'
  return 'stale_package'
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

// ── Baseline adoptions ──────────────────────────────────────────────────────
export async function nextBaselineAdoptionId(): Promise<string> {
  return `BADOPT-${1000 + (await redis.incr(K_BASELINE_CTR))}`
}
export async function getBaselineAdoption(id: string): Promise<BaselineAdoptionRecord | null> {
  return parse(await redis.get(K_BASELINE + id))
}
export async function listBaselineAdoptionsForBusiness(businessId: string, limit = 50): Promise<BaselineAdoptionRecord[]> {
  const records = await loadMany<BaselineAdoptionRecord>(
    K_BASELINE,
    await redis.zrevrange(K_BASELINE_IDX, 0, Math.max(0, Math.min(500, limit * 10) - 1)),
  )
  return records.filter((record) => record.targetProduct === businessId).slice(0, limit)
}

/** The adoption record and business provenance become visible in one Redis transaction. */
export async function saveBaselineAdoption(
  record: BaselineAdoptionRecord,
  business: PlatformBusiness,
  expectedBusinessUpdatedAt: number,
): Promise<boolean> {
  const script = `
    local current = redis.call('GET', KEYS[3])
    if not current then return 0 end
    local decoded = cjson.decode(current)
    if tonumber(decoded.updatedAt) ~= tonumber(ARGV[6]) then return 0 end
    redis.call('SET', KEYS[1], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
    redis.call('SET', KEYS[3], ARGV[4])
    redis.call('ZADD', KEYS[4], ARGV[2], ARGV[5])
    return 1
  `
  const result = await redis.eval(
    script,
    [K_BASELINE + record.id, K_BASELINE_IDX, K_BIZ + business.id, K_BIZ_IDX],
    [JSON.stringify(record), String(record.adoptedAt), record.id, JSON.stringify(business), business.id, String(expectedBusinessUpdatedAt)],
  )
  return result === 1 || result === '1'
}
