// Sprint 7 — operational readiness: the gap log and the observation window.
//
// The roadmap asks for a "one-week operational gap log". A week of observation is
// ELAPSED TIME, not something code can produce, so this module is built around one
// rule: it must be impossible to report an observation as complete before it
// actually is.
//
// That rule is why `windowStatus` derives everything from timestamps rather than
// from a stored boolean. A `complete` flag can be set by an optimistic caller, a
// migration, or a well-meaning fix; elapsed time cannot. A window is complete only
// when BOTH the clock has run out AND a follow-up reading exists — a window that
// ran its seven days but was never read again proves nothing, and says so.
//
// The Upstash request COUNT is not machine-readable from here: the Vercel
// marketplace API exposes spend, not usage, and the store's own credentials are
// Production-only and redacted. So the count is an EXTERNALLY SOURCED reading —
// typed as such, stamped with who read it and from where, and never inferred.
// Guessing it would produce exactly the false confidence this sprint exists to
// prevent.
import { redis } from '../redis'

export const OPS_READINESS_VERSION = 1

const KEY_BASELINE = 'ops:baseline:'
const KEY_BASELINE_INDEX = 'ops:baseline:index'
const KEY_GAP = 'ops:gap:'
const KEY_GAP_INDEX = 'ops:gap:index'

export const MAX_LISTED = 100

// ── Gap log ──────────────────────────────────────────────────────────────────

/** How badly a gap bit. `blocker` = someone could not do their job. */
export type GapSeverity = 'blocker' | 'degraded' | 'papercut'
export const GAP_SEVERITIES: GapSeverity[] = ['blocker', 'degraded', 'papercut']

/** Which surface the gap was observed on. Free-form but recorded, so the log can
 *  be read by area rather than as an undifferentiated list. */
export type OpsGap = {
  id: string
  at: number
  observedBy: string
  severity: GapSeverity
  surface: string
  summary: string
  detail?: string
  resolvedAt?: number
  resolutionNote?: string
}

// ── Baseline / follow-up readings ────────────────────────────────────────────

/**
 * A reading taken from OUTSIDE this system — the Upstash console gauge. Typed
 * separately from the machine-collected fields so a reader can always tell which
 * numbers the platform measured and which a human transcribed.
 */
export type ExternalUsageReading = {
  requestsUsed: number
  allowance: number
  readAt: number
  /** Where the human read it, e.g. 'upstash console — Operion db, Details tab'. */
  source: string
  readBy: string
}

export type OpsReading = {
  id: string
  kind: 'baseline' | 'follow_up'
  capturedAt: number
  capturedBy: string
  /** Machine-collected. */
  build: string
  health: 'healthy' | 'degraded' | 'unhealthy'
  cronRunsPerDay: number
  estimatedRedisRequestsPerDay: number
  /** Human-transcribed; absent until someone reads the console. */
  upstash?: ExternalUsageReading
  notes?: string
  /** For a follow-up: which baseline it is measured against. */
  baselineId?: string
}

export const READING_ID_RE = /^ops_[a-z0-9]{8,40}$/
export const GAP_ID_RE = /^gap_[a-z0-9]{8,40}$/

const safeParse = <T,>(raw: unknown): T | null => {
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) as T } catch { return null }
}

// ── Observation window (the honesty core) ────────────────────────────────────

export type WindowTarget = { hours: number; label: string }
export const WINDOW_24H: WindowTarget = { hours: 24, label: '24-hour' }
export const WINDOW_7D: WindowTarget = { hours: 168, label: 'seven-day' }

export type WindowStatus = {
  label: string
  targetHours: number
  startedAt: number
  elapsedHours: number
  remainingHours: number
  /** Has enough time passed? Necessary, NOT sufficient. */
  elapsed: boolean
  /** Has a follow-up reading actually been taken? */
  followUpCaptured: boolean
  /** Complete ⇔ elapsed AND followUpCaptured. Never stored — always derived. */
  complete: boolean
  /** Plain-language state for a reader who will not read the booleans. */
  statement: string
}

/**
 * Derive an observation window's state. PURE — no clock, no I/O; `now` is passed
 * in so the result is testable and cannot drift.
 *
 * There is deliberately no way to mark a window complete. Completion is computed
 * from elapsed time and the presence of a follow-up reading, so no caller — and no
 * future edit that "just needs it green" — can assert it early.
 */
export function windowStatus(
  target: WindowTarget,
  startedAt: number,
  now: number,
  followUp: OpsReading | null,
): WindowStatus {
  const elapsedMs = Math.max(0, now - startedAt)
  const elapsedHours = Math.floor((elapsedMs / 3_600_000) * 10) / 10
  const elapsed = elapsedHours >= target.hours
  const followUpCaptured = !!followUp
  const complete = elapsed && followUpCaptured
  const remainingHours = Math.max(0, Math.round((target.hours - elapsedHours) * 10) / 10)

  let statement: string
  if (complete) {
    statement = `${target.label} observation COMPLETE — ${elapsedHours}h elapsed and a follow-up reading was captured.`
  } else if (!elapsed && !followUpCaptured) {
    statement = `${target.label} observation IN PROGRESS — ${elapsedHours}h of ${target.hours}h elapsed, ${remainingHours}h remaining. No follow-up reading yet.`
  } else if (!elapsed) {
    statement = `${target.label} observation IN PROGRESS — a follow-up reading exists but only ${elapsedHours}h of ${target.hours}h have elapsed. Not complete.`
  } else {
    statement = `${target.label} observation AWAITING FOLLOW-UP — ${elapsedHours}h elapsed, but no follow-up reading has been captured, so nothing has been compared.`
  }

  return { label: target.label, targetHours: target.hours, startedAt, elapsedHours, remainingHours, elapsed, followUpCaptured, complete, statement }
}

