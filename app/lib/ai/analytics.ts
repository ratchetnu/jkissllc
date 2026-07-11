import { listAiCalls, type AiCallRecord, type AiCallOutcome } from './telemetry'
import { listPrompts } from './prompts'
import { costCapUsd, todaysCost, costSeries, type DailyCost } from './budget'
import { centralToday } from '../dates'

// AI Control Center aggregation (LLMOps Phase 2→3). Reads the raw AI audit log and
// rolls it up into the read-only observability the dashboard renders: volume,
// success/error mix, latency (avg + p50/p95/p99), token + cost totals (with
// estimated-vs-actual split), quality scores, per-model metrics, retries/error
// classes, and a per-feature / per-prompt-version breakdown (the substrate for prompt
// diffing and A/B). Pure aggregation — it never writes and never calls a model.

export type OutcomeCounts = Record<AiCallOutcome, number>

export type LatencyStats = { avg: number; p50: number; p95: number; p99: number }

export type PromptVersionStats = {
  taskId: string
  promptVersion: number
  calls: number
  ok: number
  errors: number
  successRate: number
  avgLatencyMs: number
  avgOutputTokens: number
  estCostUsd: number
  avgQuality: number
  helpful: number
  notHelpful: number
}

export type FeatureStats = {
  feature: string
  calls: number
  ok: number
  errors: number
  successRate: number
  avgLatencyMs: number
  p95LatencyMs: number
  totalTokens: number
  estCostUsd: number
  avgQuality: number
  helpful: number
  notHelpful: number
  versions: PromptVersionStats[]
}

export type ModelStats = {
  model: string
  calls: number
  ok: number
  errors: number
  successRate: number
  avgLatencyMs: number
  p95LatencyMs: number
  totalTokens: number
  estCostUsd: number
  actualCostUsd: number
  costSource: 'estimated' | 'actual' | 'mixed'
}

export type RecentCall = {
  id: string
  at: number
  feature: string
  taskId: string
  promptVersion: number
  promptVariant?: string
  model: string
  role: string
  actor: string
  outcome: AiCallOutcome
  ok: boolean
  latencyMs: number
  totalTokens: number
  estCostUsd: number
  costSource?: string
  qualityScore?: number
  attempts?: number
  feedback?: 'helpful' | 'not_helpful'
}

export type AiAnalytics = {
  generatedAt: number
  window: { count: number; sampledFrom: number }
  totals: {
    calls: number
    ok: number
    errors: number
    successRate: number
    avgLatencyMs: number
    latency: LatencyStats
    totalTokens: number
    inputTokens: number
    outputTokens: number
    estCostUsd: number
    actualCostUsd: number
    avgQuality: number
    lowQuality: number          // responses scoring < 60
    retries: number
    helpful: number
    notHelpful: number
    feedbackRate: number
  }
  outcomes: OutcomeCounts
  errorClasses: Record<string, number>
  qualityFlags: Record<string, number>
  today: { estCostUsd: number; capUsd: number; overBudget: boolean }
  features: FeatureStats[]
  models: ModelStats[]
  recent: RecentCall[]
  registeredPrompts: Array<{ id: string; version: number; description: string }>
}

const ZERO_OUTCOMES = (): OutcomeCounts => ({
  success: 0, invalid_response: 0, provider_error: 0, forbidden: 0, budget_exceeded: 0,
})

function reachedModel(o: AiCallOutcome): boolean {
  return o !== 'forbidden' && o !== 'budget_exceeded'
}
function rate(ok: number, denom: number): number {
  return denom > 0 ? Math.round((ok / denom) * 1000) / 1000 : 0
}
function round6(n: number): number { return Math.round(n * 1_000_000) / 1_000_000 }
function round2(n: number): number { return Math.round(n * 100) / 100 }

// Percentile over a numeric array (nearest-rank). Empty → 0.
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}
function latencyStats(values: number[]): LatencyStats {
  if (!values.length) return { avg: 0, p50: 0, p95: 0, p99: 0 }
  const s = [...values].sort((a, b) => a - b)
  const avg = Math.round(s.reduce((a, b) => a + b, 0) / s.length)
  return { avg, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99) }
}

export type AnalyticsDeps = {
  list?: (limit: number) => Promise<AiCallRecord[]>
  today?: () => Promise<number>
  cap?: () => number
  now?: () => number
}

