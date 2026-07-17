// ── Operion Shadow Alerting — durable store + run orchestrator ───────────────
//
// Lives in the tenant-scoped `shadow:*` family alongside the jobs it observes, so alerts
// inherit exactly the same tenant isolation as the evaluations they describe (every key
// routes through the redis chokepoint).
//
//   shadow:alert:{id}        → JSON ShadowAlert
//   shadow:alert:index       → zset (score=lastDetectedAt, member=id)
//   shadow:alert:counter     → id sequence (SAL-{n})
//   shadow:alert:readiness   → JSON ReadinessSnapshot — the ONLY state a transition needs
//   shadow:alert:lock        → run lock (setNxPx + compare-and-del), stops concurrent runs
//   shadow:alert:run         → JSON AlertRunSummary of the last completed run
//
// All decision-making lives in shadow-alert-engine.ts (pure). This module only does I/O:
// load, hand to the engine, persist what it decided.

import { redis } from '../redis'
import { listShadowJobs } from './shadow-store'
import { evaluateShadowAlerts, reconcileAlerts } from './shadow-alert-engine'
import { DEFAULT_ALERT_POLICIES } from './shadow-alert-policies'
import type { AlertPolicy, ReadinessSnapshot, ShadowAlert, AlertStatus, PolicySkip } from './shadow-alert-types'

const KEY_ALERT = 'shadow:alert:'
const KEY_INDEX = 'shadow:alert:index'
const KEY_COUNTER = 'shadow:alert:counter'
const KEY_READINESS = 'shadow:alert:readiness'
const KEY_LOCK = 'shadow:alert:lock'
const KEY_RUN = 'shadow:alert:run'

const MAX_KEEP = 2000
/** Mirrors SHADOW_JOB_SAMPLE in the analytics route so alerts and the dashboard read the
 *  same population — a threshold the dashboard cannot corroborate is a support ticket. */
const JOB_SAMPLE = 1000
const LOCK_TTL_MS = 120_000

const ID_RE = /^SAL-\d+$/

// Compare-and-delete: never release a lock this run no longer owns (same primitive the
// shadow job lock and route-mutex use).
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
const INCRBY = "return redis.call('incrby', KEYS[1], ARGV[1])"

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

// ── alert CRUD ───────────────────────────────────────────────────────────────

export async function getAlert(id: string): Promise<ShadowAlert | null> {
  if (!ID_RE.test(id)) return null
  return safeParse<ShadowAlert>(await redis.get(KEY_ALERT + id))
}

export async function saveAlert(alert: ShadowAlert): Promise<void> {
  await redis.set(KEY_ALERT + alert.id, JSON.stringify(alert))
  await redis.zadd(KEY_INDEX, alert.lastDetectedAt, alert.id)
}

export async function listAlerts(limit = 500): Promise<ShadowAlert[]> {
  const ids = await redis.zrevrange(KEY_INDEX, 0, Math.max(0, limit - 1))
  if (!ids.length) return []
  const raws = await Promise.all(ids.map((id) => redis.get(KEY_ALERT + id)))
  return raws.map((r) => safeParse<ShadowAlert>(r)).filter((a): a is ShadowAlert => a !== null)
}

/** Active = anything the owner still has to look at. */
export async function listActiveAlerts(limit = 500): Promise<ShadowAlert[]> {
  return (await listAlerts(limit)).filter((a) => a.status === 'OPEN' || a.status === 'ACKNOWLEDGED')
}

/** Best-effort bounded trim so the alert log cannot grow forever. Never drops an active alert. */
async function trim(): Promise<void> {
  try {
    const n = await redis.zcard(KEY_INDEX)
    if (n <= MAX_KEEP + 200) return
    const stale = await redis.zrange(KEY_INDEX, 0, n - MAX_KEEP - 1)
    for (const id of stale) {
      const a = await getAlert(id)
      if (a && (a.status === 'OPEN' || a.status === 'ACKNOWLEDGED')) continue
      await Promise.all([redis.del(KEY_ALERT + id), redis.zrem(KEY_INDEX, id)])
    }
  } catch (e) {
    console.warn('[shadow-alert-store] trim failed (soft):', e instanceof Error ? e.message : e)
  }
}

// ── readiness snapshot (the one piece of state a transition cannot re-derive) ─

export async function getReadinessSnapshot(): Promise<ReadinessSnapshot | null> {
  return safeParse<ReadinessSnapshot>(await redis.get(KEY_READINESS))
}

export async function saveReadinessSnapshot(snap: ReadinessSnapshot): Promise<void> {
  await redis.set(KEY_READINESS, JSON.stringify(snap))
}

// ── id allocation ────────────────────────────────────────────────────────────

