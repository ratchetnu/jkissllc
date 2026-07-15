// ── V2 Shadow — durable store (independent Redis key family `shadow:*`) ───────
//
// The shadow job + its result live in their OWN keys, NOT inside the booking blob, so
// the shadow subsystem can never race the authoritative worker on `bk:{token}` and can
// never be returned to a customer by a booking read. All keys route through the redis
// chokepoint (so they inherit tenant scoping exactly like `bk:*`).
//
//   shadow:job:{bookingId}   → JSON V2ShadowJob
//   shadow:index             → zset (score=updatedAt, member=bookingId) for scan/list
//   shadow:selected          → JSON string[]  (owner-selected bookingIds; selected-only mode)
//   shadow:excluded          → JSON Record<bookingId, {reason,by,at}> (owner opt-outs)
//   shadow:lock:{bookingId}  → per-job processing lock (setNxPx + compare-and-del)

import { redis } from '../redis'
import type { V2ShadowJob } from './shadow-types'

const KEY_JOB = 'shadow:job:'
const KEY_INDEX = 'shadow:index'
const KEY_SELECTED = 'shadow:selected'
const KEY_EXCLUDED = 'shadow:excluded'
const KEY_LOCK = 'shadow:lock:'

const TOKEN_RE = /^[a-f0-9]{16,}$/i

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

// ── Job CRUD ─────────────────────────────────────────────────────────────────
export async function getShadowJob(bookingId: string): Promise<V2ShadowJob | null> {
  if (!TOKEN_RE.test(bookingId)) return null
  return safeParse<V2ShadowJob>(await redis.get(KEY_JOB + bookingId))
}

export async function saveShadowJob(job: V2ShadowJob): Promise<void> {
  job.updatedAt = job.updatedAt || 0
  await redis.set(KEY_JOB + job.bookingId, JSON.stringify(job))
  await redis.zadd(KEY_INDEX, job.updatedAt, job.bookingId)
}

export async function deleteShadowJob(bookingId: string): Promise<void> {
  await redis.del(KEY_JOB + bookingId)
  await redis.zrem(KEY_INDEX, bookingId)
}

/** Most-recent shadow jobs (for admin listing + the reaper/worker scan). */
export async function listShadowJobs(limit = 200): Promise<V2ShadowJob[]> {
  const ids = await redis.zrevrange(KEY_INDEX, 0, Math.max(0, limit - 1))
  const out: V2ShadowJob[] = []
  for (const id of ids) {
    const j = await getShadowJob(id)
    if (j) out.push(j)
  }
  return out
}

// ── Owner selection / exclusion (small, owner-managed sets) ──────────────────
export async function getSelected(): Promise<string[]> {
  return safeParse<string[]>(await redis.get(KEY_SELECTED)) ?? []
}
export async function isSelected(bookingId: string): Promise<boolean> {
  return (await getSelected()).includes(bookingId)
}
export async function addSelected(bookingId: string): Promise<void> {
  const cur = await getSelected()
  if (!cur.includes(bookingId)) { cur.push(bookingId); await redis.set(KEY_SELECTED, JSON.stringify(cur)) }
}
export async function removeSelected(bookingId: string): Promise<void> {
  const cur = await getSelected()
  const next = cur.filter((x) => x !== bookingId)
  if (next.length !== cur.length) await redis.set(KEY_SELECTED, JSON.stringify(next))
}

export type ExclusionMap = Record<string, { reason?: string; by?: string; at: number }>
export async function getExcluded(): Promise<ExclusionMap> {
  return safeParse<ExclusionMap>(await redis.get(KEY_EXCLUDED)) ?? {}
}
export async function isExcluded(bookingId: string): Promise<boolean> {
  return !!(await getExcluded())[bookingId]
}
export async function addExcluded(bookingId: string, reason: string | undefined, by: string | undefined, at: number): Promise<void> {
  const cur = await getExcluded()
  cur[bookingId] = { reason, by, at }
  await redis.set(KEY_EXCLUDED, JSON.stringify(cur))
}
export async function removeExcluded(bookingId: string): Promise<void> {
  const cur = await getExcluded()
  if (cur[bookingId]) { delete cur[bookingId]; await redis.set(KEY_EXCLUDED, JSON.stringify(cur)) }
}

// ── Per-job processing lock (independent of withBookingWriteLock) ────────────
// Compare-and-delete release so we never delete a lock re-acquired by someone else.
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/** Run fn while holding the shadow lock for a booking; on contention call onBusy. */
export async function withShadowLock<T>(
  bookingId: string,
  fn: () => Promise<T>,
  opts: { onBusy: () => T; ttlMs?: number; token: string },
): Promise<T> {
  const acquired = await redis.setNxPx(KEY_LOCK + bookingId, opts.token, opts.ttlMs ?? 20_000)
  if (!acquired) return opts.onBusy()
  try {
    return await fn()
  } finally {
    try { await redis.eval(RELEASE, [KEY_LOCK + bookingId], [opts.token]) } catch { /* lock will TTL out */ }
  }
}
