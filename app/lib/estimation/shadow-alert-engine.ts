// ── Operion Shadow Alerting — PURE evaluator + lifecycle reconciler ──────────
//
// Two pure functions, no I/O, no clock, no randomness (callers pass `now` and an id
// factory) → identical inputs always produce identical alerts, so every rule below is
// unit-testable and safe to retry.
//
//   evaluateShadowAlerts()  jobs + policies + prior readiness → signals (conditions observed)
//   reconcileAlerts()       stored alerts + signals           → open / update / resolve / suppress
//
// THE CARDINAL RULE: this module derives NO metric of its own. Every number it compares
// comes out of the existing engines — computeShadowAnalytics, computeShadowMetrics,
// detectDisagreements, modelScorecards, readinessScore. If a metric needs changing, it
// changes there and this module follows. The only arithmetic here is cost-per-evaluation
// (totalEstCostUsd ÷ evaluated), which is a division of two published numbers rather than
// a re-derivation.
//
// Alerting observes. It promotes no model, enables no shadow traffic, sends no customer
// anything.

import { computeShadowAnalytics, detectDisagreements, modelScorecards, readinessScore } from './shadow-analytics'
import type { ReadinessTier } from './shadow-analytics'
import { computeShadowMetrics } from './shadow-metrics'
import { applyShadowFilter, jobModel, jobDeployment, deploymentLabel } from './shadow-facets'
import { DEFAULT_ALERT_POLICIES } from './shadow-alert-policies'
import { SHADOW_ALERT_VERSION } from './shadow-alert-types'
import type {
  AlertPolicy, AlertSignal, PolicySkip, ReadinessSnapshot, ShadowAlert, SkipReason,
} from './shadow-alert-types'
import type { V2ShadowJob } from './shadow-types'

// ── shared helpers ───────────────────────────────────────────────────────────

const TIER_RANK: Record<ReadinessTier, number> = {
  BLOCKED: 0,
  NEEDS_MORE_DATA: 1,
  READY_FOR_EXPANDED_SHADOW: 2,
  READY_FOR_LIMITED_ROLLOUT: 3,
  READY_FOR_CUSTOMER_ROLLOUT: 4,
}

const TIER_LABEL: Record<ReadinessTier, string> = {
  BLOCKED: 'Blocked',
  NEEDS_MORE_DATA: 'Needs more data',
  READY_FOR_EXPANDED_SHADOW: 'Ready for expanded shadow',
  READY_FOR_LIMITED_ROLLOUT: 'Ready for limited rollout',
  READY_FOR_CUSTOMER_ROLLOUT: 'Ready for customer rollout',
}

const round = (n: number, dp = 2) => { const f = 10 ** dp; return Math.round(n * f) / f }
const jobTime = (j: V2ShadowJob): number => j.completedAt ?? j.updatedAt
const isEvaluated = (j: V2ShadowJob): boolean => !!j.comparison && (j.status === 'completed' || j.status === 'manual_review')

/** Everything one policy needs to know about one window, sourced entirely from the
 *  existing engines. Computed once per window and shared across policies. */
type WindowStats = {
  jobs: V2ShadowJob[]
  analytics: ReturnType<typeof computeShadowAnalytics>
  metrics: ReturnType<typeof computeShadowMetrics>
}

function windowStats(jobs: V2ShadowJob[], from: number, to: number): WindowStats {
  const w = applyShadowFilter(jobs, { from, to })
  return { jobs: w, analytics: computeShadowAnalytics(w), metrics: computeShadowMetrics(w) }
}

/** Terminal jobs — the denominator for a FAILURE rate. Failures never produce a comparison,
 *  so `analytics.evaluated` is the wrong denominator here. */
const terminalCount = (s: WindowStats): number =>
  s.metrics.completed + s.metrics.manualReview + s.metrics.failed
