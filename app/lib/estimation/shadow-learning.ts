// ── Operion AI Learning — PURE analytics over stored evaluations ─────────────
//
// Turns the persisted V2ShadowJob[] into the "why do estimates differ, and is V2 getting
// better" picture. Like the rest of the shadow analytics stack: NO I/O, NO clock (callers pass
// `now`), NO randomness, and — the defining constraint of this whole phase — NO AI inference.
// Every number is derived from data a completed evaluation already stored: the V1/V2
// comparison, the owner's ground truth, the stored estimate, and owner-assigned categories.
//
// Head-to-head accuracy is only meaningful against the owner's confirmed number, so every
// aggregate here is computed over the GROUND-TRUTH-BACKED subset — the same denominator
// discipline as computeShadowAnalytics (groundTruthQuote is the single source of truth).

import type { V2ShadowJob } from './shadow-types'
import { groundTruthQuote } from './shadow-comparison'
import { jobModel, jobDeployment, deploymentLabel } from './shadow-facets'

// ── Owner failure/root-cause categories (multi-select) ───────────────────────
export const LEARNING_CATEGORIES = [
  'underestimated_volume', 'overestimated_volume', 'missed_hidden_debris', 'missed_heavy_material',
  'disposal_cost_issue', 'labor_issue', 'distance_adjustment', 'customer_negotiation',
  'minimum_job_pricing', 'access_difficulty', 'loading_efficiency', 'hazardous_items',
  'appliances', 'furniture', 'yard_debris', 'construction_debris', 'mixed_load', 'other',
] as const
export type LearningCategory = (typeof LEARNING_CATEGORIES)[number]

export const isLearningCategory = (v: unknown): v is LearningCategory =>
  typeof v === 'string' && (LEARNING_CATEGORIES as readonly string[]).includes(v)

export const prettyCategory = (c: string): string => c.replace(/_/g, ' ').replace(/^\w/, (m) => m.toUpperCase())

// ── shared derivations ───────────────────────────────────────────────────────

const round = (n: number, dp = 2) => { const f = 10 ** dp; return Math.round(n * f) / f }
const isEvaluated = (j: V2ShadowJob) => !!j.comparison && (j.status === 'completed' || j.status === 'manual_review')

const mean = (xs: number[]): number | null => (xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length, 2) : null)
function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2, 2)
}

/** One evaluation reduced to its head-to-head error figures against ground truth. `null` when
 *  the evaluation has no usable owner benchmark — such rows are excluded from accuracy math. */
export type EvalError = {
  bookingId: string
  bookingNumber?: string
  at: number
  model: string
  deployment: string
  promptVersion?: number
  estimatorVersion?: number
  groundTruthUsd: number
  groundTruthSource?: string
  v1Usd: number | null
  v2Usd: number
  v1ErrorUsd: number | null
  v2ErrorUsd: number
  v1ErrorPct: number | null
  v2ErrorPct: number
  /** 'v2' | 'v1' | 'tie' — who was closer to reality (tie within TIE_BAND). */
  winner: 'v1' | 'v2' | 'tie'
  improvementPct: number | null   // v1ErrorPct − v2ErrorPct (positive ⇒ V2 better)
  confidence: number | null
  categories: string[]
  notes: string[]
}

const TIE_BAND_USD = 5   // within $5 of each other ⇒ a tie, not a win

export function evalErrorFor(j: V2ShadowJob): EvalError | null {
  const gt = groundTruthQuote(j.groundTruth)
  if (gt === null || !j.comparison) return null
  const c = j.comparison
  const v2Usd = c.shadowRecommendedUsd
  const v1Usd = typeof c.authoritativeRecommendedUsd === 'number' ? c.authoritativeRecommendedUsd : null
  const v2ErrUsd = Math.abs(v2Usd - gt)
  const v1ErrUsd = v1Usd === null ? null : Math.abs(v1Usd - gt)
  const v2ErrPct = round((v2ErrUsd / gt) * 100, 1)
  const v1ErrPct = v1ErrUsd === null ? null : round((v1ErrUsd / gt) * 100, 1)

  let winner: 'v1' | 'v2' | 'tie' = 'tie'
  if (v1ErrUsd !== null) {
    if (Math.abs(v2ErrUsd - v1ErrUsd) <= TIE_BAND_USD) winner = 'tie'
    else winner = v2ErrUsd < v1ErrUsd ? 'v2' : 'v1'
  }

  return {
    bookingId: j.bookingId,
    bookingNumber: j.bookingNumber,
    at: j.completedAt ?? j.updatedAt,
    model: jobModel(j),
    deployment: jobDeployment(j),
    promptVersion: j.promptVersion,
    estimatorVersion: j.estimatorVersion,
    groundTruthUsd: gt,
    groundTruthSource: j.groundTruth?.source,
    v1Usd, v2Usd,
    v1ErrorUsd: v1ErrUsd, v2ErrorUsd: round(v2ErrUsd, 2),
    v1ErrorPct: v1ErrPct, v2ErrorPct: v2ErrPct,
    winner,
    improvementPct: v1ErrPct === null ? null : round(v1ErrPct - v2ErrPct, 1),
    confidence: typeof j.result?.estimate?.confidenceScore === 'number' ? j.result.estimate.confidenceScore : null,
    categories: j.learningCategories ?? [],
    notes: (j.ownerNotes ?? []).map((n) => n.note),
  }
}

