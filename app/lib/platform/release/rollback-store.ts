// ── Operion Release Center — rollback store (platform:rollback:* global family) ──
//
// Increment 3B.6. Persists controlled-rollback records + the per-business rollback lock and
// a per-target idempotency pointer, mirroring the publish store. WRITE surface is tiny:
// acquire/release the lock, start/complete/fail a record, and bind a target→rollback pointer
// so a repeat never launches a second rollback. Touches no business/job/deployment/provider —
// only rollback KV.

import { redis } from '../../redis'
import type { ReleaseRollback } from './release-history'

const REC = (id: string) => `platform:rollback:rec:${id}`
const LATEST = (businessId: string) => `platform:rollback:latest:${businessId}`
const BYTARGET = (key: string) => `platform:rollback:bytarget:${key}`   // businessId:targetDeploymentId → rollbackId
const LOCK = (businessId: string) => `platform:rollback:lock:${businessId}`
const INDEX = 'platform:rollback:index'
const CTR = 'platform:rollback:counter'
const RECORD_VERSION = 1
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LOCK_TTL_MS = 120_000

const parse = (raw: string | null): ReleaseRollback | null => {
  if (!raw) return null
  try { return JSON.parse(raw) as ReleaseRollback } catch { return null }
}

export async function nextRollbackId(): Promise<string> { return `RBK-${1000 + (await redis.incr(CTR))}` }
export async function getRollback(id: string): Promise<ReleaseRollback | null> { return parse(await redis.get(REC(id))) }

export async function getLatestRollbackFor(businessId: string): Promise<ReleaseRollback | null> {
  const id = await redis.get(LATEST(businessId))
  return id ? getRollback(id) : null
}

/** The rollback (if any) that already targeted a given business+deployment — idempotency anchor. */
export async function getRollbackByTarget(businessId: string, targetDeploymentId: string): Promise<ReleaseRollback | null> {
  const id = await redis.get(BYTARGET(`${businessId}:${targetDeploymentId}`))
  return id ? getRollback(id) : null
}

export async function acquireRollbackLock(businessId: string, holder: string): Promise<boolean> {
  return redis.setNxPx(LOCK(businessId), holder, LOCK_TTL_MS)
}
export async function releaseRollbackLock(businessId: string): Promise<void> {
  await redis.del(LOCK(businessId)).catch(() => {})
}

export async function saveRollback(r: ReleaseRollback): Promise<void> {
  await redis.set(REC(r.id), JSON.stringify(r))
  await redis.pexpire(REC(r.id), RECORD_TTL_MS)
  await redis.set(LATEST(r.businessId), r.id)
  await redis.pexpire(LATEST(r.businessId), RECORD_TTL_MS)
  await redis.zadd(INDEX, r.startedAt, r.id)
}

/** All rollback records, newest first — feeds release history. Bounded scan. */
export async function listRollbacks(limit = 200): Promise<ReleaseRollback[]> {
  const ids = await redis.zrevrange(INDEX, 0, Math.max(0, limit - 1))
  if (!ids.length) return []
  const recs = await Promise.all(ids.map(getRollback))
  return recs.filter((r): r is ReleaseRollback => r !== null)
}

export type NewRollback = {
  now: number
  businessId: string
  businessSlug: string
  targetDeploymentId: string
  targetCommit?: string
  fromDeploymentId?: string
  rolledBackPublishId?: string
  mode: 'live' | 'simulated'
  startedBy: string
  approvalId?: string
  approvedBy?: string
  approvedAt?: number
}

/** Create the record in 'rolling_back' and bind the target→rollback idempotency pointer. */
export async function startRollback(n: NewRollback): Promise<ReleaseRollback> {
  const r: ReleaseRollback = {
    recordVersion: RECORD_VERSION,
    id: await nextRollbackId(),
    businessId: n.businessId, businessSlug: n.businessSlug,
    targetDeploymentId: n.targetDeploymentId, targetCommit: n.targetCommit, fromDeploymentId: n.fromDeploymentId,
    rolledBackPublishId: n.rolledBackPublishId, targetEnvironment: 'production',
    mode: n.mode, status: 'rolling_back', approvalId: n.approvalId, approvedBy: n.approvedBy, approvedAt: n.approvedAt,
    startedAt: n.now, updatedAt: n.now, startedBy: n.startedBy,
  }
  await saveRollback(r)
  await redis.set(BYTARGET(`${n.businessId}:${n.targetDeploymentId}`), r.id)
  await redis.pexpire(BYTARGET(`${n.businessId}:${n.targetDeploymentId}`), RECORD_TTL_MS)
  return r
}

export async function completeRollback(id: string, now: number): Promise<ReleaseRollback | null> {
  const r = await getRollback(id)
  if (!r) return null
  const done: ReleaseRollback = { ...r, status: 'completed', completedAt: now, updatedAt: now }
  await saveRollback(done)
  return done
}

export async function failRollback(id: string, now: number, reason: string): Promise<ReleaseRollback | null> {
  const r = await getRollback(id)
  if (!r) return null
  const failed: ReleaseRollback = { ...r, status: 'failed', failureReason: reason.slice(0, 500), completedAt: now, updatedAt: now }
  await saveRollback(failed)
  return failed
}
