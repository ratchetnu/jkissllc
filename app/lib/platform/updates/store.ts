// ── Operion Update Center — durable store (platform:* global key family) ─────
// JSON blob + zset index + incr counter, mirroring bookings.ts / audit.ts. The
// `platform:` prefix is on the never-tenant-scoped allowlist (keys.ts) — this is
// intentionally global platform-owner data, independent of any tenant.

import crypto from 'node:crypto'
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
const K_UPD_DISCOVERY = 'platform:update-discovery:'
const K_UPD_DELIVERY = 'platform:update-delivery:'
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

type DiscoveryStore = Pick<typeof redis, 'eval' | 'get'>
export type DiscoveryWrite = { kind: 'created' | 'existing'; update: PlatformUpdate }

/**
 * The token `saveDiscoveredUpdate` substitutes with the allocated key.
 *
 * Deliberately not a valid UPD key: if substitution ever failed, a record carrying
 * this literal would be obviously broken rather than plausibly wrong.
 */
export const DISCOVERY_KEY_PLACEHOLDER = '__OPERION_UPDATE_KEY__'

/** The discovery identity → marker digest. Never a raw repository name in a key. */
function discoveryDigest(identity: { repository: string; commit: string }): string {
  return crypto.createHash('sha256')
    .update(`${identity.repository.toLowerCase()}@${identity.commit.toLowerCase()}`)
    .digest('hex')
}

/**
 * Create one update for a source artifact, exactly once — allocating its number
 * ONLY when it is genuinely the first delivery.
 *
 * ── Why the sequence moved inside the script ────────────────────────────────
 *
 * The number used to be allocated by the caller, before the marker was consulted.
 * GitHub retries jobs and owners re-run them, so every duplicate delivery burned a
 * UPD number and left a permanent gap in the sequence. A gap is not a correctness
 * failure, but a release ledger whose identifiers skip is one an owner cannot
 * reason about — "where did UPD-1009 go?" has no good answer.
 *
 * Reading the marker first and only then allocating would be a check-then-act: two
 * simultaneous first deliveries would both read "absent", both allocate, and one
 * would still be discarded. So the allocation happens INSIDE the same Lua call as
 * the marker check — one atomic step, no window between deciding and acting.
 *
 * ── Why `gsub` is assigned to a local ───────────────────────────────────────
 *
 * `string.gsub` returns TWO values — the string AND the replacement count — and a
 * Lua call in the LAST argument position expands to all of them. Inlining it would
 * issue `SET key value 1`, which real Redis rejects as `ERR syntax error` AFTER the
 * INCR above has already taken effect (a script's completed writes are not rolled
 * back). Every first delivery would then fail while still consuming an update
 * number. The local truncates it to one value. Pinned by
 * scripts/lua-multi-return-guard.test.ts.
 *
 * ── What the script guarantees ──────────────────────────────────────────────
 *
 *   duplicate delivery  → returns the original key. No INCR. No second record.
 *   first delivery      → INCR, write record + index + marker, all or nothing.
 *   key collision       → refuses loudly; an existing record is NEVER overwritten.
 *   dangling marker     → refuses loudly rather than inventing a record.
 *
 * KEYS carries the marker, the index and the counter. The update record's key is
 * derived inside the script from a prefix in ARGV, because it cannot be known until
 * the counter is read — the one key that is computed rather than declared. Every
 * key here lives under the `platform:` prefix, which is on the never-tenant-scoped
 * allowlist (keys.ts), so scoping is a no-op and the computed key cannot escape a
 * tenant boundary. (On a clustered Redis an undeclared key would need a hash tag;
 * this deployment is a single logical Upstash database.)
 */