export async function computeAiAnalytics(limit = 2000, deps: AnalyticsDeps = {}): Promise<AiAnalytics> {
  const list = deps.list ?? listAiCalls
  const todayCost = deps.today ?? (() => todaysCost())
  const cap = deps.cap ?? costCapUsd
  const now = deps.now ?? Date.now

  const records = await list(limit)

  const t = { calls: 0, ok: 0, errors: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0, actualCostUsd: 0, qualitySum: 0, qualityN: 0, lowQuality: 0, retries: 0, helpful: 0, notHelpful: 0 }
  const outcomes = ZERO_OUTCOMES()
  const errorClasses: Record<string, number> = {}
  const qualityFlags: Record<string, number> = {}
  const allLatencies: number[] = []

  const featMap = new Map<string, { s: MutableAgg; versions: Map<number, MutableAgg & { taskId: string }> }>()
  const modelMap = new Map<string, MutableAgg & { actualCost: number; hasActual: boolean; hasEstimated: boolean }>()

  for (const r of records) {
    t.calls++
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1
    const reached = reachedModel(r.outcome)
    if (r.ok) t.ok++
    else if (reached) t.errors++
    if (r.latencyMs > 0) allLatencies.push(r.latencyMs)
    t.totalTokens += r.totalTokens
    t.inputTokens += r.inputTokens
    t.outputTokens += r.outputTokens
    t.estCostUsd += r.estCostUsd
    t.actualCostUsd += r.actualCostUsd ?? 0
    if (typeof r.qualityScore === 'number' && r.ok) { t.qualitySum += r.qualityScore; t.qualityN++; if (r.qualityScore < 60) t.lowQuality++ }
    if (r.retried) t.retries++
    if (r.feedback === 'helpful') t.helpful++
    else if (r.feedback === 'not_helpful') t.notHelpful++
    if (r.errorClass) errorClasses[r.errorClass] = (errorClasses[r.errorClass] ?? 0) + 1
    for (const f of r.qualityFlags ?? []) qualityFlags[f] = (qualityFlags[f] ?? 0) + 1

    let f = featMap.get(r.feature)
    if (!f) { f = { s: newAgg(), versions: new Map() }; featMap.set(r.feature, f) }
    accumulate(f.s, r, reached)
    let v = f.versions.get(r.promptVersion)
    if (!v) { v = { ...newAgg(), taskId: r.taskId }; f.versions.set(r.promptVersion, v) }
    accumulate(v, r, reached)

    if (reached && r.model) {
      let m = modelMap.get(r.model)
      if (!m) { m = { ...newAgg(), actualCost: 0, hasActual: false, hasEstimated: false }; modelMap.set(r.model, m) }
      accumulate(m, r, reached)
      m.actualCost += r.actualCostUsd ?? 0
      if (r.costSource === 'actual') m.hasActual = true; else if (r.costSource === 'estimated' || !r.costSource) m.hasEstimated = true
    }
  }

  const features: FeatureStats[] = [...featMap.entries()]
    .map(([feature, { s, versions }]) => ({
      feature,
      calls: s.calls, ok: s.ok, errors: s.errors,
      successRate: rate(s.ok, s.reached),
      avgLatencyMs: s.latencyN ? Math.round(s.latency / s.latencyN) : 0,
      p95LatencyMs: percentile([...s.latencies].sort((a, b) => a - b), 95),
      totalTokens: s.totalTokens,
      estCostUsd: round6(s.estCostUsd),
      avgQuality: s.qualityN ? Math.round(s.qualitySum / s.qualityN) : 0,
      helpful: s.helpful, notHelpful: s.notHelpful,
      versions: [...versions.entries()]
        .map(([promptVersion, v]) => ({
          taskId: v.taskId, promptVersion,
          calls: v.calls, ok: v.ok, errors: v.errors,
          successRate: rate(v.ok, v.reached),
          avgLatencyMs: v.latencyN ? Math.round(v.latency / v.latencyN) : 0,
          avgOutputTokens: v.calls ? Math.round(v.outputTokens / v.calls) : 0,
          estCostUsd: round6(v.estCostUsd),
          avgQuality: v.qualityN ? Math.round(v.qualitySum / v.qualityN) : 0,
          helpful: v.helpful, notHelpful: v.notHelpful,
        }))
        .sort((a, b) => b.promptVersion - a.promptVersion),
    }))
    .sort((a, b) => b.calls - a.calls)

  const models: ModelStats[] = [...modelMap.entries()]
    .map(([model, m]) => ({
      model,
      calls: m.calls, ok: m.ok, errors: m.errors,
      successRate: rate(m.ok, m.reached),
      avgLatencyMs: m.latencyN ? Math.round(m.latency / m.latencyN) : 0,
      p95LatencyMs: percentile([...m.latencies].sort((a, b) => a - b), 95),
      totalTokens: m.totalTokens,
      estCostUsd: round6(m.estCostUsd),
      actualCostUsd: round6(m.actualCost),
      costSource: (m.hasActual && m.hasEstimated ? 'mixed' : m.hasActual ? 'actual' : 'estimated') as ModelStats['costSource'],
    }))
    .sort((a, b) => b.calls - a.calls)

  const recent: RecentCall[] = records.slice(0, 50).map(r => ({
    id: r.id, at: r.at, feature: r.feature, taskId: r.taskId, promptVersion: r.promptVersion, promptVariant: r.promptVariant,
    model: r.model, role: r.role, actor: r.actor, outcome: r.outcome, ok: r.ok,
    latencyMs: r.latencyMs, totalTokens: r.totalTokens, estCostUsd: r.estCostUsd, costSource: r.costSource,
    qualityScore: r.qualityScore, attempts: r.attempts, feedback: r.feedback,
  }))

  const reachedTotal = t.calls - outcomes.forbidden - outcomes.budget_exceeded
  const feedbackTotal = t.helpful + t.notHelpful
  const capUsd = cap()
  const todayUsd = await todayCost().catch(() => 0)

  return {
    generatedAt: now(),
    window: { count: records.length, sampledFrom: records.length },
    totals: {
      calls: t.calls, ok: t.ok, errors: t.errors,
      successRate: rate(t.ok, reachedTotal),
      avgLatencyMs: allLatencies.length ? Math.round(allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length) : 0,
      latency: latencyStats(allLatencies),
      totalTokens: t.totalTokens, inputTokens: t.inputTokens, outputTokens: t.outputTokens,
      estCostUsd: round6(t.estCostUsd), actualCostUsd: round6(t.actualCostUsd),
      avgQuality: t.qualityN ? Math.round(t.qualitySum / t.qualityN) : 0,
      lowQuality: t.lowQuality, retries: t.retries,
      helpful: t.helpful, notHelpful: t.notHelpful,
      feedbackRate: rate(t.helpful, feedbackTotal),
    },
    outcomes,
    errorClasses,
    qualityFlags,
    today: { estCostUsd: round6(todayUsd), capUsd, overBudget: capUsd > 0 && todayUsd >= capUsd },
    features,
    models,
    recent,
    registeredPrompts: listPrompts(),
  }
}