/** Reserve a contiguous block of ids in one round trip. Suppressed signals leave gaps in
 *  the sequence; ids are opaque handles, not a count. */
async function reserveIds(n: number): Promise<number> {
  if (n <= 0) return 0
  const res = await redis.eval(INCRBY, [KEY_COUNTER], [String(n)])
  const end = Number(res)
  if (!Number.isFinite(end)) throw new Error('SHADOW_ALERT_ID_ALLOC_FAILED')
  return end - n + 1000 + 1   // first id in the reserved block
}

// ── run orchestration ────────────────────────────────────────────────────────

export type AlertRunSummary = {
  ok: boolean
  at: number
  durationMs: number
  /** Set when the run did no work; the run is still `ok`. */
  skipped?: 'locked'
  jobsRead: number
  signals: number
  opened: number
  updated: number
  resolved: number
  expired: number
  escalated: number
  suppressed: number
  /** Counts by skip reason — a policy that never fires should be explainable, not mysterious. */
  skipsByReason: Record<string, number>
  openedIds: string[]
  readinessTier?: string
  readinessScore?: number
  error?: string
}

const EMPTY_RUN = (now: number): AlertRunSummary => ({
  ok: true, at: now, durationMs: 0, jobsRead: 0, signals: 0, opened: 0, updated: 0,
  resolved: 0, expired: 0, escalated: 0, suppressed: 0, skipsByReason: {}, openedIds: [],
})

const tally = (skips: PolicySkip[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const s of skips) out[s.reason] = (out[s.reason] ?? 0) + 1
  return out
}

/**
 * One full evaluation pass: read jobs → evaluate → reconcile → persist.
 *
 * Idempotent and retry-safe. Re-running immediately re-derives the same signals, and the
 * reconciler refreshes the existing alerts rather than opening duplicates. A run lock makes
 * concurrent execution a no-op rather than a race, so an overlapping cron tick or a manual
 * re-run cannot double-alert.
 *
 * Callers must supply the tenant context (the cron fans out via withBackgroundTenant, exactly
 * like /api/cron/vision-shadow) and must check SHADOW_ALERTING_ENABLED first — this function
 * does not read flags, so tests can drive it directly.
 */
export async function runShadowAlertEvaluation(opts?: {
  now?: number
  policies?: readonly AlertPolicy[]
  jobLimit?: number
}): Promise<AlertRunSummary> {
  const now = opts?.now ?? Date.now()
  const started = now
  const token = `${now}-${process.pid}`
  const policies = opts?.policies ?? DEFAULT_ALERT_POLICIES

  const acquired = await redis.setNxPx(KEY_LOCK, token, LOCK_TTL_MS)
  if (!acquired) return { ...EMPTY_RUN(now), skipped: 'locked' }

  try {
    const jobs = await listShadowJobs(opts?.jobLimit ?? JOB_SAMPLE)
    const prior = await getReadinessSnapshot()

    const { signals, skips, readiness } = evaluateShadowAlerts({ jobs, now, policies, priorReadiness: prior })
    const existing = await listAlerts(MAX_KEEP)

    const base = await reserveIds(signals.length)
    const result = reconcileAlerts({
      existing, signals, now, policies,
      nextId: (i) => `SAL-${base + i}`,
    })

    // Persist the four disjoint buckets the reconciler produced.
    const toPersist = [...result.opened, ...result.updated, ...result.resolved, ...result.expired]
    for (const a of toPersist) await saveAlert(a)

    // Only advance the readiness baseline once the transition it implies has been recorded —
    // otherwise a crash between evaluate and persist would silently swallow a tier change.
    await saveReadinessSnapshot(readiness)
    await trim()

    const summary: AlertRunSummary = {
      ok: true,
      at: now,
      durationMs: Date.now() - started,
      jobsRead: jobs.length,
      signals: signals.length,
      opened: result.opened.length,
      updated: result.updated.length,
      resolved: result.resolved.length,
      expired: result.expired.length,
      escalated: result.escalated.length,
      suppressed: result.suppressed.length,
      skipsByReason: tally(skips),
      openedIds: result.opened.map((a) => a.id),
      readinessTier: readiness.tier,
      readinessScore: readiness.score,
    }
    await redis.set(KEY_RUN, JSON.stringify(summary))
    return summary
  } catch (e) {
    const summary: AlertRunSummary = {
      ...EMPTY_RUN(now),
      ok: false,
      durationMs: Date.now() - started,
      error: e instanceof Error ? e.name : 'unknown',
    }
    try { await redis.set(KEY_RUN, JSON.stringify(summary)) } catch { /* telemetry is best-effort */ }
    return summary
  } finally {
    try { await redis.eval(RELEASE, [KEY_LOCK], [token]) } catch { /* lock TTLs out */ }
  }
}

