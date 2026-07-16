// ── Operion automation reconciler (PURE decision core) ───────────────────────
// A job continues correctly even when the owner closes the browser: a scheduled reconciler
// inspects each active job against the real GitHub run state, repairs missed callbacks,
// finalizes stale jobs, and marks transient failures for a bounded auto-retry. This module
// is the pure decision — no I/O — so every transition is testable.

import { isTransientFailure } from './deploy-view'

export type GhRunState = { status: string; conclusion?: string | null } | null

export type ReconcileInput = {
  job: { status: string; failureCategory?: string | null; workflowRunId?: string; heartbeatAt?: number; startedAt?: number; attemptCount?: number }
  ghRun: GhRunState              // from provider.readWorkflowRun (null if unknown/not yet dispatched)
  now: number
  staleMs?: number              // job with no progress past this is finalized (default 20 min)
  maxAutoRetries?: number       // bounded auto-retry for transient failures (default 2)
  callbackGraceMs?: number      // wait for a success callback before repairing (default 90s)
}

export type ReconcileDecision =
  | { action: 'none'; reason: string }
  | { action: 'finalize'; status: 'failed'; failureCategory: string; reason: string }
  | { action: 'repair_success'; reason: string }          // run succeeded but callback lost → move to review
  | { action: 'await_callback'; reason: string }          // run finished OK, callback likely landing
  | { action: 'auto_retry'; reason: string }              // transient failure within retry budget

const ACTIVE = new Set(['queued', 'creating_branch', 'dispatched', 'running', 'applying', 'preview_deploying'])

/** Decide what the reconciler should do with one job. Never promotes; only repairs/finalizes. */
export function reconcileDecision(input: ReconcileInput): ReconcileDecision {
  const { job, ghRun, now } = input
  const staleMs = input.staleMs ?? 20 * 60_000
  const maxRetries = input.maxAutoRetries ?? 2

  // Transient failure already recorded → auto-retry within budget.
  if (isTransientFailure(job.failureCategory) && (job.attemptCount ?? 0) < maxRetries) {
    return { action: 'auto_retry', reason: `transient failure (${job.failureCategory}); retry ${(job.attemptCount ?? 0) + 1}/${maxRetries}` }
  }

  if (!ACTIVE.has(job.status)) return { action: 'none', reason: `job is ${job.status} (not active)` }

  // We can see the real GitHub run.
  if (ghRun && ghRun.status === 'completed') {
    const last = job.heartbeatAt ?? job.startedAt ?? 0
    const graceMs = input.callbackGraceMs ?? 90_000
    if (ghRun.conclusion === 'success') {
      // Callback should land within a short grace; if the job is still active past it, the
      // callback was lost (e.g. a redirect) — repair the job to owner review.
      if (last && now - last > graceMs) return { action: 'repair_success', reason: 'run succeeded but no callback within grace — moving to owner review' }
      return { action: 'await_callback', reason: 'run succeeded; awaiting signed callback' }
    }
    // Run failed/cancelled but the job is still "active" → a callback was missed. Repair it.
    return { action: 'finalize', status: 'failed', failureCategory: 'provider_error', reason: `run concluded ${ghRun.conclusion ?? 'failure'} but no callback arrived — repairing` }
  }

  // Run still in progress (or unknown) but the job has been silent too long → finalize as timeout.
  const last = job.heartbeatAt ?? job.startedAt ?? 0
  if (last && now - last > staleMs) {
    return { action: 'finalize', status: 'failed', failureCategory: 'timeout', reason: `no progress for ${Math.round((now - last) / 60000)}m — finalizing as timeout` }
  }

  return { action: 'none', reason: 'run in progress; within time budget' }
}
