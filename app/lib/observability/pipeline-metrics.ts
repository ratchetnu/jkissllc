import { redis } from '../redis'
import { isEnabled } from '../platform/flags'
import { currentTenantId } from '../platform/tenancy/context'
import type { PipelineTraceRecord } from './pipeline-trace'

// ── Pipeline-trace store (OPERION AI observability) ──────────────────────────
// The write/read substrate for per-job stage-latency traces. Mirrors the AI audit
// log conventions in app/lib/ai/telemetry.ts: one JSON blob per trace + a zset index
// scored by start time, an idempotency guard, a bounded retention window, and
// FAIL-SOFT persistence (a metrics write must never break the durable job path).
//
// Keyspace: `obs:trace:{id}` (record) + `obs:trace:log` (zset, score=startedAt).
// Unlike `ai:*` (a platform-global family filtered on read) these keys are NOT on the
// tenancy allowlist, so the Redis chokepoint tenant-prefixes them automatically when
// TENANCY_ENABLED — the index is already per-tenant. We ALSO stamp `tenantId` on each
// record and filter on read (defense-in-depth; inert while tenancy is off).

const KEY = (id: string) => `obs:trace:${id}`
const INDEX = 'obs:trace:log'
const DEDUP = (id: string) => `obs:trace:seen:${id}`
const DEDUP_TTL_MS = 60 * 60 * 1000
const MAX_KEEP = 5_000

// The Redis surface the store needs. `redis` satisfies it; tests inject an in-memory
// fake. Optional param throughout, so live callers pass nothing.
export type PipelineTraceStore = Pick<typeof redis,
  'get' | 'set' | 'del' | 'zadd' | 'zrevrange' | 'zrange' | 'zrem' | 'zcard' | 'setNxPx'>

// Inert while TENANCY_ENABLED=false (returns records unchanged). When tenancy is on,
// returns only the current tenant's traces; enabled-but-no-context fails CLOSED.
export function scopeTraces(records: PipelineTraceRecord[]): PipelineTraceRecord[] {
  if (!isEnabled('TENANCY_ENABLED')) return records
  const tid = currentTenantId()
  if (!tid) return []
  return records.filter(r => r.tenantId === tid)
}

export async function recordTrace(rec: PipelineTraceRecord, store: PipelineTraceStore = redis): Promise<void> {
  try {
    // Idempotency: never write two records for the same run id (a re-delivered handler
    // or accidental double-flush). First writer wins; fail-OPEN if the guard errors.
    try {
      const fresh = await store.setNxPx(DEDUP(rec.id), '1', DEDUP_TTL_MS)
      if (!fresh) return
    } catch { /* guard unavailable → still record */ }

    await store.set(KEY(rec.id), JSON.stringify(rec))
    await store.zadd(INDEX, rec.at, rec.id)
    const n = await store.zcard(INDEX)
    if (n > MAX_KEEP + 200) {
      const stale = await store.zrange(INDEX, 0, n - MAX_KEEP - 1)
      await Promise.all(stale.map(id => Promise.all([store.del(KEY(id)), store.zrem(INDEX, id)])))
    }
  } catch (e) {
    // Metrics must never break the request/job path (fail-soft).
    console.error('[observability/pipeline] record failed', e)
  }
}

export async function getTrace(id: string, store: PipelineTraceStore = redis): Promise<PipelineTraceRecord | null> {
  const raw = await store.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as PipelineTraceRecord } catch { return null }
}

export async function listTraces(limit = 2000, store: PipelineTraceStore = redis): Promise<PipelineTraceRecord[]> {
  const ids = await store.zrevrange(INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => store.get(KEY(id))))
  const recs = raws
    .map(r => { try { return r ? JSON.parse(r as string) as PipelineTraceRecord : null } catch { return null } })
    .filter((x): x is PipelineTraceRecord => x !== null)
  return scopeTraces(recs)
}