export async function saveDiscoveredUpdate(
  update: PlatformUpdate,
  identity: { repository: string; commit: string },
  store: DiscoveryStore = redis,
): Promise<DiscoveryWrite> {
  const encoded = JSON.stringify(update)
  // The record is written by substituting this token. If it is absent the script
  // would persist a placeholder key; if it appears twice the wrong one could be
  // replaced. Both are refused here rather than discovered later in the ledger.
  const occurrences = encoded.split(DISCOVERY_KEY_PLACEHOLDER).length - 1
  if (occurrences !== 1) {
    throw new Error(`DISCOVERY_PLACEHOLDER_NOT_UNIQUE: expected exactly one, found ${occurrences}`)
  }

  const markerKey = K_UPD_DISCOVERY + discoveryDigest(identity)
  // The return value carries WHICH PATH ran, not just the key. The caller cannot
  // infer it: a deduplicated delivery and a created one both end with a real key,
  // and the candidate it passed in carries only a placeholder.
  const script = `
    local existing = redis.call('GET', KEYS[1])
    if existing then return 'E:' .. existing end
    local seq = redis.call('INCR', KEYS[3])
    local key = 'UPD-' .. tostring(1000 + seq)
    local recordKey = ARGV[3] .. key
    if redis.call('EXISTS', recordKey) == 1 then return '__UPDATE_KEY_COLLISION__' end
    local record = string.gsub(ARGV[1], ARGV[4], key, 1)
    redis.call('SET', recordKey, record)
    redis.call('ZADD', KEYS[2], ARGV[2], key)
    redis.call('SET', KEYS[1], key)
    return 'C:' .. key
  `
  const result = String(await store.eval(
    script,
    [markerKey, K_UPD_IDX, K_UPD_CTR],
    [encoded, String(update.updatedAt), K_UPD, DISCOVERY_KEY_PLACEHOLDER],
  ))

  if (result === '__UPDATE_KEY_COLLISION__') throw new Error('UPDATE_KEY_COLLISION')
  const kind = result.startsWith('C:') ? 'created' : result.startsWith('E:') ? 'existing' : null
  if (!kind) throw new Error(`DISCOVERY_UNEXPECTED_RESULT: ${result.slice(0, 40)}`)
  const key = result.slice(2)

  // The authoritative record is the one the store holds — re-read it rather than
  // trusting the in-memory candidate, so a caller is never handed a record that
  // differs from what was persisted (and, on the created path, so the substituted
  // key is the one that comes back).
  const stored = parse<PlatformUpdate>(await store.get(K_UPD + key))
  if (!stored) throw new Error('DISCOVERY_MARKER_WITHOUT_UPDATE')
  return { kind, update: stored }
}

/**
 * Delivery replay guard, mirroring the sibling automation callback.
 *
 * This is DEFENCE IN DEPTH, not the duplicate-update guarantee — that remains the
 * repository+commit marker above, which is what makes "one commit, one update" true
 * even across workflow re-runs that carry a fresh delivery id.
 *
 * What this adds is narrower and worth having anyway: a signed request captured off
 * the wire cannot be replayed inside the signature's freshness window to re-enter
 * the handler. The stored value is the update key the delivery produced, so a replay
 * can be answered with the same body instead of a bare acknowledgement.
 *
 * Marked only AFTER a delivery succeeds. The workflow retries the same delivery id
 * when the endpoint is unreachable, so marking a failed attempt would lock out the
 * retry that was supposed to recover it.
 */
export async function discoveryDeliverySeen(deliveryId: string): Promise<string | null> {
  return await redis.get(K_UPD_DELIVERY + deliveryId)
}
export async function markDiscoveryDelivery(deliveryId: string, updateKey: string, ttlMs = 24 * 60 * 60_000): Promise<void> {
  await redis.set(K_UPD_DELIVERY + deliveryId, updateKey)
  await redis.pexpire(K_UPD_DELIVERY + deliveryId, ttlMs)
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

/** Create-only release writer. Existing legacy or REL-* records are never overwritten. */
export async function saveRelease(r: PlatformRelease): Promise<void> {
  const id = releaseStorageId(r)
  const script = `
    if redis.call('EXISTS', KEYS[1]) == 1 then return -1 end
    redis.call('SET', KEYS[1], ARGV[1])
    redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
    return 1
  `
  const result = await redis.eval(
    script,
    [K_REL + id, K_REL_IDX],
    [JSON.stringify(r), String(r.updatedAt), id],
  )
  if (result !== 1 && result !== '1') throw new Error('RELEASE_ALREADY_EXISTS')
}

export type ReleaseUpdateWrite = 'saved' | 'stale_release' | 'invalid_change'

function immutableReleaseFields(record: PlatformRelease): Omit<PlatformRelease, 'status' | 'updatedAt'> {
  const copy = { ...record }
  delete (copy as Partial<PlatformRelease>).status
  delete (copy as Partial<PlatformRelease>).updatedAt
  return copy as Omit<PlatformRelease, 'status' | 'updatedAt'>
}

/**
 * Guarded status update for reconciliation. A rollout's identity and authored
 * contents are immutable; only status and updatedAt may change. The byte-level
 * CAS prevents a stale reconciler from overwriting a newer status.
 */
export async function updateRelease(
  current: PlatformRelease,
  next: PlatformRelease,
): Promise<ReleaseUpdateWrite> {
  const currentImmutable = immutableReleaseFields(current)
  const nextImmutable = immutableReleaseFields(next)
  if (JSON.stringify(currentImmutable) !== JSON.stringify(nextImmutable)) return 'invalid_change'

  const id = releaseStorageId(current)
  if (releaseStorageId(next) !== id) return 'invalid_change'
  const script = `
    local stored = redis.call('GET', KEYS[1])
    if not stored or stored ~= ARGV[1] then return -1 end
    redis.call('SET', KEYS[1], ARGV[2])
    redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
    return 1
  `
  const result = await redis.eval(
    script,
    [K_REL + id, K_REL_IDX],
    [JSON.stringify(current), JSON.stringify(next), String(next.updatedAt), id],
  )
  return result === 1 || result === '1' ? 'saved' : 'stale_release'
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