// ── internal mutable accumulators ────────────────────────────────────────────
type MutableAgg = {
  calls: number; ok: number; errors: number; reached: number
  latency: number; latencyN: number; latencies: number[]
  totalTokens: number; outputTokens: number; estCostUsd: number
  qualitySum: number; qualityN: number
  helpful: number; notHelpful: number
}
function newAgg(): MutableAgg {
  return { calls: 0, ok: 0, errors: 0, reached: 0, latency: 0, latencyN: 0, latencies: [], totalTokens: 0, outputTokens: 0, estCostUsd: 0, qualitySum: 0, qualityN: 0, helpful: 0, notHelpful: 0 }
}
function accumulate(a: MutableAgg, r: AiCallRecord, reached: boolean): void {
  a.calls++
  if (reached) a.reached++
  if (r.ok) a.ok++
  else if (reached) a.errors++
  if (r.latencyMs > 0) { a.latency += r.latencyMs; a.latencyN++; a.latencies.push(r.latencyMs) }
  a.totalTokens += r.totalTokens
  a.outputTokens += r.outputTokens
  a.estCostUsd += r.estCostUsd
  if (typeof r.qualityScore === 'number' && r.ok) { a.qualitySum += r.qualityScore; a.qualityN++ }
  if (r.feedback === 'helpful') a.helpful++
  else if (r.feedback === 'not_helpful') a.notHelpful++
}

// ── Cost forecast + optimization (Phase 3) ───────────────────────────────────
export type CostForecast = {
  series: DailyCost[]
  mtdUsd: number            // month-to-date estimated spend
  avgDailyUsd: number       // mean of the last up-to-7 active days
  projectedMonthUsd: number // mtd + avgDaily × remaining days in month
  capUsd: number
  capRisk: boolean          // projected monthly implies the daily cap will bind
  trendPct: number          // last-7 vs prior-7 daily average, percent change
}

export function computeCostForecast(series: DailyCost[], today: string, capUsd: number): CostForecast {
  const [y, m, d] = today.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const remaining = Math.max(0, daysInMonth - d)
  const monthPrefix = `${y}-${String(m).padStart(2, '0')}`
  const mtdUsd = round6(series.filter(s => s.day.startsWith(monthPrefix)).reduce((a, b) => a + b.usd, 0))

  const last7 = series.slice(-7)
  const active = last7.filter(s => s.usd > 0)
  const avgDailyUsd = active.length ? round6(active.reduce((a, b) => a + b.usd, 0) / active.length) : 0
  const projectedMonthUsd = round6(mtdUsd + avgDailyUsd * remaining)

  const prior7 = series.slice(-14, -7)
  const meanOf = (arr: DailyCost[]) => (arr.length ? arr.reduce((a, b) => a + b.usd, 0) / arr.length : 0)
  const cur = meanOf(last7), prev = meanOf(prior7)
  const trendPct = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : (cur > 0 ? 100 : 0)

  return {
    series, mtdUsd, avgDailyUsd, projectedMonthUsd, capUsd,
    capRisk: capUsd > 0 && avgDailyUsd >= capUsd * 0.8,
    trendPct,
  }
}