export async function getLastAlertRun(): Promise<AlertRunSummary | null> {
  return safeParse<AlertRunSummary>(await redis.get(KEY_RUN))
}

// ── owner lifecycle transitions (transport + authorization land in Increment 2) ─

export type AlertTransition =
  | { type: 'acknowledge' }
  | { type: 'resolve'; reason?: string }
  | { type: 'mute'; durationMs: number }
  | { type: 'unmute' }
  | { type: 'note'; note: string }
  | { type: 'mark_read' }

export type TransitionResult =
  | { ok: true; alert: ShadowAlert; auditAction: string; summary: string; priorStatus: AlertStatus; newStatus: AlertStatus }
  | { ok: false; error: string }

const MAX_NOTES = 50
const MAX_NOTE_CHARS = 2000
const MAX_MUTE_MS = 30 * 24 * 60 * 60 * 1000

/** PURE owner transition — validates and returns the next alert state. Callers persist it
 *  and write the audit event. Mirrors applyShadowAction() in shadow-classification.ts. */
export function applyAlertTransition(
  alert: ShadowAlert, t: AlertTransition, actor: string, now: number,
): TransitionResult {
  const prior = alert.status
  const a: ShadowAlert = { ...alert, notes: [...alert.notes], relatedBookingIds: [...alert.relatedBookingIds], relatedTraceIds: [...alert.relatedTraceIds] }

  switch (t.type) {
    case 'acknowledge': {
      if (prior !== 'OPEN') return { ok: false, error: `Cannot acknowledge an alert that is ${prior}.` }
      a.status = 'ACKNOWLEDGED'
      a.acknowledgedAt = now
      a.acknowledgedBy = actor
      a.unread = false
      return { ok: true, alert: a, auditAction: 'shadow_alert.acknowledged', summary: `Acknowledged alert ${a.id} (${a.policyType}).`, priorStatus: prior, newStatus: a.status }
    }
    case 'resolve': {
      if (prior !== 'OPEN' && prior !== 'ACKNOWLEDGED' && prior !== 'MUTED') return { ok: false, error: `Cannot resolve an alert that is ${prior}.` }
      a.status = 'RESOLVED'
      a.resolvedAt = now
      a.resolvedBy = actor
      a.resolvedReason = (t.reason ?? '').slice(0, MAX_NOTE_CHARS) || 'Resolved by owner.'
      a.unread = false
      return { ok: true, alert: a, auditAction: 'shadow_alert.resolved', summary: `Resolved alert ${a.id} (${a.policyType}).`, priorStatus: prior, newStatus: a.status }
    }
    case 'mute': {
      if (prior === 'RESOLVED' || prior === 'EXPIRED') return { ok: false, error: `Cannot mute an alert that is ${prior}.` }
      if (!Number.isFinite(t.durationMs) || t.durationMs <= 0) return { ok: false, error: 'Mute duration must be a positive number of milliseconds.' }
      if (t.durationMs > MAX_MUTE_MS) return { ok: false, error: 'Mute duration cannot exceed 30 days — a permanent mute must be an explicit policy change.' }
      a.status = 'MUTED'
      a.mutedUntil = now + t.durationMs
      a.mutedBy = actor
      a.unread = false
      return { ok: true, alert: a, auditAction: 'shadow_alert.muted', summary: `Muted alert ${a.id} until ${new Date(a.mutedUntil).toISOString()}.`, priorStatus: prior, newStatus: a.status }
    }
    case 'unmute': {
      if (prior !== 'MUTED') return { ok: false, error: `Alert is ${prior}, not muted.` }
      a.status = 'OPEN'
      a.mutedUntil = undefined
      a.mutedBy = undefined
      return { ok: true, alert: a, auditAction: 'shadow_alert.unmuted', summary: `Unmuted alert ${a.id}.`, priorStatus: prior, newStatus: a.status }
    }
    case 'note': {
      const note = (t.note ?? '').trim()
      if (!note) return { ok: false, error: 'Note cannot be empty.' }
      a.notes = [...a.notes, { note: note.slice(0, MAX_NOTE_CHARS), by: actor, at: now }].slice(-MAX_NOTES)
      return { ok: true, alert: a, auditAction: 'shadow_alert.note_added', summary: `Added a note to alert ${a.id}.`, priorStatus: prior, newStatus: a.status }
    }
    case 'mark_read': {
      a.unread = false
      return { ok: true, alert: a, auditAction: 'shadow_alert.read', summary: `Marked alert ${a.id} read.`, priorStatus: prior, newStatus: a.status }
    }
    default:
      return { ok: false, error: 'Unknown alert transition.' }
  }
}
