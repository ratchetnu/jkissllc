// ── Operion automation — orchestrator (server-only, fail-closed) ─────────────
// Ties preflight + job model + provider together with the approval gates. Every step is
// flag-gated; with flags off / no credentials the StubProvider fails closed, so a job
// stops at a clearly-labelled "blocked — execution not configured" state and NOTHING is
// dispatched, merged, or deployed. Production promotion always requires the owner.

import { isEnabled } from '../flags'
import type { PlatformUpdate, PlatformBusiness, UpdateCompatibility } from '../updates/types'
import { AUTOMATION_JOB_VERSION, type UpdateAutomationJob, type ExecutionStrategy } from './types'
import { evaluatePreflight, workBranchFor, commitDriftDetected, type PreflightResult } from './preflight'
import { businessRepoRef } from './repo-identity'
import { isProductionApprovalTransition } from './machine'
import { getAutomationProvider } from './provider'
import * as store from './store'

const flag = (f: Parameters<typeof isEnabled>[0], env?: Record<string, string | undefined>) => isEnabled(f, env)
const now = () => Date.now()

export function automationIdempotencyKey(businessId: string, updateKey: string, sourceCommit: string | undefined): string {
  return `auto:${businessId}:${updateKey}:${sourceCommit ?? 'nocommit'}`
}

export type PrepareResult = { ok: boolean; preflight: PreflightResult; job?: UpdateAutomationJob; reason?: string }

export type ReadinessInput = {
  update: PlatformUpdate; business: PlatformBusiness; compat?: UpdateCompatibility
  approvals?: { migration?: boolean; environment?: boolean }; env?: Record<string, string | undefined>
}

/** READ-ONLY preflight evaluation — no job is created, nothing is dispatched. The UI calls
 *  this to render readiness + disable "Prepare Preview" until every blocking gate passes. */
export async function evaluatePreviewReadiness(input: ReadinessInput): Promise<PreflightResult> {
  const env = input.env ?? process.env
  const hasActiveJob = !!(await store.activeJobForBusiness(input.business.id))
  return evaluatePreflight({
    update: input.update, business: input.business, compat: input.compat, hasActiveJob,
    flags: { automation: flag('OPERION_AUTOMATION_ENABLED', env), preview: flag('OPERION_PREVIEW_AUTOMATION_ENABLED', env), githubActions: flag('OPERION_GITHUB_ACTIONS_ENABLED', env) },
    approvals: input.approvals,
  })
}

/** Validate + create an automation job for a preview. Dispatch only if fully enabled +
 *  provisioned; otherwise the job stops at `blocked` (execution not configured). */
export async function preparePreview(input: {
  update: PlatformUpdate; business: PlatformBusiness; compat?: UpdateCompatibility
  actor: string; strategy?: ExecutionStrategy; approvals?: { migration?: boolean; environment?: boolean }
  env?: Record<string, string | undefined>
}): Promise<PrepareResult> {
  const { update, business, compat, actor } = input
  const env = input.env ?? process.env
  const preflight = await evaluatePreviewReadiness({ update, business, compat, approvals: input.approvals, env })
  if (!preflight.ok) return { ok: false, preflight, reason: 'preflight_failed' }

  const idem = automationIdempotencyKey(business.id, update.key, update.sourceCommit)
  const existing = await store.jobForIdempotency(idem)
  if (existing) return { ok: true, preflight, job: existing, reason: 'idempotent_existing' }

  return store.withBusinessLock<PrepareResult>(business.id, async () => {
    const dup = await store.jobForIdempotency(idem)
    if (dup) return { ok: true, preflight, job: dup, reason: 'idempotent_existing' }
    const id = await store.nextJobId()
    const t = now()
    const job: UpdateAutomationJob = {
      jobVersion: AUTOMATION_JOB_VERSION, id, updateId: update.key, businessId: business.id,
      mode: business.automationMode ?? 'manual_prompt', strategy: input.strategy ?? 'ai_adaptation',
      status: 'queued', currentStep: 'branch', attemptCount: 0, idempotencyKey: idem,
      sourceRepository: update.sourceRepo, sourceCommit: update.sourceCommit,
      targetRepository: business.repoName, baseBranch: business.defaultBranch, workBranch: workBranchFor(update.key),
      createdBy: actor, queuedAt: t, createdAt: t, updatedAt: t,
    }
    await store.saveJob(job); await store.bindIdempotency(idem, id)

    // Dispatch only when preview automation + GitHub Actions are both enabled AND a
    // provider is provisioned. The Stub fails closed → the job is blocked, not run.
    const repoRef = businessRepoRef(business)
    if (flag('OPERION_PREVIEW_AUTOMATION_ENABLED', env) && flag('OPERION_GITHUB_ACTIONS_ENABLED', env) && business.githubInstallationId && repoRef && business.automationWorkflowFile) {
      const provider = getAutomationProvider(env)
      const res = await provider.dispatchWorkflow(business.githubInstallationId, repoRef, business.automationWorkflowFile, business.defaultBranch, { deploymentRequestId: id, updateId: update.key, targetBranch: job.workBranch!, executionStrategy: job.strategy })
      if (res.ok) { job.status = 'creating_branch'; job.currentStep = 'branch'; job.startedAt = now() }
      else { job.status = 'blocked'; job.failureCategory = 'provider_error'; job.failureSummary = res.error }
    } else {
      job.status = 'blocked'; job.failureSummary = 'execution not configured — enable OPERION_PREVIEW_AUTOMATION_ENABLED + OPERION_GITHUB_ACTIONS_ENABLED and finish target setup'
    }
    job.updatedAt = now(); await store.saveJob(job)
    return { ok: true, preflight, job }
  }, { onBusy: () => ({ ok: false, preflight, reason: 'target_locked' }), token: `${business.id}:${now()}` })
}

