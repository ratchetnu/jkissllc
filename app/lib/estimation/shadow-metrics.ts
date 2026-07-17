// ── V2 Shadow — PURE observability aggregator (Phase 12) ─────────────────────
//
// Rolls up a set of shadow jobs into operational counters. Deliberately SEPARATE from
// the authoritative AI health surface (estimator-diagnostics) so a shadow failure never
// makes the real Book Now worker look unhealthy. Pure: same jobs → same metrics.

import type { V2ShadowJob, V2ShadowStatus } from './shadow-types'
import { shadowDayKey } from './shadow-budget'

export type ShadowMetrics = {
  total: number
  byStatus: Record<V2ShadowStatus, number>
  queued: number
  processing: number
  completed: number
  failed: number
  timedOut: number
  manualReview: number
  retries: number            // total retry attempts beyond the first, across jobs
  awaitingReview: number     // completed/manual_review with no owner review yet
  avgRuntimeMs: number | null
  totalEstCostUsd: number
  invalidOutput: number
  imageAccessFailures: number
}

const ZERO_STATUS: Record<V2ShadowStatus, number> = {
  not_eligible: 0, queued: 0, processing: 0, completed: 0, manual_review: 0,
  retrying: 0, failed: 0, cancelled: 0, skipped: 0,
}

export function computeShadowMetrics(jobs: V2ShadowJob[]): ShadowMetrics {
  const byStatus: Record<V2ShadowStatus, number> = { ...ZERO_STATUS }
  let retries = 0, awaitingReview = 0, timedOut = 0, cost = 0, invalidOutput = 0, imageAccess = 0
  let runtimeSum = 0, runtimeN = 0

  for (const j of jobs) {
    byStatus[j.status] = (byStatus[j.status] ?? 0) + 1
    if (j.attempts > 1) retries += j.attempts - 1
    if (j.timeoutCategory) timedOut++
    if (j.failureCategory === 'invalid_output') invalidOutput++
    if (j.failureCategory === 'image_access') imageAccess++
    if (typeof j.estimatedCostUsd === 'number') cost += j.estimatedCostUsd
    if (typeof j.latencyMs === 'number' && j.latencyMs > 0) { runtimeSum += j.latencyMs; runtimeN++ }
    if ((j.status === 'completed' || j.status === 'manual_review') && !j.reviewedAt) awaitingReview++
  }

  return {
    total: jobs.length,
    byStatus,
    queued: byStatus.queued,
    processing: byStatus.processing,
    completed: byStatus.completed,
    failed: byStatus.failed,
    timedOut,
    manualReview: byStatus.manual_review,
    retries,
    awaitingReview,
    avgRuntimeMs: runtimeN > 0 ? Math.round(runtimeSum / runtimeN) : null,
    totalEstCostUsd: Math.round(cost * 10000) / 10000,
    invalidOutput,
    imageAccessFailures: imageAccess,
  }
}

// ── AI usage + cost rollup (credit protection surface) ───────────────────────
// A PURE aggregation over stored jobs for the dashboard's usage panel. Pairs with the live
// day-spend counters (shadow-store): this covers all-time/among-sample totals, the counters
// cover "today" precisely. Both are shown so the owner can see spend at a glance.

export type ShadowUsage = {
  totalEvaluations: number       // jobs that made at least one inference attempt
  totalInferenceAttempts: number // sum of attempts across all jobs — the real call count
  totalRetries: number           // attempts beyond the first
  estTotalCostUsd: number
  withCost: number               // jobs with a recorded cost
  missingCost: number            // jobs that ran but reported no usage (cost unknown, not 0)
  byFailureCategory: Record<string, number>
  today: { day: string; evaluations: number; estCostUsd: number }
}

export function computeShadowUsage(jobs: V2ShadowJob[], now: number): ShadowUsage {
  const day = shadowDayKey(now)
  let attempts = 0, retries = 0, cost = 0, withCost = 0, missingCost = 0, evals = 0
  let todayEvals = 0, todayCost = 0
  const byFailure: Record<string, number> = {}
  for (const j of jobs) {
    if (j.attempts > 0) { evals++; attempts += j.attempts; retries += Math.max(0, j.attempts - 1) }
    const ran = j.status === 'completed' || j.status === 'manual_review' || j.status === 'failed'
    if (ran && typeof j.estimatedCostUsd === 'number') { cost += j.estimatedCostUsd; withCost++ }
    else if (ran && j.result?.ok) missingCost++      // succeeded but no usage reported
    if (j.failureCategory) byFailure[j.failureCategory] = (byFailure[j.failureCategory] ?? 0) + 1
    const t = j.completedAt ?? j.updatedAt
    if (shadowDayKey(t) === day && j.attempts > 0) {
      todayEvals++
      if (typeof j.estimatedCostUsd === 'number') todayCost += j.estimatedCostUsd
    }
  }
  return {
    totalEvaluations: evals,
    totalInferenceAttempts: attempts,
    totalRetries: retries,
    estTotalCostUsd: Math.round(cost * 10000) / 10000,
    withCost,
    missingCost,
    byFailureCategory: byFailure,
    today: { day, evaluations: todayEvals, estCostUsd: Math.round(todayCost * 10000) / 10000 },
  }
}