/** All ground-truth-backed evaluations, reduced to error rows. The base of every aggregate. */
export function evalErrors(jobs: V2ShadowJob[]): EvalError[] {
  return jobs.filter(isEvaluated).map(evalErrorFor).filter((e): e is EvalError => e !== null)
}

// ── 1. Overall ───────────────────────────────────────────────────────────────

export type LearningOverview = {
  totalEvaluations: number       // completed evaluations (with a comparison)
  groundTruthsRecorded: number   // of those, benchmarked
  groundTruthCoverage: number    // % of completed evaluations with ground truth
  avgV1ErrorPct: number | null
  avgV2ErrorPct: number | null
  avgImprovementPct: number | null
  v2WinPct: number | null
  v1WinPct: number | null
  tiePct: number | null
  avgErrorUsd: number | null     // avg |V2 − ground truth| in dollars
  avgErrorPct: number | null     // = avgV2ErrorPct, named per the dashboard spec
  medianErrorPct: number | null
  confidenceDistribution: { high: number; medium: number; low: number }
}

export function learningOverview(jobs: V2ShadowJob[]): LearningOverview {
  const completed = jobs.filter(isEvaluated)
  const errs = evalErrors(jobs)
  const withV1 = errs.filter((e) => e.v1ErrorPct !== null)
  const conf = { high: 0, medium: 0, low: 0 }
  for (const e of errs) {
    if (e.confidence === null) continue
    if (e.confidence >= 0.7) conf.high++
    else if (e.confidence >= 0.45) conf.medium++
    else conf.low++
  }
  const wins = errs.filter((e) => e.winner === 'v2').length
  const losses = errs.filter((e) => e.winner === 'v1').length
  const ties = errs.filter((e) => e.winner === 'tie').length
  const judged = errs.length
  const pct = (n: number) => (judged > 0 ? round((n / judged) * 100, 1) : null)
  return {
    totalEvaluations: completed.length,
    groundTruthsRecorded: errs.length,
    groundTruthCoverage: completed.length ? round((errs.length / completed.length) * 100, 1) : 0,
    avgV1ErrorPct: mean(withV1.map((e) => e.v1ErrorPct as number)),
    avgV2ErrorPct: mean(errs.map((e) => e.v2ErrorPct)),
    avgImprovementPct: mean(withV1.map((e) => e.improvementPct as number)),
    v2WinPct: pct(wins), v1WinPct: pct(losses), tiePct: pct(ties),
    avgErrorUsd: mean(errs.map((e) => e.v2ErrorUsd)),
    avgErrorPct: mean(errs.map((e) => e.v2ErrorPct)),
    medianErrorPct: median(errs.map((e) => e.v2ErrorPct)),
    confidenceDistribution: conf,
  }
}

// ── 5. Leaderboard (by deployment / prompt / model / estimator) ──────────────

export type LeaderboardRow = {
  key: string
  label: string
  sampleSize: number
  avgErrorPct: number | null
  medianErrorPct: number | null
  avgImprovementPct: number | null
  winRatePct: number | null
  avgConfidence: number | null
}