export type OptimizationHint = { feature: string; kind: string; detail: string; estMonthlyUsd: number }

// Simple, explainable optimization hints from the feature breakdown: the priciest
// features, and any feature whose model has a cheaper capable tier.
export function optimizationHints(features: FeatureStats[], monthlyMultiplier = 30): OptimizationHint[] {
  const hints: OptimizationHint[] = []
  const byCost = [...features].sort((a, b) => b.estCostUsd - a.estCostUsd)
  for (const f of byCost.slice(0, 3)) {
    if (f.estCostUsd <= 0) continue
    hints.push({ feature: f.feature, kind: 'cost_driver', detail: `Top cost driver: ${f.calls} calls in-window. Consider a cheaper model tier or shorter max output.`, estMonthlyUsd: round2(f.estCostUsd * monthlyMultiplier) })
  }
  for (const f of features) {
    if (f.avgQuality >= 85 && f.estCostUsd > 0 && f.p95LatencyMs > 4000) {
      hints.push({ feature: f.feature, kind: 'latency', detail: `High quality but p95 latency ${f.p95LatencyMs}ms — a faster model may keep quality while cutting latency.`, estMonthlyUsd: 0 })
    }
  }
  return hints
}

// ── A/B statistical comparison (Phase 3) ──────────────────────────────────────
export type AbArm = {
  variant: string
  calls: number
  ok: number
  successRate: number
  avgQuality: number
  helpful: number
  notHelpful: number
  helpfulRate: number
}
export type AbAnalysis = {
  taskId: string
  control: AbArm
  variant: AbArm
  metric: 'successRate'
  zScore: number
  pValue: number
  significant: boolean        // |z| ≥ 1.96 (95%)
  winner: 'control' | 'variant' | 'inconclusive'
}

// Standard normal CDF via Abramowitz-Stegun erf approximation.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp((-z * z) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

function armOf(variant: string, recs: AiCallRecord[]): AbArm {
  const reached = recs.filter(r => reachedModel(r.outcome))
  const ok = reached.filter(r => r.ok).length
  const q = reached.filter(r => typeof r.qualityScore === 'number' && r.ok)
  const helpful = recs.filter(r => r.feedback === 'helpful').length
  const notHelpful = recs.filter(r => r.feedback === 'not_helpful').length
  return {
    variant, calls: reached.length, ok, successRate: rate(ok, reached.length),
    avgQuality: q.length ? Math.round(q.reduce((a, b) => a + (b.qualityScore ?? 0), 0) / q.length) : 0,
    helpful, notHelpful, helpfulRate: rate(helpful, helpful + notHelpful),
  }
}

// Two-proportion z-test on success rate between the control and variant arms of a
// prompt A/B. Records must already be scoped to the taskId.
export function computeAbAnalysis(taskId: string, records: AiCallRecord[]): AbAnalysis | null {
  const scoped = records.filter(r => r.taskId === taskId && (r.promptVariant === 'control' || r.promptVariant === 'variant'))
  if (!scoped.length) return null
  const control = armOf('control', scoped.filter(r => r.promptVariant === 'control'))
  const variant = armOf('variant', scoped.filter(r => r.promptVariant === 'variant'))
  const n1 = control.calls, n2 = variant.calls
  let zScore = 0, pValue = 1
  if (n1 > 0 && n2 > 0) {
    const p1 = control.ok / n1, p2 = variant.ok / n2
    const pPool = (control.ok + variant.ok) / (n1 + n2)
    const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2))
    zScore = se > 0 ? round2((p2 - p1) / se) : 0
    pValue = round6(2 * (1 - normalCdf(Math.abs(zScore))))
  }
  const significant = Math.abs(zScore) >= 1.96 && n1 >= 20 && n2 >= 20
  const winner: AbAnalysis['winner'] = !significant ? 'inconclusive' : variant.successRate > control.successRate ? 'variant' : 'control'
  return { taskId, control, variant, metric: 'successRate', zScore, pValue, significant, winner }
}

// Convenience: the full cost view for the API (series + forecast + hints).
export async function computeCostView(analytics: AiAnalytics, days = 30, seriesFn: (d: number) => Promise<DailyCost[]> = costSeries, today: string = centralToday()): Promise<{ forecast: CostForecast; hints: OptimizationHint[] }> {
  const series = await seriesFn(days)
  const forecast = computeCostForecast(series, today, analytics.today.capUsd)
  const hints = optimizationHints(analytics.features)
  return { forecast, hints }
}