const failureRatePct = (s: WindowStats): number => {
  const n = terminalCount(s)
  return n > 0 ? round((s.metrics.failed / n) * 100, 1) : 0
}
const costPerEvaluation = (s: WindowStats): number | null =>
  s.analytics.evaluated > 0 ? round(s.metrics.totalEstCostUsd / s.analytics.evaluated, 4) : null

const traceIdsFor = (jobs: V2ShadowJob[], bookingIds: string[]): string[] => {
  const want = new Set(bookingIds)
  return jobs.filter((j) => want.has(j.bookingId) && j.traceId).map((j) => j.traceId as string)
}

// ── evaluation ───────────────────────────────────────────────────────────────

export type AlertEvalInput = {
  jobs: V2ShadowJob[]
  now: number
  policies?: readonly AlertPolicy[]
  /** The readiness reading persisted by the previous run. Null on the first-ever run, which
   *  is why a first run can never fire a readiness TRANSITION alert — there is nothing to
   *  transition from, and inventing a baseline would fabricate an event. */
  priorReadiness?: ReadinessSnapshot | null
}

export type AlertEvalResult = {
  signals: AlertSignal[]
  skips: PolicySkip[]
  /** Current readiness over the full job set — persist this for the next run's comparison.
   *  Computed over ALL supplied jobs (not a policy window) so it matches exactly what the
   *  unfiltered Shadow Analytics dashboard shows. */
  readiness: ReadinessSnapshot
}

export function evaluateShadowAlerts(input: AlertEvalInput): AlertEvalResult {
  const { jobs, now } = input
  const policies = input.policies ?? DEFAULT_ALERT_POLICIES
  const signals: AlertSignal[] = []
  const skips: PolicySkip[] = []

  const readiness = snapshotReadiness(jobs, now, 'global')

  const skip = (p: AlertPolicy, scopeKey: string, reason: SkipReason, detail: string) =>
    skips.push({ policyId: p.id, policyType: p.type, scopeKey, reason, detail })

  for (const policy of policies) {
    if (!policy.enabled) { skip(policy, 'global', 'disabled', 'Policy is disabled.'); continue }

    // Owner-configured scope narrows the job set before anything is measured.
    const scoped = applyShadowFilter(jobs, policy.scope)
    if (!scoped.length) { skip(policy, scopeKeyOf(policy, null), 'no_data', 'No shadow jobs in scope.'); continue }

    // model_prompt_regression is inherently cross-deployment (it needs peers to compare
    // against), so it owns its fan-out rather than using the generic partition below.
    if (policy.type === 'model_prompt_regression') {
      evaluateRegression(policy, scoped, now, signals, skip)
      continue
    }

    for (const [partKey, partJobs] of partition(policy, scoped)) {
      evaluatePolicy(policy, partKey, partJobs, jobs, now, readiness, input.priorReadiness ?? null, signals, skip)
    }
  }

  return { signals, skips, readiness }
}

/** Split the scoped jobs by the policy's fan-out dimension. `none` → one 'global' partition. */
function partition(policy: AlertPolicy, jobs: V2ShadowJob[]): Array<[string, V2ShadowJob[]]> {
  if (policy.fanOut === 'none') return [[scopeKeyOf(policy, null), jobs]]
  const key = policy.fanOut === 'model' ? jobModel : jobDeployment
  const groups = new Map<string, V2ShadowJob[]>()
  for (const j of jobs) {
    const k = key(j)
    const g = groups.get(k)
    if (g) g.push(j)
    else groups.set(k, [j])
  }
  return [...groups.entries()]
}

function scopeKeyOf(policy: AlertPolicy, partKey: string | null): string {
  if (partKey) return partKey
  return policy.scope.deployment ?? policy.scope.model ?? policy.scope.business ?? 'global'
}

export function snapshotReadiness(jobs: V2ShadowJob[], now: number, scope: string): ReadinessSnapshot {
  const r = readinessScore(jobs)
  const a = computeShadowAnalytics(jobs)
  const fns = detectDisagreements(jobs).filter((d) => d.kind === 'possible_false_negative').length
  return {
    at: now, scope, tier: r.tier, score: r.score, evaluated: a.evaluated,
    agreementPct: a.agreementPct, falseNegatives: fns, blockers: r.blockers, reasons: r.reasons,
  }
}

