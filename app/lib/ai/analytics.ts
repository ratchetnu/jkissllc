import { listAiCalls, type AiCallRecord, type AiCallOutcome } from './telemetry'
import { listPrompts } from './prompts'
import { costCapUsd, todaysCost } from './budget'
import { centralToday } from '../dates'

// AI Control Center aggregation (LLMOps Phase 2). Reads the raw AI audit log and
// rolls it up into the read-only observability the dashboard renders: volume,
// success/error mix, latency, token + estimated-cost totals, feedback quality, and
// a per-feature / per-prompt-version breakdown (the substrate for prompt diffing and
// light A/B analysis). Pure aggregation — it never writes and never calls a model.

export type OutcomeCounts = Record<AiCallOutcome, number>

export type FeatureStats = {
  feature: string
  calls: number
  ok: number
  errors: number
  successRate: number          // 0..1 over calls that reached the model (excludes forbidden/budget)
  avgLatencyMs: number
  totalTokens: number
  estCostUsd: number
  helpful: number
  notHelpful: number
  versions: PromptVersionStats[]
}

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
  helpful: number
  notHelpful: number
}

export type AiAnalytics = {
  generatedAt: number
  window: { count: number; sampledFrom: number }   // records aggregated / total scanned
  totals: {
    calls: number
    ok: number
    errors: number
    successRate: number
    avgLatencyMs: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    estCostUsd: number
    helpful: number
    notHelpful: number
    feedbackRate: number
  }
  outcomes: OutcomeCounts
  today: { estCostUsd: number; capUsd: number; overBudget: boolean }
  features: FeatureStats[]
  recent: RecentCall[]
  registeredPrompts: Array<{ id: string; version: number; description: string }>
}

export type RecentCall = {
  id: string
  at: number
  feature: string
  taskId: string
  promptVersion: number
  model: string
  role: string
  actor: string
  outcome: AiCallOutcome
  ok: boolean
  latencyMs: number
  totalTokens: number
  estCostUsd: number
  feedback?: 'helpful' | 'not_helpful'
}

const ZERO_OUTCOMES = (): OutcomeCounts => ({
  success: 0, invalid_response: 0, provider_error: 0, forbidden: 0, budget_exceeded: 0,
})

// A call "reached the model" (i.e. is eligible for a success-rate denominator) when
// it was not blocked before the call — RBAC denials and budget refusals don't count
// against quality. success = ok; everything else that reached the model is an error.
function reachedModel(o: AiCallOutcome): boolean {
  return o !== 'forbidden' && o !== 'budget_exceeded'
}

