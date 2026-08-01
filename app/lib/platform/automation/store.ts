// ── Operion automation — durable store (platform:autojob:* key family) ───────
import { redis } from '../../redis'
import { randomUUID } from 'node:crypto'
import type { UpdateAutomationJob, TransferEvidence } from './types'
import { AUTOMATION_ACTIVE, EVIDENCE_TTL_MS } from './types'
import { TRANSIENT_FAILURES } from './deploy-view'

const K_JOB = 'platform:autojob:'
const K_IDX = 'platform:autojob:index'
// Jobs which still need background attention. The historical reconciler scanned only
// the 200 most-recently-updated jobs, so an older stuck job could disappear behind newer
// terminal work forever. This index is maintained on every save and read oldest-first.
const K_RECONCILE = 'platform:autojob:reconcile'
const K_RECONCILE_MIGRATED = 'platform:autojob:reconcile:migrated:v1'
const K_RECONCILE_MIGRATION_LOCK = 'platform:autojob:reconcile:migration-lock:v1'
const K_CTR = 'platform:autojob:counter'
const K_IDEM = 'platform:autoidem:'      // idempotencyKey -> jobId
const K_LOCK = 'platform:autolock:'      // per-business orchestration lock
const K_CB = 'platform:autocb:'          // callback delivery-id replay guard
const K_EV = 'platform:autoev:'          // transfer evidence, off the bulk job read path
const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

const parse = <T>(raw: string | null): T | null => { if (!raw) return null; try { return JSON.parse(raw) as T } catch { return null } }

export async function nextJobId(): Promise<string> {
  // Counters are environment-local, so Preview and Production can both create AUTO-1002.
  // A globally unique id prevents a callback from one control plane ever resolving a job
  // in another, even when both environments share the same callback signing secret.
  await redis.incr(K_CTR) // retain the operational count without using it as identity
  return `AUTO-${randomUUID()}`
}
export async function getJob(id: string): Promise<UpdateAutomationJob | null> { return parse(await redis.get(K_JOB + id)) }
export async function saveJob(j: UpdateAutomationJob): Promise<void> {
  await redis.set(K_JOB + j.id, JSON.stringify(j))
  await redis.zadd(K_IDX, j.updatedAt, j.id)
  if (needsReconciliation(j)) await redis.zadd(K_RECONCILE, j.updatedAt, j.id)
  else await redis.zrem(K_RECONCILE, j.id)
}
export async function listJobs(limit = 200): Promise<UpdateAutomationJob[]> {
  const ids = await redis.zrevrange(K_IDX, 0, Math.max(0, limit - 1))
  // Batch the reads (activeJobForBusiness scans up to 500) instead of serial GETs.
  // zrevrange already ordered the ids, so output order/contents are identical.
  const jobs = await Promise.all(ids.map(getJob))
  return jobs.filter((j): j is UpdateAutomationJob => j !== null)
}

function needsReconciliation(j: UpdateAutomationJob): boolean {
  // A complete review waits for a human, not a worker. Keeping thousands of healthy
  // review-ready jobs in an oldest-first queue could crowd out actual running work.
  const backgroundActive = AUTOMATION_ACTIVE.includes(j.status) && j.status !== 'awaiting_owner_review'
  const incompleteReview = j.status === 'awaiting_owner_review' && (!j.pullRequestUrl || !j.previewUrl)
  return backgroundActive || incompleteReview
    || j.status === 'rollback_required'
    || (j.status === 'failed' && !!j.failureCategory && TRANSIENT_FAILURES.has(j.failureCategory))
    || (j.status === 'completed' && !j.recordsFinalizedAt)
}

async function migrateLegacyReconcileIndex(): Promise<void> {
  if (await redis.get(K_RECONCILE_MIGRATED)) return
  const token = randomUUID()
  const locked = await redis.setNxPx(K_RECONCILE_MIGRATION_LOCK, token, 5 * 60_000)
  if (!locked) return
  try {
    if (await redis.get(K_RECONCILE_MIGRATED)) return
    // Walk the complete historical index in bounded pages. A fixed record ceiling would
    // silently lose the oldest stuck jobs—the exact failure this migration repairs.
    const pageSize = 500
    for (let offset = 0; ; offset += pageSize) {
      const ids = await redis.zrevrange(K_IDX, offset, offset + pageSize - 1)
      const jobs = await Promise.all(ids.map(getJob))
      await Promise.all(jobs.filter((j): j is UpdateAutomationJob => !!j && needsReconciliation(j))
        .map(j => redis.zadd(K_RECONCILE, j.updatedAt, j.id)))
      if (ids.length < pageSize) break
    }
    await redis.set(K_RECONCILE_MIGRATED, '1')
  } finally {
    try { await redis.eval(RELEASE_LOCK, [K_RECONCILE_MIGRATION_LOCK], [token]) } catch { /* TTL */ }
  }
}

/** Background candidates, oldest first so no job can starve behind newer traffic.
 *
 * The one-time legacy pass migrates records written before this index existed. New and
 * subsequently changed records are maintained by saveJob, so normal cron runs only read
 * the small active index instead of repeatedly scanning historical jobs.
 */
export async function listReconcileJobs(limit = 500): Promise<UpdateAutomationJob[]> {
  await migrateLegacyReconcileIndex()

  const indexedIds = await redis.zrange(K_RECONCILE, 0, Math.max(0, limit - 1))
  const indexed = await Promise.all(indexedIds.map(getJob))
  const byId = new Map<string, UpdateAutomationJob>()
  for (const job of indexed) {
    if (job && needsReconciliation(job)) byId.set(job.id, job)
  }
  return [...byId.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, limit)
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
export async function withBusinessLock<T>(businessId: string, fn: () => Promise<T>, opts: { onBusy: () => T; token: string; ttlMs?: number }): Promise<T> {
  const acquired = await redis.setNxPx(K_LOCK + businessId, opts.token, opts.ttlMs ?? 60_000)
  if (!acquired) return opts.onBusy()
  try { return await fn() } finally { try { await redis.eval(RELEASE_LOCK, [K_LOCK + businessId], [opts.token]) } catch { /* TTL */ } }
}

// Transfer evidence (§4 #7). Deliberately a SEPARATE key family: `listJobs` loads whole
// job records 500 at a time on the preflight path, so this must never ride along on the
// job. TTL-bounded — evidence is for incident review, and the job record outlives it.
// Retention expiry and "never recorded" are indistinguishable to a reader, which is
// correct: both mean there is nothing to show.
export async function saveTransferEvidence(e: TransferEvidence): Promise<void> {
  await redis.set(K_EV + e.jobId, JSON.stringify(e))
  await redis.pexpire(K_EV + e.jobId, EVIDENCE_TTL_MS)
}
export async function getTransferEvidence(jobId: string): Promise<TransferEvidence | null> {
  return parse<TransferEvidence>(await redis.get(K_EV + jobId))
}

// Callback replay guard: a delivery id may be processed at most once (TTL-bounded).
export async function callbackSeen(deliveryId: string): Promise<boolean> { return (await redis.get(K_CB + deliveryId)) != null }
export async function markCallbackSeen(deliveryId: string, ttlMs = 24 * 60 * 60_000): Promise<void> {
  await redis.set(K_CB + deliveryId, '1'); await redis.pexpire(K_CB + deliveryId, ttlMs)
}