/** Compare two readings. Returns null when the follow-up lacks an external usage
 *  reading — a comparison with nothing to compare is not a result. */
export type UsageDelta = {
  hoursBetween: number
  baselineRequests: number
  followUpRequests: number
  requestsConsumed: number
  requestsPerHour: number
  projectedPerDay: number
  projectedPer30Days: number
  allowance: number
  projectedPctOfAllowance: number
  withinAllowance: boolean
}

export function compareUsage(baseline: OpsReading, followUp: OpsReading): UsageDelta | null {
  const a = baseline.upstash, b = followUp.upstash
  if (!a || !b) return null
  const hoursBetween = Math.max(0, (b.readAt - a.readAt) / 3_600_000)
  if (hoursBetween <= 0) return null
  const requestsConsumed = Math.max(0, b.requestsUsed - a.requestsUsed)
  const requestsPerHour = requestsConsumed / hoursBetween
  const projectedPerDay = Math.round(requestsPerHour * 24)
  const projectedPer30Days = projectedPerDay * 30
  const allowance = b.allowance || a.allowance || 0
  return {
    hoursBetween: Math.round(hoursBetween * 10) / 10,
    baselineRequests: a.requestsUsed,
    followUpRequests: b.requestsUsed,
    requestsConsumed,
    requestsPerHour: Math.round(requestsPerHour * 10) / 10,
    projectedPerDay, projectedPer30Days, allowance,
    projectedPctOfAllowance: allowance > 0 ? Math.round((projectedPer30Days / allowance) * 1000) / 10 : 0,
    withinAllowance: allowance > 0 ? projectedPer30Days <= allowance : false,
  }
}

// ── Storage (tenant-scoped through the chokepoint) ───────────────────────────

export async function saveReading(r: OpsReading): Promise<void> {
  await redis.set(KEY_BASELINE + r.id, JSON.stringify(r))
  await redis.zadd(KEY_BASELINE_INDEX, r.capturedAt, r.id)
}

export async function getReading(id: string): Promise<OpsReading | null> {
  if (!READING_ID_RE.test(id)) return null
  return safeParse<OpsReading>(await redis.get(KEY_BASELINE + id))
}

export async function listReadings(limit = 20): Promise<OpsReading[]> {
  const ids = await redis.zrevrange(KEY_BASELINE_INDEX, 0, Math.max(0, Math.min(limit, MAX_LISTED) - 1))
  const out: OpsReading[] = []
  for (const id of ids) {
    const r = safeParse<OpsReading>(await redis.get(KEY_BASELINE + id))
    if (r) out.push(r)
  }
  return out
}

export async function saveGap(g: OpsGap): Promise<void> {
  await redis.set(KEY_GAP + g.id, JSON.stringify(g))
  await redis.zadd(KEY_GAP_INDEX, g.at, g.id)
}

export async function getGap(id: string): Promise<OpsGap | null> {
  if (!GAP_ID_RE.test(id)) return null
  return safeParse<OpsGap>(await redis.get(KEY_GAP + id))
}

export async function listGaps(limit = 50): Promise<OpsGap[]> {
  const ids = await redis.zrevrange(KEY_GAP_INDEX, 0, Math.max(0, Math.min(limit, MAX_LISTED) - 1))
  const out: OpsGap[] = []
  for (const id of ids) {
    const g = safeParse<OpsGap>(await redis.get(KEY_GAP + id))
    if (g) out.push(g)
  }
  return out
}

/** Roll-up for the report surface. Pure over the supplied records. */
export type GapSummary = {
  total: number
  open: number
  resolved: number
  bySeverity: Record<GapSeverity, number>
  openBlockers: number
  surfaces: { surface: string; total: number; open: number }[]
}

export function summariseGaps(gaps: OpsGap[]): GapSummary {
  const bySeverity: Record<GapSeverity, number> = { blocker: 0, degraded: 0, papercut: 0 }
  const bySurface = new Map<string, { total: number; open: number }>()
  let open = 0
  for (const g of gaps) {
    bySeverity[g.severity] = (bySeverity[g.severity] ?? 0) + 1
    const isOpen = !g.resolvedAt
    if (isOpen) open++
    const s = bySurface.get(g.surface) ?? { total: 0, open: 0 }
    s.total++; if (isOpen) s.open++
    bySurface.set(g.surface, s)
  }
  return {
    total: gaps.length, open, resolved: gaps.length - open, bySeverity,
    openBlockers: gaps.filter(g => !g.resolvedAt && g.severity === 'blocker').length,
    surfaces: [...bySurface.entries()].map(([surface, v]) => ({ surface, ...v })).sort((a, b) => b.total - a.total),
  }
}

/** Is the platform releasable on this evidence? An OPEN BLOCKER is disqualifying,
 *  and so is an observation window that has not genuinely completed. */
export type ReadinessVerdict = {
  ready: boolean
  reasons: string[]
}

export function readinessVerdict(summary: GapSummary, windows: WindowStatus[]): ReadinessVerdict {
  const reasons: string[] = []
  if (summary.openBlockers > 0) reasons.push(`open_blockers:${summary.openBlockers}`)
  for (const w of windows) {
    if (!w.complete) reasons.push(`${w.label.replace(/\s+/g, '_')}_observation_incomplete:${w.elapsedHours}h/${w.targetHours}h`)
  }
  return { ready: reasons.length === 0, reasons }
}