function rate(ok: number, denom: number): number {
  return denom > 0 ? Math.round((ok / denom) * 1000) / 1000 : 0
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

  const totals = { calls: 0, ok: 0, errors: 0, latency: 0, latencyN: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0, helpful: 0, notHelpful: 0 }
  const outcomes = ZERO_OUTCOMES()

  // feature → { agg, versions: Map<version, agg> }
  const featMap = new Map<string, { s: MutableAgg; versions: Map<number, MutableAgg & { taskId: string }> }>()

  for (const r of records) {
    totals.calls++
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1
    const reached = reachedModel(r.outcome)
    if (r.ok) totals.ok++
    else if (reached) totals.errors++
    if (r.latencyMs > 0) { totals.latency += r.latencyMs; totals.latencyN++ }
    totals.totalTokens += r.totalTokens
    totals.inputTokens += r.inputTokens
    totals.outputTokens += r.outputTokens
    totals.estCostUsd += r.estCostUsd
    if (r.feedback === 'helpful') totals.helpful++
    else if (r.feedback === 'not_helpful') totals.notHelpful++

    let f = featMap.get(r.feature)
    if (!f) { f = { s: newAgg(), versions: new Map() }; featMap.set(r.feature, f) }
    accumulate(f.s, r, reached)
    let v = f.versions.get(r.promptVersion)
    if (!v) { v = { ...newAgg(), taskId: r.taskId }; f.versions.set(r.promptVersion, v) }
    accumulate(v, r, reached)
  }

  const features: FeatureStats[] = [...featMap.entries()]
    .map(([feature, { s, versions }]) => ({
      feature,
      calls: s.calls,
      ok: s.ok,
      errors: s.errors,
      successRate: rate(s.ok, s.reached),
      avgLatencyMs: s.latencyN ? Math.round(s.latency / s.latencyN) : 0,
      totalTokens: s.totalTokens,
      estCostUsd: round6(s.estCostUsd),
      helpful: s.helpful,
      notHelpful: s.notHelpful,
      versions: [...versions.entries()]
        .map(([promptVersion, v]) => ({
          taskId: v.taskId,
          promptVersion,
          calls: v.calls,
          ok: v.ok,
          errors: v.errors,
          successRate: rate(v.ok, v.reached),
          avgLatencyMs: v.latencyN ? Math.round(v.latency / v.latencyN) : 0,
          avgOutputTokens: v.calls ? Math.round(v.outputTokens / v.calls) : 0,
          estCostUsd: round6(v.estCostUsd),
          helpful: v.helpful,
          notHelpful: v.notHelpful,
        }))
        .sort((a, b) => b.promptVersion - a.promptVersion),
    }))
    .sort((a, b) => b.calls - a.calls)

  const recent: RecentCall[] = records.slice(0, 50).map(r => ({
    id: r.id, at: r.at, feature: r.feature, taskId: r.taskId, promptVersion: r.promptVersion,
    model: r.model, role: r.role, actor: r.actor, outcome: r.outcome, ok: r.ok,
    latencyMs: r.latencyMs, totalTokens: r.totalTokens, estCostUsd: r.estCostUsd, feedback: r.feedback,
  }))

  const reachedTotal = totals.calls - outcomes.forbidden - outcomes.budget_exceeded
  const feedbackTotal = totals.helpful + totals.notHelpful
  const capUsd = cap()
  const todayUsd = await todayCost().catch(() => 0)

  return {
    generatedAt: now(),
    window: { count: records.length, sampledFrom: records.length },
    totals: {
      calls: totals.calls,
      ok: totals.ok,
      errors: totals.errors,
      successRate: rate(totals.ok, reachedTotal),
      avgLatencyMs: totals.latencyN ? Math.round(totals.latency / totals.latencyN) : 0,
      totalTokens: totals.totalTokens,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      estCostUsd: round6(totals.estCostUsd),
      helpful: totals.helpful,
      notHelpful: totals.notHelpful,
      feedbackRate: rate(totals.helpful, feedbackTotal),
    },
    outcomes,
    today: { estCostUsd: round6(todayUsd), capUsd, overBudget: capUsd > 0 && todayUsd >= capUsd },
    features,
    recent,
    registeredPrompts: listPrompts(),
  }
}

// ── internal mutable accumulators ────────────────────────────────────────────
type MutableAgg = {
  calls: number; ok: number; errors: number; reached: number
  latency: number; latencyN: number
  totalTokens: number; outputTokens: number; estCostUsd: number
  helpful: number; notHelpful: number
}
function newAgg(): MutableAgg {
  return { calls: 0, ok: 0, errors: 0, reached: 0, latency: 0, latencyN: 0, totalTokens: 0, outputTokens: 0, estCostUsd: 0, helpful: 0, notHelpful: 0 }
}
function accumulate(a: MutableAgg, r: AiCallRecord, reached: boolean): void {
  a.calls++
  if (reached) a.reached++
  if (r.ok) a.ok++
  else if (reached) a.errors++
  if (r.latencyMs > 0) { a.latency += r.latencyMs; a.latencyN++ }
  a.totalTokens += r.totalTokens
  a.outputTokens += r.outputTokens
  a.estCostUsd += r.estCostUsd
  if (r.feedback === 'helpful') a.helpful++
  else if (r.feedback === 'not_helpful') a.notHelpful++
}
function round6(n: number): number { return Math.round(n * 1_000_000) / 1_000_000 }

// Exposed so the daily-cost card can label the window consistently with the counter.
export function todayLabel(): string { return centralToday() }
