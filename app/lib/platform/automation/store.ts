// ── Operion automation — durable store (platform:autojob:* key family) ───────
import { redis } from '../../redis'
import type { UpdateAutomationJob } from './types'
import { AUTOMATION_ACTIVE } from './types'

const K_JOB = 'platform:autojob:'
const K_IDX = 'platform:autojob:index'
const K_CTR = 'platform:autojob:counter'
const K_IDEM = 'platform:autoidem:'      // idempotencyKey -> jobId
const K_LOCK = 'platform:autolock:'      // per-business orchestration lock
const K_CB = 'platform:autocb:'          // callback delivery-id replay guard

const parse = <T>(raw: string | null): T | null => { if (!raw) return null; try { return JSON.parse(raw) as T } catch { return null } }

export async function nextJobId(): Promise<string> { return `AUTO-${1000 + (await redis.incr(K_CTR))}` }
export async function getJob(id: string): Promise<UpdateAutomationJob | null> { return parse(await redis.get(K_JOB + id)) }
export async function saveJob(j: UpdateAutomationJob): Promise<void> {
  await redis.set(K_JOB + j.id, JSON.stringify(j))
  await redis.zadd(K_IDX, j.updatedAt, j.id)
}
export async function listJobs(limit = 200): Promise<UpdateAutomationJob[]> {
  const ids = await redis.zrevrange(K_IDX, 0, Math.max(0, limit - 1))
  // Batch the reads (activeJobForBusiness scans up to 500) instead of serial GETs.
  // zrevrange already ordered the ids, so output order/contents are identical.
  const jobs = await Promise.all(ids.map(getJob))
  return jobs.filter((j): j is UpdateAutomationJob => j !== null)
}
export async function activeJobForBusiness(businessId: string): Promise<UpdateAutomationJob | null> {
  return (await listJobs(500)).find(j => j.businessId === businessId && AUTOMATION_ACTIVE.includes(j.status)) ?? null
}

// Idempotency: one job per (business, update, source commit) attempt-set.
export async function jobForIdempotency(key: string): Promise<UpdateAutomationJob | null> {
  const id = await redis.get(K_IDEM + key)
  return id ? getJob(id) : null
}
export async function bindIdempotency(key: string, jobId: string): Promise<void> { await redis.set(K_IDEM + key, jobId) }

// Per-business orchestration lock (prevents two jobs/promotions racing one target).
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
export async function withBusinessLock<T>(businessId: string, fn: () => Promise<T>, opts: { onBusy: () => T; token: string; ttlMs?: number }): Promise<T> {
  const acquired = await redis.setNxPx(K_LOCK + businessId, opts.token, opts.ttlMs ?? 60_000)
  if (!acquired) return opts.onBusy()
  try { return await fn() } finally { try { await redis.eval(RELEASE, [K_LOCK + businessId], [opts.token]) } catch { /* TTL */ } }
}

// Callback replay guard: a delivery id may be processed at most once (TTL-bounded).
export async function callbackSeen(deliveryId: string): Promise<boolean> { return (await redis.get(K_CB + deliveryId)) != null }
export async function markCallbackSeen(deliveryId: string, ttlMs = 24 * 60 * 60_000): Promise<void> {
  await redis.set(K_CB + deliveryId, '1'); await redis.pexpire(K_CB + deliveryId, ttlMs)
}