type SkipFn = (p: AlertPolicy, scopeKey: string, reason: SkipReason, detail: string) => void

function evaluatePolicy(
  policy: AlertPolicy,
  scopeKey: string,
  jobs: V2ShadowJob[],
  allJobs: V2ShadowJob[],
  now: number,
  readiness: ReadinessSnapshot,
  priorReadiness: ReadinessSnapshot | null,
  out: AlertSignal[],
  skip: SkipFn,
): void {
  const from = now - policy.windowMs
  const cur = windowStats(jobs, from, now)

  const base = {
    policyId: policy.id, policyType: policy.type, severity: policy.severity,
    scopeKey, threshold: policy.threshold, at: now,
    model: policy.scope.model ?? (policy.fanOut === 'model' ? scopeKey : undefined),
    deployment: policy.scope.deployment ?? (policy.fanOut === 'deployment' ? scopeKey : undefined),
    business: policy.scope.business,
  }
  const emit = (o: {
    dedupKey: string; reason: string; observed: number; comparison: number | null
    sampleSize: number; bookingIds?: string[]; readiness?: ReadinessSnapshot | null
  }) => out.push({
    ...base,
    dedupKey: o.dedupKey, reason: o.reason, observed: o.observed, comparison: o.comparison,
    sampleSize: o.sampleSize,
    relatedBookingIds: o.bookingIds ?? [],
    relatedTraceIds: traceIdsFor(allJobs, o.bookingIds ?? []),
    readiness: o.readiness ?? readiness,
  })
  const aggKey = `${policy.id}:${scopeKey}`

  switch (policy.type) {
    // ── per-item safety events ───────────────────────────────────────────────
    case 'critical_false_negative': {
      const fns = detectDisagreements(cur.jobs).filter((d) => d.kind === 'possible_false_negative')
      if (!fns.length) { skip(policy, scopeKey, 'no_data', 'No false negatives in window.'); return }
      for (const d of fns) {
        emit({
          dedupKey: `${policy.id}:${d.bookingId}`,
          reason: `V2 auto-quoted booking ${d.bookingId} where V1 required manual review. ${d.detail}`,
          observed: 1, comparison: null, sampleSize: cur.analytics.evaluated, bookingIds: [d.bookingId],
        })
      }
      return
    }
    case 'high_severity_disagreement': {
      // Excludes false negatives — the critical policy above already owns those, and two
      // alerts for one booking is noise, not emphasis.
      const highs = detectDisagreements(cur.jobs).filter((d) => d.severity === 'high' && d.kind !== 'possible_false_negative')
      if (!highs.length) { skip(policy, scopeKey, 'no_data', 'No high-severity disagreements in window.'); return }
      for (const d of highs) {
        emit({
          dedupKey: `${policy.id}:${d.bookingId}:${d.kind}`,
          reason: `High-severity disagreement on booking ${d.bookingId}: ${d.detail}`,
          observed: Math.abs(d.quoteDeltaUsd ?? 0), comparison: null,
          sampleSize: cur.analytics.evaluated, bookingIds: [d.bookingId],
        })
      }
      return
    }

    // ── absolute-threshold conditions ────────────────────────────────────────
    case 'queue_backlog': {
      // Backlog is a LIVE count over every job, not a windowed one: a job queued 40 days
      // ago is still 40 days of backlog.
      const queued = computeShadowMetrics(jobs).queued
      if (queued <= policy.threshold) { skip(policy, scopeKey, 'not_applicable', `Backlog ${queued} within ceiling ${policy.threshold}.`); return }
      emit({
        dedupKey: aggKey,
        reason: `${queued} shadow jobs are queued (ceiling ${policy.threshold}). The worker drains roughly 6/hour.`,
        observed: queued, comparison: null, sampleSize: jobs.length,
      })
      return
    }
    case 'stale_shadow_telemetry': {
      const evals = jobs.filter(isEvaluated)
      if (!evals.length) { skip(policy, scopeKey, 'no_data', 'No evaluated jobs at all — nothing to be stale.'); return }
      const latest = Math.max(...evals.map(jobTime))
      const age = now - latest
      if (age <= policy.threshold) { skip(policy, scopeKey, 'not_applicable', `Last evaluation ${Math.round(age / 3_600_000)}h ago.`); return }
      emit({
        dedupKey: aggKey,
        reason: `No shadow evaluation has completed in ${Math.round(age / 3_600_000)} hours — the pipeline may be stalled or disabled.`,
        observed: age, comparison: null, sampleSize: evals.length,
      })
      return
    }
    case 'insufficient_sample_volume': {
      const n = cur.analytics.evaluated
      if (n >= policy.threshold) { skip(policy, scopeKey, 'not_applicable', `${n} evaluated meets floor ${policy.threshold}.`); return }
      emit({
        dedupKey: aggKey,
        reason: `Only ${n} evaluated shadow job(s) in the window — ${policy.threshold} are needed before readiness can be judged.`,
        observed: n, comparison: null, sampleSize: n,
      })
      return
    }

    // ── readiness transitions ────────────────────────────────────────────────
    case 'readiness_milestone_reached':
    case 'readiness_milestone_lost': {
      if (!priorReadiness) { skip(policy, scopeKey, 'no_baseline', 'No prior readiness snapshot — first run establishes the baseline.'); return }
      if (readiness.evaluated < policy.minSampleSize) {
        skip(policy, scopeKey, 'insufficient_sample', `${readiness.evaluated} evaluated < ${policy.minSampleSize} required.`)
        return
      }
      const before = TIER_RANK[priorReadiness.tier], after = TIER_RANK[readiness.tier]
      const up = policy.type === 'readiness_milestone_reached'
      if (up ? after <= before : after >= before) { skip(policy, scopeKey, 'not_applicable', `Tier unchanged or moved the other way (${priorReadiness.tier} → ${readiness.tier}).`); return }

      const newBlockers = readiness.blockers.filter((b) => !priorReadiness.blockers.includes(b))
      const clearedBlockers = priorReadiness.blockers.filter((b) => !readiness.blockers.includes(b))
      const why = [
        `${TIER_LABEL[priorReadiness.tier]} → ${TIER_LABEL[readiness.tier]}.`,
        `Agreement ${readiness.agreementPct}% over ${readiness.evaluated} evaluated (was ${priorReadiness.agreementPct}% over ${priorReadiness.evaluated}).`,
        newBlockers.length ? `New blocker(s): ${newBlockers.join(' ')}` : '',
        clearedBlockers.length ? `Blocker(s) cleared: ${clearedBlockers.join(' ')}` : '',
        readiness.blockers.length ? `Remaining blocker(s): ${readiness.blockers.join(' ')}` : 'No remaining blockers.',
        up
          ? 'Recommended action: review the evidence and decide whether to widen shadow traffic. No model is promoted automatically.'
          : 'Recommended action: investigate the regression before any further rollout.',
      ].filter(Boolean).join(' ')

      // The tier move is the identity — re-running the same transition must not re-alert,
      // but a LATER move to the same tier is genuinely new news.
      emit({
        dedupKey: `${policy.id}:${scopeKey}:${priorReadiness.tier}->${readiness.tier}`,
        reason: why, observed: after, comparison: before,
        sampleSize: readiness.evaluated,
      })
      return
    }

    // ── window-over-window comparisons ───────────────────────────────────────
    default: {
      const baselineMs = policy.baselineWindowMs
      if (!baselineMs) { skip(policy, scopeKey, 'not_applicable', 'Comparative policy has no baseline window configured.'); return }
      const baseFrom = from - baselineMs
      const prev = windowStats(jobs, baseFrom, from)

      // Refuse to compare against a baseline the data never reached. Without this, day one of
      // shadow traffic reads as a catastrophic regression from nothing. This guard asks only
      // "is there history older than the current window?" — how MUCH history is enough is the
      // sample floor's job, checked below, so the two rules stay independently explainable.
      const earliest = Math.min(...jobs.map(jobTime))
      if (earliest >= from) {
        skip(policy, scopeKey, 'incomplete_window', 'No job history predates the current window — nothing to compare against.')
        return
      }

      const metric = comparativeMetric(policy, cur, prev)
      if (!metric) { skip(policy, scopeKey, 'not_applicable', `No comparative metric for ${policy.type}.`); return }
      const { observed, comparison, sample, baseSample, label, unit } = metric

      if (observed === null || comparison === null) {
        skip(policy, scopeKey, 'no_data', `${label} unavailable in one of the windows.`)
        return
      }
      if (sample < policy.minSampleSize || baseSample < policy.minSampleSize) {
        skip(policy, scopeKey, 'insufficient_sample',
          `Sample ${sample} (baseline ${baseSample}) below the ${policy.minSampleSize} minimum — too thin to judge.`)
        return
      }
      if (!crosses(policy, observed, comparison)) {
        skip(policy, scopeKey, 'not_applicable', `${label} ${fmt(observed, unit)} vs baseline ${fmt(comparison, unit)} — within threshold.`)
        return
      }

      const movement = policy.comparison === 'ratio_increase'
        ? `${round(observed / comparison, 2)}× the baseline`
        : `${fmt(Math.abs(observed - comparison), unit)} ${observed < comparison ? 'lower' : 'higher'}`
      emit({
        dedupKey: aggKey,
        reason: `${label} is ${fmt(observed, unit)} over the last ${hours(policy.windowMs)}, ${movement} than the prior ${hours(baselineMs)} (${fmt(comparison, unit)}). Based on ${sample} evaluation(s) vs ${baseSample}.`,
        observed, comparison, sampleSize: sample,
        bookingIds: cur.jobs.filter(isEvaluated).slice(0, 20).map((j) => j.bookingId),
      })
    }
  }
}

