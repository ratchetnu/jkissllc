import { listAiCalls, type AiCallRecord } from './telemetry'
import { DEFAULT_ANALYZE_P50_MS } from './progress-stages'

export { DEFAULT_ANALYZE_P50_MS }

// ─────────────────────────────────────────────────────────────────────────────
// Progress calibration — the measured timing source for the Option A progress
// display. We drive the "AI Analyzing Contents" stage from the REAL p50 latency of
// the authoritative Book Now vision call (feature `ops.junkAnalysis`, primary,
// successful), so the animation paces to what customers actually experience rather
// than a hard-coded guess. Fail-soft: too few samples (or any telemetry error) →
// a safe default, so the display never depends on telemetry being present.
//
// This is the ONLY place the timing source lives. Swapping to Option B (server-
// sent progress events) replaces this module's role — the UI is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

export const CALIBRATION_FEATURE = 'ops.junkAnalysis'
export const MIN_SAMPLES = 5
// Clamp so a telemetry anomaly can never yield a 0 (instant, looks broken) or an
// absurd multi-minute pace.
export const MIN_P50_MS = 1500
export const MAX_P50_MS = 20000

export type ProgressCalibration = {
  analyzeP50Ms: number
  sampleSize: number
  source: 'measured' | 'default'
}

/** Median of a numeric list (pure). Empty → 0. */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

export function clampP50(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_ANALYZE_P50_MS
  return Math.min(MAX_P50_MS, Math.max(MIN_P50_MS, Math.round(ms)))
}

/** Compute calibration from telemetry records (pure, testable). Uses only the
 *  authoritative primary vision calls that actually succeeded. */
export function computeCalibration(records: AiCallRecord[]): ProgressCalibration {
  const latencies = records
    .filter((r) => r.feature === CALIBRATION_FEATURE && (r.kind ?? 'primary') === 'primary' && r.ok && r.outcome === 'success')
    .map((r) => r.latencyMs)
    .filter((ms) => Number.isFinite(ms) && ms > 0)

  if (latencies.length < MIN_SAMPLES) {
    return { analyzeP50Ms: DEFAULT_ANALYZE_P50_MS, sampleSize: latencies.length, source: 'default' }
  }
  return { analyzeP50Ms: clampP50(median(latencies)), sampleSize: latencies.length, source: 'measured' }
}

/** Read calibration from the telemetry log. Fail-soft → default. */
export async function getProgressCalibration(limit = 1000): Promise<ProgressCalibration> {
  try {
    const records = await listAiCalls(limit)
    return computeCalibration(records)
  } catch {
    return { analyzeP50Ms: DEFAULT_ANALYZE_P50_MS, sampleSize: 0, source: 'default' }
  }
}