function leaderboardBy(errs: EvalError[], keyOf: (e: EvalError) => string, labelOf: (e: EvalError) => string): LeaderboardRow[] {
  const groups = new Map<string, EvalError[]>()
  for (const e of errs) {
    const k = keyOf(e)
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(e)
  }
  const rows: LeaderboardRow[] = []
  for (const [key, g] of groups) {
    const withV1 = g.filter((e) => e.v1ErrorPct !== null)
    const wins = g.filter((e) => e.winner === 'v2').length
    rows.push({
      key, label: labelOf(g[0]),
      sampleSize: g.length,
      avgErrorPct: mean(g.map((e) => e.v2ErrorPct)),
      medianErrorPct: median(g.map((e) => e.v2ErrorPct)),
      avgImprovementPct: mean(withV1.map((e) => e.improvementPct as number)),
      winRatePct: g.length ? round((wins / g.length) * 100, 1) : null,
      avgConfidence: mean(g.filter((e) => e.confidence !== null).map((e) => e.confidence as number)),
    })
  }
  // Best (lowest error) first; a tiny sample sorts last so a 1-eval "winner" doesn't top it.
  return rows.sort((a, b) => (a.avgErrorPct ?? 999) - (b.avgErrorPct ?? 999) || b.sampleSize - a.sampleSize)
}

export type Leaderboards = {
  byDeployment: LeaderboardRow[]
  byPromptVersion: LeaderboardRow[]
  byModel: LeaderboardRow[]
  byEstimatorVersion: LeaderboardRow[]
}

export function leaderboards(jobs: V2ShadowJob[]): Leaderboards {
  const errs = evalErrors(jobs)
  const byDeployment = leaderboardBy(errs, (e) => e.deployment, (e) => jobs.find((j) => jobDeployment(j) === e.deployment) ? deploymentLabel(jobs.find((j) => jobDeployment(j) === e.deployment)!) : e.deployment)
  return {
    byDeployment,
    byPromptVersion: leaderboardBy(errs, (e) => String(e.promptVersion ?? 'unknown'), (e) => `Prompt v${e.promptVersion ?? '?'}`),
    byModel: leaderboardBy(errs, (e) => e.model, (e) => e.model.split('/').pop() ?? e.model),
    byEstimatorVersion: leaderboardBy(errs, (e) => String(e.estimatorVersion ?? 'unknown'), (e) => `Estimator v${e.estimatorVersion ?? '?'}`),
  }
}

// ── 6. Category heatmap ──────────────────────────────────────────────────────

export type CategoryStat = {
  category: string
  label: string
  count: number
  avgErrorPct: number | null
  v2WinPct: number | null
  v1WinPct: number | null
  groundTruthCount: number
}