type Unit = 'pct' | 'score' | 'ms' | 'usd' | 'count'
type ComparativeMetric = {
  observed: number | null; comparison: number | null
  sample: number; baseSample: number; label: string; unit: Unit
}

/** Maps a comparative policy onto the numbers the existing engines already publish. */
function comparativeMetric(policy: AlertPolicy, cur: WindowStats, prev: WindowStats): ComparativeMetric | null {
  const ev = { sample: cur.analytics.evaluated, baseSample: prev.analytics.evaluated }
  switch (policy.type) {
    case 'agreement_rate_drop':
      return { observed: cur.analytics.agreementPct, comparison: prev.analytics.agreementPct, ...ev, label: 'Agreement rate', unit: 'pct' }
    case 'manual_review_spike':
      return { observed: cur.analytics.manualReviewRate, comparison: prev.analytics.manualReviewRate, ...ev, label: 'Manual-review rate', unit: 'pct' }
    case 'auto_quote_rate_drop':
      return { observed: cur.analytics.autoQuoteRate, comparison: prev.analytics.autoQuoteRate, ...ev, label: 'Auto-quote rate', unit: 'pct' }
    case 'confidence_drop':
      return { observed: cur.analytics.avgConfidence, comparison: prev.analytics.avgConfidence, ...ev, label: 'Average confidence', unit: 'score' }
    case 'latency_regression':
      return { observed: cur.metrics.avgRuntimeMs, comparison: prev.metrics.avgRuntimeMs, ...ev, label: 'Average latency', unit: 'ms' }
    case 'cost_per_evaluation_spike':
      return { observed: costPerEvaluation(cur), comparison: costPerEvaluation(prev), ...ev, label: 'Cost per evaluation', unit: 'usd' }
    case 'evaluation_failure_spike':
      // Failure rate is measured over TERMINAL jobs — a failed job never produces a comparison,
      // so it is invisible to `evaluated` and would otherwise never be counted.
      return {
        observed: failureRatePct(cur), comparison: failureRatePct(prev),
        sample: terminalCount(cur), baseSample: terminalCount(prev),
        label: 'Evaluation failure rate', unit: 'pct',
      }
    default:
      return null
  }
}

