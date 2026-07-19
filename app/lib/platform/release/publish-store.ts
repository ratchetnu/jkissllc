// ── Operion Release Center — publish store (platform:publish:* global family) ──
//
// Increment 3B.4. Persists the controlled-publish records + the per-business publish lock
// and the per-approval idempotency pointer. WRITE surface is tiny: acquire/release the lock,
// create/patch a record, and bind an approval→publish pointer so a repeat NEVER launches a
// second promotion. It touches no business/job/deployment/provider — only publish KV.

import { redis } from '../../redis'
import type { PublishRecordStatus } from './publish'

const REC = (id: string) => `platform:publish:rec:${id}`
const LATEST = (businessId: string) => `platform:publish:latest:${businessId}`
const BYAPPROVAL = (approvalId: string) => `platform:publish:byapproval:${approvalId}`
const LOCK = (businessId: string) => `platform:publish:lock:${businessId}`
const INDEX = 'platform:publish:index'   // sorted set: publishId scored by startedAt (release history)
const CTR = 'platform:publish:counter'
const RECORD_VERSION = 1
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000 // keep publish history 30 days
const LOCK_TTL_MS = 120_000

export type ReleasePublish = {
  recordVersion: number
  id: string                     // PUB-{n}
  businessId: string
  businessSlug: string
  approvalId: string
  releaseId: string              // candidate commit
  sourceDeploymentId: string     // the preview deployment promoted
  targetEnvironment: 'production'
  mode: 'live' | 'simulated'
  status: PublishRecordStatus    // promoting → completed | failed
  promotedDeploymentId?: string
  failureReason?: string
  startedAt: number
  updatedAt: number
  completedAt?: number
  startedBy: string
}

const parse = (raw: string | null): ReleasePublish | null => {
  if (!raw) return null
  try { return JSON.parse(raw) as ReleasePublish } catch { return null }
}

export async function nextPublishId(): Promise<string> { return `PUB-${1000 + (await redis.incr(CTR))}` }

export async function getPublish(id: string): Promise<ReleasePublish | null> { return parse(await redis.get(REC(id))) }

export async function getLatestPublishFor(businessId: string): Promise<ReleasePublish | null> {
  const id = await redis.get(LATEST(businessId))
  return id ? getPublish(id) : null
}

/** The publish (if any) that already consumed a given approval — the idempotency anchor. */
export async function getPublishByApproval(approvalId: string): Promise<ReleasePublish | null> {
  const id = await redis.get(BYAPPROVAL(approvalId))
  return id ? getPublish(id) : null
}

/** Acquire the per-business publish mutex (atomic). Returns false if one is already held. */
export async function acquirePublishLock(businessId: string, holder: string): Promise<boolean> {
  return redis.setNxPx(LOCK(businessId), holder, LOCK_TTL_MS)
}
export async function releasePublishLock(businessId: string): Promise<void> {
  await redis.del(LOCK(businessId)).catch(() => {})
}

export async function savePublish(p: ReleasePublish): Promise<void> {
  await redis.set(REC(p.id), JSON.stringify(p))
  await redis.pexpire(REC(p.id), RECORD_TTL_MS)
  await redis.set(LATEST(p.businessId), p.id)
  await redis.pexpire(LATEST(p.businessId), RECORD_TTL_MS)
  await redis.zadd(INDEX, p.startedAt, p.id)   // global release-history index (newest by startedAt)
}

/** All publish records, newest first — the release-history source. Bounded scan. */
export async function listPublishes(limit = 200): Promise<ReleasePublish[]> {
  const ids = await redis.zrevrange(INDEX, 0, Math.max(0, limit - 1))
  if (!ids.length) return []
  const recs = await Promise.all(ids.map(getPublish))
  return recs.filter((r): r is ReleasePublish => r !== null)
}

export type NewPublish = {
  now: number
  businessId: string
  businessSlug: string
  approvalId: string
  releaseId: string
  sourceDeploymentId: string
  mode: 'live' | 'simulated'
  startedBy: string
}

/** Create the record in 'promoting' and bind the approval→publish idempotency pointer. */
export async function startPublish(n: NewPublish): Promise<ReleasePublish> {
  const p: ReleasePublish = {
    recordVersion: RECORD_VERSION,
    id: await nextPublishId(),
    businessId: n.businessId, businessSlug: n.businessSlug, approvalId: n.approvalId,
    releaseId: n.releaseId, sourceDeploymentId: n.sourceDeploymentId, targetEnvironment: 'production',
    mode: n.mode, status: 'promoting', startedAt: n.now, updatedAt: n.now, startedBy: n.startedBy,
  }
  await savePublish(p)
  await redis.set(BYAPPROVAL(n.approvalId), p.id)
  await redis.pexpire(BYAPPROVAL(n.approvalId), RECORD_TTL_MS)
  return p
}

/** LIVE-only: the promotion was accepted; we are confirming Production is READY. */
export async function markVerifying(id: string, now: number, promotedDeploymentId?: string): Promise<ReleasePublish | null> {
  const p = await getPublish(id)
  if (!p) return null
  const v: ReleasePublish = { ...p, status: 'verifying', promotedDeploymentId: promotedDeploymentId ?? p.promotedDeploymentId, updatedAt: now }
  await savePublish(v)
  return v
}

export async function completePublish(id: string, now: number, promotedDeploymentId?: string): Promise<ReleasePublish | null> {
  const p = await getPublish(id)
  if (!p) return null
  const done: ReleasePublish = { ...p, status: 'completed', promotedDeploymentId, completedAt: now, updatedAt: now }
  await savePublish(done)
  return done
}

export async function failPublish(id: string, now: number, reason: string): Promise<ReleasePublish | null> {
  const p = await getPublish(id)
  if (!p) return null
  const failed: ReleasePublish = { ...p, status: 'failed', failureReason: reason.slice(0, 500), completedAt: now, updatedAt: now }
  await savePublish(failed)
  return failed
}
