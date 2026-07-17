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

// ── Daily spend counters (AI credit protection) ──────────────────────────────
// A tiny per-UTC-day hash counting inference attempts, estimated cost, retries, and
// prevented/blocked outcomes. Read by the budget gate BEFORE a call and incremented AFTER.
// Bounded by a 48h TTL so old days evaporate on their own — no cleanup job.
//
// These are counters, not the system of record: the jobs themselves remain the truth. If a
// counter is lost the worst case is one extra day's headroom, never a double-charge, because
// the per-booking cap is enforced from the job's own attempt count.
import { shadowDayKey } from './shadow-budget'

const KEY_SPEND = (day: string) => `shadow:spend:${day}`
const SPEND_TTL_S = 48 * 3600

export type ShadowDaySpend = {
  day: string
  evals: number          // inference attempts charged today
  costUsd: number
  retries: number
  preventedRetries: number   // permanent failures NOT retried (billing/auth/schema/…)
  budgetBlocked: number      // jobs a limit stopped before any call
}

/** Charge one inference attempt to today. cost is added as micro-dollars to keep the hash
 *  integer-only (Upstash HINCRBY is integer); read back divides by 1e6. */
export async function chargeShadowSpend(now: number, costUsd: number, wasRetry: boolean): Promise<void> {
  const key = KEY_SPEND(shadowDayKey(now))
  await redis.hincrby(key, 'evals', 1)
  if (costUsd > 0) await redis.hincrby(key, 'costMicroUsd', Math.round(costUsd * 1_000_000))
  if (wasRetry) await redis.hincrby(key, 'retries', 1)
  await redis.expire(key, SPEND_TTL_S)
}

export async function recordShadowSpendEvent(now: number, kind: 'preventedRetries' | 'budgetBlocked'): Promise<void> {
  const key = KEY_SPEND(shadowDayKey(now))
  await redis.hincrby(key, kind, 1)
  await redis.expire(key, SPEND_TTL_S)
}

/** costUsd read back from the micro-dollar counter. */
export async function readShadowSpend(now: number): Promise<ShadowDaySpend> {
  const day = shadowDayKey(now)
  const flat = await redis.hgetall(KEY_SPEND(day))
  const m: Record<string, string> = {}
  for (let i = 0; i < flat.length; i += 2) m[flat[i]] = flat[i + 1]
  return {
    day,
    evals: Number(m.evals ?? 0) || 0,
    costUsd: (Number(m.costMicroUsd ?? 0) || 0) / 1_000_000,
    retries: Number(m.retries ?? 0) || 0,
    preventedRetries: Number(m.preventedRetries ?? 0) || 0,
    budgetBlocked: Number(m.budgetBlocked ?? 0) || 0,
  }
}

// ── Runtime kill switch (emergency brake, no redeploy) ───────────────────────
// The env flag SHADOW_V2_KILL_SWITCH is the deploy-time default; this is the runtime
// override an owner can flip instantly from the dashboard. Either being "on" halts new V2
// inference. It halts ONLY new inference — V1, analytics, ground-truth editing, and stored
// results are untouched (they never call the model).
const KEY_KILL = 'settings:shadow_v2_kill'

export async function getShadowKillOverride(): Promise<boolean | null> {
  const raw = await redis.get(KEY_KILL)
  if (raw == null) return null
  return raw === '1' || raw === 'true'
}

export async function setShadowKillOverride(on: boolean): Promise<void> {
  await redis.set(KEY_KILL, on ? '1' : '0')
}

/** Effective kill state = env default OR runtime override. Fail-safe: if the override read
 *  throws, fall back to the env value rather than assuming "not killed". */
export async function shadowKillEngaged(envKilled: boolean): Promise<boolean> {
  if (envKilled) return true
  try {
    const o = await getShadowKillOverride()
    return o === true
  } catch {
    return envKilled
  }
}