/** The single place a threshold decision is made. */
export function crosses(policy: AlertPolicy, observed: number, comparison: number | null): boolean {
  switch (policy.comparison) {
    case 'count_at_least':  return observed >= policy.threshold
    case 'above_absolute':  return observed > policy.threshold
    case 'below_absolute':  return observed < policy.threshold
    case 'drop_at_least':   return comparison !== null && comparison - observed >= policy.threshold
    case 'rise_at_least':   return comparison !== null && observed - comparison >= policy.threshold
    // A zero baseline has no meaningful multiple — 0→anything is not a "1.5× regression".
    case 'ratio_increase':  return comparison !== null && comparison > 0 && observed >= comparison * policy.threshold
    case 'tier_upgrade':    return comparison !== null && observed > comparison
    case 'tier_downgrade':  return comparison !== null && observed < comparison
    default:                return false
  }
}

function evaluateRegression(
  policy: AlertPolicy, jobs: V2ShadowJob[], now: number, out: AlertSignal[], skip: SkipFn,
): void {
  const win = applyShadowFilter(jobs, { from: now - policy.windowMs, to: now })
  const cards = modelScorecards(win).filter((c) => c.count >= policy.minSampleSize)
  if (cards.length < 2) {
    skip(policy, 'global', 'insufficient_sample',
      `Need 2+ deployments with ${policy.minSampleSize}+ evaluations to compare; found ${cards.length}.`)
    return
  }
  const best = cards.reduce((a, b) => (b.agreementPct > a.agreementPct ? b : a))
  const labelFor = (model: string, promptVersion?: number, estimatorVersion?: number) =>
    `${model.split('/').pop() ?? model} · p${promptVersion ?? '?'} · est${estimatorVersion ?? '?'}`
  const bestLabel = labelFor(best.model, best.promptVersion, best.estimatorVersion)

  for (const c of cards) {
    const key = `${c.model}|${c.promptVersion ?? ''}|${c.estimatorVersion ?? ''}`
    if (key === `${best.model}|${best.promptVersion ?? ''}|${best.estimatorVersion ?? ''}`) continue
    if (!crosses(policy, c.agreementPct, best.agreementPct)) {
      skip(policy, key, 'not_applicable', `Agreement ${c.agreementPct}% is within ${policy.threshold}pp of the best peer (${best.agreementPct}%).`)
      continue
    }
    const label = labelFor(c.model, c.promptVersion, c.estimatorVersion)
    out.push({
      policyId: policy.id, policyType: policy.type, severity: policy.severity,
      dedupKey: `${policy.id}:${key}`, scopeKey: key,
      reason: `Deployment ${label} agrees with V1 ${c.agreementPct}% of the time over ${c.count} evaluation(s), versus ${best.agreementPct}% for the best peer ${bestLabel} (${best.count} evaluation(s)). Hypothesis: a model or prompt regression — the data shows the gap, not its cause.`,
      observed: c.agreementPct, threshold: policy.threshold, comparison: best.agreementPct,
      sampleSize: c.count,
      model: c.model, deployment: key, business: policy.scope.business,
      relatedBookingIds: win.filter((j) => jobDeployment(j) === key && isEvaluated(j)).slice(0, 20).map((j) => j.bookingId),
      relatedTraceIds: [],
      readiness: null,
      at: now,
    })
  }
}

