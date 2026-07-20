import { redis } from '../redis'
import { STAGE_KEYS, type StageKey } from './progress-stages'

// ─────────────────────────────────────────────────────────────────────────────
// Progress-UX instrumentation. One compact per-UTC-day Redis HASH (`pmx:{day}`)
// of integer counters/sums, mirroring the cheap-counter style of analytics-events.
// The browser sends ONE beacon at the terminal (success/review/error) or on
// abandonment; the server folds it into the hash. No PII, no free text.
//
// The four required measures, all derivable from the stored fields:
//   • time spent in each displayed stage  → stage_{key}_sum_ms / stage_{key}_n
//   • abandonment rate                     → outcome_abandoned / reports
//   • average customer-visible wait        → wait_sum_ms / wait_n
//   • perceived vs actual completion       → gap_sum_ms / gap_n  (perceived − actual,
//                                            ≥0; the extra ms shown after the backend
//                                            was already done)
// ─────────────────────────────────────────────────────────────────────────────

export type ProgressOutcome = 'success' | 'review' | 'error' | 'abandoned'

export type ProgressMetricPayload = {
  outcome: ProgressOutcome
  waitMs?: number            // customer-visible wait: start → terminal (or → leave)
  perceivedGapMs?: number    // perceivedCompleteAt − apiRespondedAt (success only, ≥0)
  stageMs?: Partial<Record<StageKey, number>>  // ms the customer saw each stage
}

const RETENTION_MS = 200 * 24 * 60 * 60 * 1000
const dayKey = (iso: string) => `pmx:${iso.slice(0, 10)}`
const MAX_MS = 600_000 // clamp any single duration to 10 min (guards a bad client clock)

const clampMs = (v: unknown): number | null => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(MAX_MS, Math.round(n))
}

const OUTCOMES: ProgressOutcome[] = ['success', 'review', 'error', 'abandoned']

/** Validate/normalize an untrusted client payload → a safe metric, or null. Pure. */
export function sanitizeMetric(body: unknown): ProgressMetricPayload | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (!OUTCOMES.includes(b.outcome as ProgressOutcome)) return null
  const out: ProgressMetricPayload = { outcome: b.outcome as ProgressOutcome }
  const wait = clampMs(b.waitMs); if (wait != null) out.waitMs = wait
  const gap = clampMs(b.perceivedGapMs); if (gap != null) out.perceivedGapMs = gap
  if (b.stageMs && typeof b.stageMs === 'object') {
    const src = b.stageMs as Record<string, unknown>
    const stageMs: Partial<Record<StageKey, number>> = {}
    for (const k of STAGE_KEYS) { const v = clampMs(src[k]); if (v != null) stageMs[k] = v }
    if (Object.keys(stageMs).length) out.stageMs = stageMs
  }
  return out
}

/** The (field, increment) pairs a metric contributes to the day hash. Pure so the
 *  aggregation is unit-tested without Redis. `reports` is always +1 (the total). */
export function metricFields(p: ProgressMetricPayload): [string, number][] {
  const fields: [string, number][] = [['reports', 1], [`outcome_${p.outcome}`, 1]]
  if (p.waitMs != null) { fields.push(['wait_sum_ms', p.waitMs], ['wait_n', 1]) }
  if (p.perceivedGapMs != null) { fields.push(['gap_sum_ms', p.perceivedGapMs], ['gap_n', 1]) }
  if (p.stageMs) for (const [k, v] of Object.entries(p.stageMs)) {
    if (v != null) { fields.push([`stage_${k}_sum_ms`, v], [`stage_${k}_n`, 1]) }
  }
  return fields
}

/** Fold one beacon into the day hash. Fail-soft; never throws into the request. */
export async function recordProgressMetric(p: ProgressMetricPayload, nowIso: string): Promise<void> {
  try {
    const k = dayKey(nowIso)
    const fields = metricFields(p)
    let first = false
    for (const [f, by] of fields) {
      const n = await redis.hincrby(k, f, by)
      if (f === 'reports' && n === by) first = true // day hash just created
    }
    if (first) await redis.pexpire(k, RETENTION_MS)
  } catch { /* best-effort — instrumentation must never break the flow */ }
}

// ── Read side (dashboard / tests) ────────────────────────────────────────────

export type ProgressSummary = {
  reports: number
  outcomes: Record<ProgressOutcome, number>
  abandonmentRate: number      // abandoned / reports
  avgWaitMs: number            // customer-visible wait
  avgPerceivedGapMs: number    // perceived − actual completion
  avgStageMs: Partial<Record<StageKey, number>>
}

const num = (h: Record<string, number>, f: string): number => (Number.isFinite(h[f]) ? h[f] : 0)
const avg = (sum: number, n: number): number => (n > 0 ? Math.round(sum / n) : 0)

/** Summarize a decoded day hash (field→int) into the reportable measures. Pure. */
export function summarizeProgressMetrics(h: Record<string, number>): ProgressSummary {
  const reports = num(h, 'reports')
  const outcomes = {
    success: num(h, 'outcome_success'),
    review: num(h, 'outcome_review'),
    error: num(h, 'outcome_error'),
    abandoned: num(h, 'outcome_abandoned'),
  }
  const avgStageMs: Partial<Record<StageKey, number>> = {}
  for (const k of STAGE_KEYS) {
    const n = num(h, `stage_${k}_n`)
    if (n > 0) avgStageMs[k] = avg(num(h, `stage_${k}_sum_ms`), n)
  }
  return {
    reports,
    outcomes,
    abandonmentRate: reports > 0 ? outcomes.abandoned / reports : 0,
    avgWaitMs: avg(num(h, 'wait_sum_ms'), num(h, 'wait_n')),
    avgPerceivedGapMs: avg(num(h, 'gap_sum_ms'), num(h, 'gap_n')),
    avgStageMs,
  }
}

/** Decode Upstash HGETALL's flat [field, value, field, value, …] into a number map. */
export function decodeHash(flat: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const n = parseInt(flat[i + 1], 10)
    if (Number.isFinite(n)) out[flat[i]] = n
  }
  return out
}

/** Roll up the last N days (default today only). Fail-soft → zeros. */
export async function getProgressMetrics(days = 1, nowMs = Date.now()): Promise<ProgressSummary> {
  const merged: Record<string, number> = {}
  for (let i = 0; i < days; i++) {
    const iso = new Date(nowMs - i * 86_400_000).toISOString()
    try {
      const flat = await redis.hgetall(dayKey(iso))
      const h = decodeHash(flat)
      for (const [f, v] of Object.entries(h)) merged[f] = (merged[f] ?? 0) + v
    } catch { /* skip a bad day */ }
  }
  return summarizeProgressMetrics(merged)
}
