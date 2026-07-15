import { redis } from './redis'
import { DEBRIS_CATEGORIES, type DebrisCategory, type CalibrationBias } from './disposal'

// ── Self-learning pricing loop ───────────────────────────────────────────────
// After every completed job the owner logs what ACTUALLY happened (true truck
// fill, dump trips, disposal, labor, profit). We keep the raw history and a
// running per-category calibration bias — actual ÷ estimated truck fill — so the
// estimator gets more accurate after every job while still protecting margin.
//
// The objective: tighten truck-fill estimation (the single biggest driver of
// disposal trips and labor), so jobs like the underpriced $350 brush load stop
// happening.

export type JobOutcome = {
  id: string
  date: string                 // ISO yyyy-mm-dd
  category: DebrisCategory
  service?: string
  // Estimated (what the quote assumed):
  estFillPct: number           // effective fill %, whole number
  estTrips: number
  estDisposalCents: number
  estLaborCents: number
  estProfitCents: number
  // Actual (what the crew measured on completion):
  actualFillPct: number
  actualTrips: number
  actualDisposalCents: number
  actualLaborCents: number
  actualProfitCents: number
  finalPriceCents: number      // what the customer actually paid
  aiRecommendedCents?: number  // the AI's recommended price at quote time (Booking.aiEstimate)
  overridden?: boolean         // an admin manually overrode the AI number before quoting
  isTest?: boolean             // sandbox outcome — never trains the model or enters history
  notes?: string
}

export type Calibration = CalibrationBias & {
  fillBias: Partial<Record<DebrisCategory, number>>
  samples: Partial<Record<DebrisCategory, number>>
  updatedAt: string
}

// TENANCY (H-KEY-2): this is the pricing model's calibration state. The keys below
// are STATIC (not name-derived) and NOT platform-global, so the isolation chokepoint
// (redis.ts → scopeKey) namespaces them per tenant automatically when TENANCY_ENABLED
// → `t:{tid}:learn:jobs` / `t:{tid}:learn:calibration`. One tenant's completed-job
// outcomes therefore CANNOT train another tenant's estimator once tenancy is on
// (proven in scripts/name-derived-keys.test.ts). While TENANCY_ENABLED=false the
// physical keys are unchanged (global) — byte-identical to today.
//
// ACTIVATION REQUIREMENT: recordJobOutcome/getCalibration must run WITHIN a tenant
// context (runWithTenant) once tenancy is on, or scopeKey fails closed and throws.
// Background/cron paths that fold outcomes into calibration must seed that context.
const OUTCOMES_KEY = 'learn:jobs'
const CALIB_KEY = 'learn:calibration'
const MAX_OUTCOMES = 250
const ALPHA = 0.3            // EWMA weight for the newest sample
const BIAS_MIN = 0.4, BIAS_MAX = 3   // keep a single weird job from blowing up estimates

export async function listOutcomes(limit = 50): Promise<JobOutcome[]> {
  const raw = await redis.get(OUTCOMES_KEY)
  if (!raw) return []
  try {
    const all = JSON.parse(raw) as JobOutcome[]
    return Array.isArray(all) ? all.slice(0, limit) : []
  } catch { return [] }
}

export async function getCalibration(): Promise<Calibration> {
  const raw = await redis.get(CALIB_KEY)
  const empty: Calibration = { fillBias: {}, samples: {}, updatedAt: '' }
  if (!raw) return empty
  try {
    const c = JSON.parse(raw) as Calibration
    return { fillBias: c.fillBias ?? {}, samples: c.samples ?? {}, updatedAt: c.updatedAt ?? '' }
  } catch { return empty }
}

// Record a completed job and fold its actual-vs-estimated fill into the bias.
export async function recordJobOutcome(o: JobOutcome): Promise<Calibration> {
  // Sandbox outcomes never train the pricing model or enter the accuracy history —
  // AI safety: test data must not influence calibration or pricing metrics.
  if (o.isTest) return getCalibration()
  // Prepend to the capped history.
  const history = await listOutcomes(MAX_OUTCOMES)
  history.unshift(o)
  await redis.set(OUTCOMES_KEY, JSON.stringify(history.slice(0, MAX_OUTCOMES)))

  // Update the per-category fill bias via EWMA of (actual ÷ estimated).
  const calib = await getCalibration()
  if (o.estFillPct > 0 && o.actualFillPct > 0 && (DEBRIS_CATEGORIES as string[]).includes(o.category)) {
    const ratio = o.actualFillPct / o.estFillPct
    const prev = calib.fillBias[o.category]
    const next = prev == null ? ratio : prev * (1 - ALPHA) + ratio * ALPHA
    calib.fillBias[o.category] = Math.min(BIAS_MAX, Math.max(BIAS_MIN, Number(next.toFixed(3))))
    calib.samples[o.category] = (calib.samples[o.category] ?? 0) + 1
  }
  calib.updatedAt = o.date
  await redis.set(CALIB_KEY, JSON.stringify(calib))
  return calib
}

// Quick accuracy read-out for the admin dashboard.
export function accuracyStats(outcomes: JobOutcome[]) {
  if (!outcomes.length) return null
  const n = outcomes.length
  const absPct = (a: number, b: number) => (b === 0 ? 0 : Math.abs(a - b) / b)
  const avg = (f: (o: JobOutcome) => number) => outcomes.reduce((s, o) => s + f(o), 0) / n
  // AI-estimate-vs-final: |AI recommended − final paid| ÷ final, over jobs that
  // carried an AI recommendation. Null until there is at least one such job.
  const priced = outcomes.filter(o => (o.aiRecommendedCents ?? 0) > 0)
  const priceMape = priced.length
    ? Math.round(priced.reduce((s, o) => s + absPct(o.aiRecommendedCents!, o.finalPriceCents), 0) / priced.length * 100)
    : null
  return {
    jobs: n,
    fillMape: Math.round(avg(o => absPct(o.estFillPct, o.actualFillPct)) * 100),
    tripMape: Math.round(avg(o => absPct(o.estTrips, o.actualTrips)) * 100),
    disposalMape: Math.round(avg(o => absPct(o.estDisposalCents, o.actualDisposalCents)) * 100),
    priceMape,
    avgProfitCents: Math.round(avg(o => o.actualProfitCents)),
    underpriced: outcomes.filter(o => o.actualProfitCents < o.estProfitCents).length,
    overrideRate: Math.round(outcomes.filter(o => o.overridden).length / n * 100),
  }
}