// ── formatting (owner-facing strings) ────────────────────────────────────────
const hours = (ms: number): string => {
  const h = Math.round(ms / 3_600_000)
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h} hours`
}
function fmt(v: number, unit: Unit): string {
  switch (unit) {
    case 'pct':   return `${round(v, 1)}%`
    case 'score': return round(v, 2).toString()
    case 'ms':    return `${Math.round(v)}ms`
    case 'usd':   return `$${round(v, 4)}`
    default:      return Math.round(v).toString()
  }
}

/** Human label for a deployment key, for UI/email reuse. */
export const labelForDeploymentKey = (jobs: V2ShadowJob[], key: string): string => {
  const j = jobs.find((x) => jobDeployment(x) === key)
  return j ? deploymentLabel(j) : key
}

// ── lifecycle reconciliation ─────────────────────────────────────────────────

export type SuppressedSignal = {
  dedupKey: string
  policyId: string
  reason: 'cooldown' | 'muted' | 'already_handled'
  detail: string
}

export type ReconcileInput = {
  existing: ShadowAlert[]
  signals: AlertSignal[]
  now: number
  policies?: readonly AlertPolicy[]
  /** Deterministic id factory — the caller owns id allocation so this stays pure. */
  nextId: (index: number) => string
}

export type ReconcileResult = {
  opened: ShadowAlert[]
  /** Existing alerts mutated this run (refreshed by a signal and/or newly escalated). */
  updated: ShadowAlert[]
  resolved: ShadowAlert[]
  expired: ShadowAlert[]
  /** Subset of `updated`, surfaced for observability. Persisting `updated` persists these. */
  escalated: ShadowAlert[]
  suppressed: SuppressedSignal[]
}

/**
 * Decide what the signals mean against what is already stored. Pure and idempotent: running
 * it twice with the same inputs opens the same alerts and suppresses the same duplicates,
 * so a retried or concurrently-executed cron cannot double-alert.
 *
 * Persist: opened ∪ updated ∪ resolved ∪ expired (these four are disjoint).
 */
export function reconcileAlerts(input: ReconcileInput): ReconcileResult {
  const { existing, signals, now } = input
  const policies = input.policies ?? DEFAULT_ALERT_POLICIES
  const policyOf = (id: string) => policies.find((p) => p.id === id) ?? null

  const opened: ShadowAlert[] = [], updated: ShadowAlert[] = [], resolved: ShadowAlert[] = []
  const expired: ShadowAlert[] = [], escalated: ShadowAlert[] = [], suppressed: SuppressedSignal[] = []

  // Newest-first per dedup key, so "the current alert" is unambiguous.
  const byKey = new Map<string, ShadowAlert[]>()
  for (const a of existing) {
    const g = byKey.get(a.dedupKey)
    if (g) g.push(a)
    else byKey.set(a.dedupKey, [a])
  }
  for (const g of byKey.values()) g.sort((x, y) => y.lastDetectedAt - x.lastDetectedAt)

  const matchedKeys = new Set<string>()
  const touched = new Set<string>()          // alert ids already placed in a result bucket

  for (const s of signals) {
    matchedKeys.add(s.dedupKey)
    const policy = policyOf(s.policyId)
    const group = byKey.get(s.dedupKey) ?? []
    const active = group.find((a) => a.status === 'OPEN' || a.status === 'ACKNOWLEDGED')

    // 1. Still active → refresh it. This is the dedup path: no second alert.
    if (active) {
      active.lastDetectedAt = now
      active.occurrences += 1
      active.observed = s.observed
      active.comparison = s.comparison
      active.sampleSize = s.sampleSize
      active.reason = s.reason
      if (s.readiness) active.readiness = s.readiness
      for (const b of s.relatedBookingIds) if (!active.relatedBookingIds.includes(b)) active.relatedBookingIds.push(b)
      for (const t of s.relatedTraceIds) if (!active.relatedTraceIds.includes(t)) active.relatedTraceIds.push(t)
      if (!touched.has(active.id)) { updated.push(active); touched.add(active.id) }
      continue
    }

    // 2. Muted and still within the mute window → stay quiet.
    const muted = group.find((a) => a.status === 'MUTED' && (a.mutedUntil ?? Infinity) > now)
    if (muted) {
      suppressed.push({ dedupKey: s.dedupKey, policyId: s.policyId, reason: 'muted', detail: `Muted until ${new Date(muted.mutedUntil ?? 0).toISOString()}.` })
      continue
    }

    const terminal = group.find((a) => a.status === 'RESOLVED' || a.status === 'EXPIRED')
    if (terminal && policy) {
      // 3. A per-item alert names an immutable event (a specific booking's false negative).
      //    Once the owner has closed it, re-detecting the same evidence is not news.
      if (policy.kind === 'per_item') {
        suppressed.push({ dedupKey: s.dedupKey, policyId: s.policyId, reason: 'already_handled', detail: `Owner already closed ${terminal.id} for this evaluation.` })
        continue
      }
      // 4. An aggregate condition may recur, but not before the cooldown elapses.
      const since = now - (terminal.resolvedAt ?? terminal.lastDetectedAt)
      if (since < policy.cooldownMs) {
        suppressed.push({ dedupKey: s.dedupKey, policyId: s.policyId, reason: 'cooldown', detail: `${Math.round(since / 60_000)}m since ${terminal.id} closed; cooldown is ${Math.round(policy.cooldownMs / 60_000)}m.` })
        continue
      }
    }

    // 5. Genuinely new.
    opened.push(newAlert(s, input.nextId(opened.length), now))
  }

  // Recovery + expiry, over active alerts that produced no signal this run.
  for (const a of existing) {
    if (a.status !== 'OPEN' && a.status !== 'ACKNOWLEDGED') continue
    const policy = policyOf(a.policyId)
    if (!policy) continue

    if (!matchedKeys.has(a.dedupKey)) {
      // Recovery: the aggregate condition is simply no longer true. Per-item and
      // ack-required alerts never self-clear — an unreviewed safety event that scrolled
      // out of the window has aged, not healed.
      if (policy.kind === 'aggregate' && !policy.requiresAck) {
        a.status = 'RESOLVED'
        a.resolvedAt = now
        a.resolvedBy = 'system'
        a.resolvedReason = 'Condition no longer detected — recovered.'
        if (!touched.has(a.id)) { resolved.push(a); touched.add(a.id) }
        continue
      }
      if (policy.expireAfterMs && now - a.lastDetectedAt > policy.expireAfterMs) {
        a.status = 'EXPIRED'
        a.resolvedAt = now
        a.resolvedBy = 'system'
        a.resolvedReason = `No fresh detection in ${hours(policy.expireAfterMs)}.`
        if (!touched.has(a.id)) { expired.push(a); touched.add(a.id) }
        continue
      }
    }

    // Escalation: still open, still unacknowledged, past the delay. Stamped only once.
    if (policy.escalateAfterMs && a.status === 'OPEN' && !a.escalatedAt && now - a.firstDetectedAt > policy.escalateAfterMs) {
      a.escalatedAt = now
      escalated.push(a)
      if (!touched.has(a.id)) { updated.push(a); touched.add(a.id) }
    }
  }

  return { opened, updated, resolved, expired, escalated, suppressed }
}

function newAlert(s: AlertSignal, id: string, now: number): ShadowAlert {
  return {
    alertVersion: SHADOW_ALERT_VERSION,
    id,
    policyId: s.policyId,
    policyType: s.policyType,
    severity: s.severity,
    status: 'OPEN',
    dedupKey: s.dedupKey,
    scopeKey: s.scopeKey,
    reason: s.reason,
    observed: s.observed,
    threshold: s.threshold,
    comparison: s.comparison,
    sampleSize: s.sampleSize,
    model: s.model,
    deployment: s.deployment,
    business: s.business,
    firstDetectedAt: now,
    lastDetectedAt: now,
    occurrences: 1,
    relatedBookingIds: [...s.relatedBookingIds],
    relatedTraceIds: [...s.relatedTraceIds],
    readiness: s.readiness,
    notes: [],
    unread: true,
  }
}
