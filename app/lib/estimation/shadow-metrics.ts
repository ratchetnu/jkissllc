// ── V2 Shadow — PURE observability aggregator (Phase 12) ─────────────────────
//
// Rolls up a set of shadow jobs into operational counters. Deliberately SEPARATE from
// the authoritative AI health surface (estimator-diagnostics) so a shadow failure never
// makes the real Book Now worker look unhealthy. Pure: same jobs → same metrics.

import type { V2ShadowJob, V2ShadowStatus } from './shadow-types'

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