export function categoryHeatmap(jobs: V2ShadowJob[]): CategoryStat[] {
  const errs = evalErrors(jobs)
  const byCat = new Map<string, EvalError[]>()
  for (const e of errs) {
    for (const cat of e.categories) {
      ;(byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push(e)
    }
  }
  const stats: CategoryStat[] = []
  for (const [category, g] of byCat) {
    const wins = g.filter((e) => e.winner === 'v2').length
    const losses = g.filter((e) => e.winner === 'v1').length
    stats.push({
      category, label: prettyCategory(category), count: g.length,
      avgErrorPct: mean(g.map((e) => e.v2ErrorPct)),
      v2WinPct: g.length ? round((wins / g.length) * 100, 1) : null,
      v1WinPct: g.length ? round((losses / g.length) * 100, 1) : null,
      groundTruthCount: g.length,
    })
  }
  // Worst (highest error) first — the problem areas surface at the top.
  return stats.sort((a, b) => (b.avgErrorPct ?? -1) - (a.avgErrorPct ?? -1))
}

// ── 9. Readiness score ───────────────────────────────────────────────────────

export type LearningReadinessTier = 'NOT_READY' | 'PILOT_READY' | 'LIMITED_PRODUCTION' | 'PRODUCTION_READY'

export type LearningReadiness = {
  tier: LearningReadinessTier
  score: number                  // 0..1
  sampleSize: number             // ground-truth-backed evaluations
  groundTruthCoverage: number
  avgImprovementPct: number | null
  avgConfidence: number | null
  failureRatePct: number         // failed / terminal
  retryRatePct: number           // retried attempts / evaluations
  evaluationCoverage: number     // evaluated / total jobs
  reasons: string[]
  blockers: string[]
}

export type LearningReadinessThresholds = {
  pilotSample: number; limitedSample: number; productionSample: number
  minCoverage: number; minImprovement: number; maxFailureRate: number; minConfidence: number
}
export const DEFAULT_LEARNING_READINESS: LearningReadinessThresholds = {
  pilotSample: 20, limitedSample: 75, productionSample: 200,
  minCoverage: 60, minImprovement: 0, maxFailureRate: 10, minConfidence: 0.55,
}

export function learningReadiness(jobs: V2ShadowJob[], t: LearningReadinessThresholds = DEFAULT_LEARNING_READINESS): LearningReadiness {
  const errs = evalErrors(jobs)
  const completed = jobs.filter(isEvaluated)
  const terminal = jobs.filter((j) => j.status === 'completed' || j.status === 'manual_review' || j.status === 'failed')
  const failed = jobs.filter((j) => j.status === 'failed').length
  const retries = jobs.reduce((s, j) => s + Math.max(0, j.attempts - 1), 0)
  const attempted = jobs.filter((j) => j.attempts > 0).length

  const o = learningOverview(jobs)
  const avgConfidence = mean(errs.filter((e) => e.confidence !== null).map((e) => e.confidence as number))
  const failureRate = terminal.length ? round((failed / terminal.length) * 100, 1) : 0
  const retryRate = attempted ? round((retries / attempted) * 100, 1) : 0
  const coverage = jobs.length ? round((completed.length / jobs.length) * 100, 1) : 0

  const reasons: string[] = [], blockers: string[] = []
  const n = errs.length

  // A high failure rate is a hard blocker regardless of accuracy — an estimator that keeps
  // erroring is not production-bound no matter how accurate its successes look.
  if (failureRate > t.maxFailureRate) blockers.push(`Failure rate ${failureRate}% exceeds ${t.maxFailureRate}%.`)
  if ((o.avgImprovementPct ?? -1) < t.minImprovement) blockers.push(`V2 is not yet beating V1 on average (improvement ${o.avgImprovementPct ?? 'n/a'}%).`)

  let tier: LearningReadinessTier = 'NOT_READY'
  if (n < t.pilotSample) {
    reasons.push(`Only ${n}/${t.pilotSample} ground-truth-verified evaluations — not enough to judge.`)
  } else if (blockers.length) {
    reasons.push('Sample is sufficient, but a blocker prevents promotion.')
  } else {
    tier = 'PILOT_READY'
    reasons.push(`${n} verified evaluations; V2 improves on V1 by ${o.avgImprovementPct}% on average.`)
    const confOk = (avgConfidence ?? 0) >= t.minConfidence
    if (n >= t.productionSample && o.groundTruthCoverage >= t.minCoverage && confOk) {
      tier = 'PRODUCTION_READY'
    } else if (n >= t.limitedSample && o.groundTruthCoverage >= t.minCoverage) {
      tier = 'LIMITED_PRODUCTION'
    }
  }
  if (o.groundTruthCoverage < t.minCoverage) reasons.push(`Ground-truth coverage ${o.groundTruthCoverage}% is below the ${t.minCoverage}% target.`)

  // Score blends verified volume, improvement, and coverage — bounded 0..1.
  const volScore = Math.min(1, n / t.productionSample)
  const impScore = Math.max(0, Math.min(1, (o.avgImprovementPct ?? 0) / 20))
  const covScore = Math.min(1, o.groundTruthCoverage / 100)
  const score = blockers.length ? 0 : round(0.5 * volScore + 0.3 * impScore + 0.2 * covScore, 2)

  return {
    tier, score, sampleSize: n, groundTruthCoverage: o.groundTruthCoverage,
    avgImprovementPct: o.avgImprovementPct, avgConfidence,
    failureRatePct: failureRate, retryRatePct: retryRate, evaluationCoverage: coverage,
    reasons, blockers,
  }
}

// ── 10. Deterministic recommendations (NO AI) ────────────────────────────────

export type Recommendation = {
  severity: 'info' | 'watch' | 'action'
  message: string
  evidence: string
}

/**
 * Rule-based observations over the aggregates — every one traceable to a count or an average,
 * never an inferred narrative. Only emits a recommendation when the supporting sample is large
 * enough to mean something (MIN_SAMPLE), so it never over-claims from three data points.
 */
const MIN_REC_SAMPLE = 8

export function learningRecommendations(jobs: V2ShadowJob[]): Recommendation[] {
  const errs = evalErrors(jobs)
  const out: Recommendation[] = []
  if (errs.length < MIN_REC_SAMPLE) {
    return [{ severity: 'info', message: `Only ${errs.length} verified evaluation(s) — record more ground truth before drawing conclusions.`, evidence: `${errs.length} < ${MIN_REC_SAMPLE} minimum sample.` }]
  }

  // Category-level under/over-pricing.
  for (const cat of categoryHeatmap(jobs)) {
    if (cat.count < MIN_REC_SAMPLE) continue
    if ((cat.avgErrorPct ?? 0) >= 20) {
      out.push({ severity: 'action', message: `${cat.label} jobs are the least accurate (avg ${cat.avgErrorPct}% error).`, evidence: `${cat.count} evaluations tagged ${cat.label}; V2 win ${cat.v2WinPct ?? 0}%.` })
    }
  }

  // Confidence vs error: does low confidence actually predict higher error?
  const lowConf = errs.filter((e) => e.confidence !== null && (e.confidence as number) < 0.45)
  const highConf = errs.filter((e) => e.confidence !== null && (e.confidence as number) >= 0.45)
  if (lowConf.length >= MIN_REC_SAMPLE && highConf.length >= MIN_REC_SAMPLE) {
    const lowErr = mean(lowConf.map((e) => e.v2ErrorPct)) ?? 0
    const highErr = mean(highConf.map((e) => e.v2ErrorPct)) ?? 0
    if (lowErr - highErr >= 10) {
      out.push({ severity: 'watch', message: `Confidence below 45% carries ${round(lowErr - highErr, 1)} pts more error.`, evidence: `low-conf avg ${lowErr}% vs high-conf ${highErr}% over ${lowConf.length}+${highConf.length}.` })
    }
  }

  // Prompt/model version regressions.
  const board = leaderboards(jobs).byPromptVersion.filter((r) => r.sampleSize >= MIN_REC_SAMPLE)
  if (board.length >= 2) {
    const best = board[0], worst = board[board.length - 1]
    if ((worst.avgErrorPct ?? 0) - (best.avgErrorPct ?? 0) >= 10) {
      out.push({ severity: 'action', message: `${worst.label} underperforms ${best.label} by ${round((worst.avgErrorPct ?? 0) - (best.avgErrorPct ?? 0), 1)} pts.`, evidence: `${worst.label} avg ${worst.avgErrorPct}% (n=${worst.sampleSize}) vs ${best.label} ${best.avgErrorPct}% (n=${best.sampleSize}).` })
    }
  }

  // Directional bias: does V2 systematically under- or over-shoot?
  const signed = errs.map((e) => round(((e.v2Usd - e.groundTruthUsd) / e.groundTruthUsd) * 100, 1))
  const avgSigned = mean(signed)
  if (avgSigned !== null && Math.abs(avgSigned) >= 8) {
    out.push({ severity: 'watch', message: `V2 systematically ${avgSigned < 0 ? 'UNDER' : 'OVER'}-estimates by ${Math.abs(avgSigned)}% on average.`, evidence: `mean signed error ${avgSigned}% over ${errs.length} evaluations.` })
  }

  if (!out.length) out.push({ severity: 'info', message: 'No systematic problem detected in the current sample.', evidence: `${errs.length} verified evaluations, no category above the 20% error threshold.` })
  return out
}

// ── 2. Trends (weekly / monthly accuracy + rolling improvement) ──────────────

export type TrendBucket = {
  start: number; end: number; label: string
  count: number
  avgV1ErrorPct: number | null
  avgV2ErrorPct: number | null
  avgImprovementPct: number | null
  v2WinPct: number | null
}

const DAY = 86_400_000

/** Bucket ground-truth-backed evaluations into fixed-width periods over a trailing span. */
export function learningTrend(jobs: V2ShadowJob[], now: number, opts: { bucketMs: number; buckets: number; label: (start: number) => string }): TrendBucket[] {
  const errs = evalErrors(jobs)
  const from = now - opts.bucketMs * opts.buckets
  const out: TrendBucket[] = Array.from({ length: opts.buckets }, (_, i) => {
    const start = from + i * opts.bucketMs
    return { start, end: start + opts.bucketMs, label: opts.label(start), count: 0, avgV1ErrorPct: null, avgV2ErrorPct: null, avgImprovementPct: null, v2WinPct: null }
  })
  const acc = out.map(() => ({ v1: [] as number[], v2: [] as number[], imp: [] as number[], wins: 0 }))
  for (const e of errs) {
    if (e.at < from || e.at >= now) continue
    const idx = Math.min(out.length - 1, Math.floor((e.at - from) / opts.bucketMs))
    out[idx].count++
    acc[idx].v2.push(e.v2ErrorPct)
    if (e.v1ErrorPct !== null) acc[idx].v1.push(e.v1ErrorPct)
    if (e.improvementPct !== null) acc[idx].imp.push(e.improvementPct)
    if (e.winner === 'v2') acc[idx].wins++
  }
  return out.map((b, i) => ({
    ...b,
    avgV1ErrorPct: mean(acc[i].v1), avgV2ErrorPct: mean(acc[i].v2), avgImprovementPct: mean(acc[i].imp),
    v2WinPct: b.count ? round((acc[i].wins / b.count) * 100, 1) : null,
  }))
}

const dayLabel = (t: number) => new Date(t).toISOString().slice(5, 10)
const monthLabel = (t: number) => new Date(t).toISOString().slice(0, 7)

export function learningTrends(jobs: V2ShadowJob[], now: number) {
  return {
    weekly: learningTrend(jobs, now, { bucketMs: 7 * DAY, buckets: 8, label: (t) => dayLabel(t) }),
    monthly: learningTrend(jobs, now, { bucketMs: 30 * DAY, buckets: 6, label: monthLabel }),
    // rolling 30-day improvement, sampled weekly — each point is the mean improvement over the
    // 30 days ENDING at that week.
    rolling30d: Array.from({ length: 8 }, (_, i) => {
      const end = now - (7 - i) * 7 * DAY
      const window = evalErrors(jobs).filter((e) => e.at > end - 30 * DAY && e.at <= end && e.improvementPct !== null)
      return { at: end, label: dayLabel(end), count: window.length, avgImprovementPct: mean(window.map((e) => e.improvementPct as number)) }
    }),
  }
}

// ── 4. Accuracy Explorer filter (PURE) ───────────────────────────────────────

export type LearningFilter = {
  from?: number; to?: number
  model?: string
  deployment?: string
  promptVersion?: number
  estimatorVersion?: number
  groundTruthSource?: string
  category?: string
  outcome?: 'v2' | 'v1' | 'tie'
  minConfidence?: number
  maxConfidence?: number
  q?: string                     // free text over booking number, notes, categories
}

export function applyLearningFilter(errs: EvalError[], f: LearningFilter): EvalError[] {
  const q = f.q?.trim().toLowerCase()
  return errs.filter((e) => {
    if (typeof f.from === 'number' && e.at < f.from) return false
    if (typeof f.to === 'number' && e.at >= f.to) return false
    if (f.model && e.model !== f.model) return false
    if (f.deployment && e.deployment !== f.deployment) return false
    if (typeof f.promptVersion === 'number' && e.promptVersion !== f.promptVersion) return false
    if (typeof f.estimatorVersion === 'number' && e.estimatorVersion !== f.estimatorVersion) return false
    if (f.groundTruthSource && e.groundTruthSource !== f.groundTruthSource) return false
    if (f.category && !e.categories.includes(f.category)) return false
    if (f.outcome && e.winner !== f.outcome) return false
    if (typeof f.minConfidence === 'number' && (e.confidence ?? -1) < f.minConfidence) return false
    if (typeof f.maxConfidence === 'number' && (e.confidence ?? 2) > f.maxConfidence) return false
    if (q) {
      const hay = [e.bookingNumber ?? '', e.bookingId, ...e.categories, ...e.notes].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

// ── 11. Export (CSV / JSON) ──────────────────────────────────────────────────

export function evalErrorsToCsv(errs: EvalError[]): string {
  const headers = ['bookingNumber', 'at', 'model', 'promptVersion', 'groundTruthUsd', 'groundTruthSource', 'v1Usd', 'v2Usd', 'v1ErrorPct', 'v2ErrorPct', 'improvementPct', 'winner', 'confidence', 'categories', 'notes']
  const cell = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = errs.map((e) => [
    e.bookingNumber ?? e.bookingId.slice(0, 10), new Date(e.at).toISOString(), e.model, e.promptVersion ?? '',
    e.groundTruthUsd, e.groundTruthSource ?? '', e.v1Usd ?? '', e.v2Usd, e.v1ErrorPct ?? '', e.v2ErrorPct,
    e.improvementPct ?? '', e.winner, e.confidence ?? '', e.categories.join('; '), e.notes.join(' | '),
  ].map(cell).join(','))
  return [headers.join(','), ...rows].join('\n')
}