export type ApproveResult = { ok: boolean; job?: UpdateAutomationJob; reason?: string }

/** OWNER-ONLY (route enforces). Approve a verified preview for production. Never promotes
 *  automatically without this; blocked if flags/config off or the approved commit drifted. */
export async function approveProduction(input: {
  jobId: string; business: PlatformBusiness; actor: string; env?: Record<string, string | undefined>
}): Promise<ApproveResult> {
  const env = input.env ?? process.env
  const job = await store.getJob(input.jobId)
  if (!job) return { ok: false, reason: 'no_job' }
  if (job.status !== 'awaiting_owner_review') return { ok: false, reason: `job is ${job.status}, not awaiting_owner_review` }
  if (!isProductionApprovalTransition('awaiting_owner_review', 'approved_for_production')) return { ok: false, reason: 'illegal_transition' }
  if (!flag('OPERION_PRODUCTION_PROMOTION_ENABLED', env) || !input.business.allowProductionPromotion) {
    return { ok: false, reason: 'production promotion disabled (flag or business setting)' }
  }
  return store.withBusinessLock<ApproveResult>(job.businessId, async () => {
    const j = await store.getJob(input.jobId)
    if (!j || j.status !== 'awaiting_owner_review') return { ok: false, reason: 'job changed' }
    // Commit-drift lock: never promote a commit different from the one the owner reviewed.
    if (commitDriftDetected(j.approvedCommit, j.targetCommit)) { j.status = 'failed'; j.failureCategory = 'commit_drift'; j.failureSummary = 'approved commit drifted from PR head'; j.updatedAt = now(); await store.saveJob(j); return { ok: false, job: j, reason: 'commit_drift' } }
    j.status = 'approved_for_production'; j.approvedBy = input.actor; j.approvedAt = now(); j.approvedCommit = j.targetCommit; j.updatedAt = now()
    await store.saveJob(j)
    // Merge/promote is gated + provider-driven; with the stub it fails closed → blocked.
    // (Live merge/deploy is the deferred go-live wiring.)
    return { ok: true, job: j }
  }, { onBusy: () => ({ ok: false, reason: 'target_locked' }), token: `${job.businessId}:${now()}` })
}

/** Owner/manager actions that only move job state (no external calls). */
export async function transitionJob(jobId: string, to: UpdateAutomationJob['status'], actor: string, reason?: string): Promise<ApproveResult> {
  const j = await store.getJob(jobId)
  if (!j) return { ok: false, reason: 'no_job' }
  const { canTransition } = await import('./machine')
  if (!canTransition(j.status, to)) return { ok: false, reason: `cannot move ${j.status} → ${to}` }
  j.status = to; j.updatedAt = now()
  if (reason) j.failureSummary = reason.slice(0, 2000)
  if (to === 'cancelled') j.failureCategory = 'cancelled'
  await store.saveJob(j)
  return { ok: true, job: j }
}
