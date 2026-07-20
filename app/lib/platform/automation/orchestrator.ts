// ── Operion automation — orchestrator (server-only, fail-closed) ─────────────
// Ties preflight + job model + provider together with the approval gates. Every step is
// flag-gated; with flags off / no credentials the StubProvider fails closed, so a job
// stops at a clearly-labelled "blocked — execution not configured" state and NOTHING is
// dispatched, merged, or deployed. Production promotion always requires the owner.

import { isEnabled } from '../flags'
import type { PlatformUpdate, PlatformBusiness, UpdateCompatibility } from '../updates/types'
import { AUTOMATION_JOB_VERSION, type UpdateAutomationJob, type ExecutionStrategy } from './types'
import { evaluatePreflight, workBranchFor, commitDriftDetected, automaticRollbackEligible, type PreflightResult } from './preflight'
import { businessRepoRef } from './repo-identity'
import { canPromote, canAutoRollback } from './promotion'
import { isProductionApprovalTransition } from './machine'
import { getAutomationProvider } from './provider'
import { getPreviewProvider } from './vercel-provider'
import { artifactsComplete, isAlreadyDeployed } from './deploy-view'
import { getBusiness, getUpdate } from '../updates/store'
import { productionProjectFor } from '../production-project'
import * as store from './store'

const flag = (f: Parameters<typeof isEnabled>[0], env?: Record<string, string | undefined>) => isEnabled(f, env)
const now = () => Date.now()

export function automationIdempotencyKey(businessId: string, updateKey: string, sourceCommit: string | undefined): string {
  return `auto:${businessId}:${updateKey}:${sourceCommit ?? 'nocommit'}`
}

/** The strategy a job actually runs with. The AI-assisted `ai_adaptation` strategy requires
 *  OPERION_AI_ADAPTATION_ENABLED; when that flag is off it downgrades to the deterministic,
 *  non-AI `commit_transfer` strategy. Other strategies pass through unchanged. This is the
 *  live consumer of OPERION_AI_ADAPTATION_ENABLED — the dispatched workflow receives the
 *  effective strategy. */
export function effectiveStrategy(requested: ExecutionStrategy, env: Record<string, string | undefined> = process.env): ExecutionStrategy {
  if (requested === 'ai_adaptation' && !flag('OPERION_AI_ADAPTATION_ENABLED', env)) return 'commit_transfer'
  return requested
}

export type PrepareResult = { ok: boolean; preflight: PreflightResult; job?: UpdateAutomationJob; reason?: string; alreadyDeployed?: boolean }

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
    flags: {
      automation: flag('OPERION_AUTOMATION_ENABLED', env),
      preview: flag('OPERION_PREVIEW_AUTOMATION_ENABLED', env),
      githubActions: flag('OPERION_GITHUB_ACTIONS_ENABLED', env),
      // Preview deployments may audit/configure Operion, but they must never dispatch a
      // workflow whose repository callback is bound to the Production control plane.
      controlPlane: env.VERCEL_ENV !== 'preview',
    },
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
  // Already-present guard (defense in depth): if compat says this target already carries the
  // update, there is nothing to transfer. Never create a job / dispatch — a re-transfer of
  // identical files just fails at commit. Treat it as satisfied, not a failure.
  if (isAlreadyDeployed(compat?.status)) return { ok: false, preflight, reason: 'already_deployed', alreadyDeployed: true }
  if (!preflight.ok) return { ok: false, preflight, reason: 'preflight_failed' }

  const idem = automationIdempotencyKey(business.id, update.key, update.sourceCommit)
  const existing = await store.jobForIdempotency(idem)
  if (existing) return { ok: true, preflight, job: existing, reason: 'idempotent_existing' }

  return store.withBusinessLock<PrepareResult>(business.id, async () => {
    const dup = await store.jobForIdempotency(idem)
    if (dup) return { ok: true, preflight, job: dup, reason: 'idempotent_existing' }
    const id = await store.nextJobId()
    const t = now()
    // Live consumers of the two remaining flags:
    //  • strategy — ai_adaptation downgrades to commit_transfer unless AI adaptation is on.
    //  • autoRollback — whether a later failure auto-routes to rollback_required (only when
    //    the flag is on AND a verified rollback path exists). Off ⇒ failures stay `failed`.
    const strategy = effectiveStrategy(input.strategy ?? 'ai_adaptation', env)
    const autoRollback = automaticRollbackEligible({
      enabled: flag('OPERION_AUTOMATIC_ROLLBACK_ENABLED', env),
      productionProjectId: productionProjectFor(business),
      irreversibleMigration: !!update.migrationRequired && !update.rollbackSupported,
      previousVerifiedCommit: business.currentCommit,
    })
    const job: UpdateAutomationJob = {
      jobVersion: AUTOMATION_JOB_VERSION, id, updateId: update.key, businessId: business.id,
      mode: business.automationMode ?? 'manual_prompt', strategy,
      status: 'queued', currentStep: 'branch', attemptCount: 0, idempotencyKey: idem,
      sourceRepository: update.sourceRepo, sourceCommit: update.sourceCommit,
      targetRepository: business.repoName, baseBranch: business.defaultBranch, workBranch: workBranchFor(update.key),
      automaticRollbackEligible: autoRollback,
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
  const gate = canPromote({ status: job.status, approvedCommit: job.approvedCommit, targetCommit: job.targetCommit, pullRequestNumber: job.pullRequestNumber, flagEnabled: flag('OPERION_PRODUCTION_PROMOTION_ENABLED', env), businessAllows: !!input.business.allowProductionPromotion })
  if (!gate.ok) return { ok: false, reason: gate.reason }
  if (!isProductionApprovalTransition('awaiting_owner_review', 'approved_for_production')) return { ok: false, reason: 'illegal_transition' }
  return store.withBusinessLock<ApproveResult>(job.businessId, async () => {
    const j = await store.getJob(input.jobId)
    if (!j || j.status !== 'awaiting_owner_review') return { ok: false, reason: 'job changed' }
    // Commit-drift lock: never promote a commit different from the one the owner reviewed.
    if (commitDriftDetected(j.approvedCommit ?? j.targetCommit, j.targetCommit)) { j.status = 'failed'; j.failureCategory = 'commit_drift'; j.failureSummary = 'approved commit drifted from PR head'; j.updatedAt = now(); await store.saveJob(j); return { ok: false, job: j, reason: 'commit_drift' } }
    j.status = 'approved_for_production'; j.currentStep = 'production'; j.approvedBy = input.actor; j.approvedAt = now(); j.approvedCommit = j.targetCommit; j.updatedAt = now()
    await store.saveJob(j)

    // Execute the merge (owner-approved, flag-gated). The production DEPLOY happens on the
    // target repo's git integration after the merge; advancePromotion() confirms + verifies it.
    const repoRef = businessRepoRef(input.business)
    if (!repoRef || !input.business.githubInstallationId || !j.pullRequestNumber) {
      j.status = 'failed'; j.failureCategory = 'internal_error'; j.failureSummary = 'missing repo/PR for merge'; j.updatedAt = now(); await store.saveJob(j)
      return { ok: false, job: j, reason: 'missing repo/PR for merge' }
    }
    // Capture the current production deployment as the known-good rollback target BEFORE we
    // change production, so automatic rollback (if enabled) can instantly restore it.
    const projectId = productionProjectFor(input.business)
    if (projectId && !j.rollbackTargetDeploymentId) {
      const cur = await getPreviewProvider(env).findProductionDeployment(projectId)
      if (cur.ok && cur.data && cur.data.ready) j.rollbackTargetDeploymentId = cur.data.deploymentId
    }
    j.status = 'merging'; j.currentStep = 'production'; j.updatedAt = now(); await store.saveJob(j)
    const provider = getAutomationProvider(env)
    const merged = await provider.mergePullRequest(input.business.githubInstallationId, repoRef, j.pullRequestNumber, j.approvedCommit ?? j.targetCommit ?? '')
    if (!merged.ok) {
      j.status = 'failed'; j.failureCategory = merged.category === 'commit_drift' ? 'commit_drift' : 'merge_conflict'; j.failureSummary = merged.error; j.updatedAt = now(); await store.saveJob(j)
      return { ok: false, job: j, reason: merged.error }
    }
    j.mergeCommit = merged.data.mergeCommit; j.status = 'production_deploying'; j.currentStep = 'production'; j.updatedAt = now(); await store.saveJob(j)
    return { ok: true, job: j }
  }, { onBusy: () => ({ ok: false, reason: 'target_locked' }), token: `${job.businessId}:${now()}` })
}

/** Confirm the post-merge production deployment + health, then complete. Reconciler-driven so
 *  it survives the browser closing. Never merges again; only advances a promoting job. */
export async function advancePromotion(input: { jobId: string; env?: Record<string, string | undefined> }): Promise<ApproveResult> {
  const env = input.env ?? process.env
  const job = await store.getJob(input.jobId)
  if (!job) return { ok: false, reason: 'no_job' }
  if (job.status !== 'production_deploying' && job.status !== 'verifying') return { ok: false, reason: `job is ${job.status}, not deploying` }
  const business = await getBusiness(job.businessId)
  if (!business) return { ok: false, reason: 'business missing' }
  const projectId = productionProjectFor(business)
  return store.withBusinessLock<ApproveResult>(job.businessId, async () => {
    const j = await store.getJob(input.jobId); if (!j) return { ok: false, reason: 'no_job' }
    if (j.status === 'production_deploying') {
      const vercel = getPreviewProvider(env)
      const prod = projectId ? await vercel.findProductionDeployment(projectId, j.mergeCommit) : { ok: false as const, error: 'no project', category: 'config' }
      if (!prod.ok || !prod.data) return { ok: true, job: j, reason: 'awaiting production deployment' }
      if (prod.data.failed) { j.status = 'rollback_required'; j.failureCategory = 'promotion_failed'; j.failureSummary = 'production build failed'; j.updatedAt = now(); await store.saveJob(j); return { ok: false, job: j, reason: 'production deploy failed' } }
      if (!prod.data.ready) return { ok: true, job: j, reason: 'production build in progress' }
      j.productionDeploymentId = prod.data.deploymentId; j.productionUrl = prod.data.url; j.status = 'verifying'; j.currentStep = 'verification'; j.updatedAt = now(); await store.saveJob(j)
    }
    if (j.status === 'verifying') {
      const provider = getAutomationProvider(env)
      const base = j.productionUrl || business.productionUrl
      const healthUrl = base ? base.replace(/\/$/, '') + (business.healthEndpoint ?? '/') : undefined
      const health = healthUrl ? await provider.runHealthCheck(healthUrl) : { ok: false as const, error: 'no url', category: 'config' }
      if (health.ok && health.data.ok) {
        j.status = 'completed'; j.currentStep = 'verification'; j.completedAt = now(); j.updatedAt = now(); await store.saveJob(j)
        // Automatic post-deployment reconciliation: propagate this verified promotion to
        // ALL related records (deployment, update, business version, release, audit) so the
        // owner never hand-sets a status. FAIL-SOFT — a hiccup here must not undo a live,
        // verified deploy; the reconciler cron retries any job left completed-but-unfinalized.
        try {
          const { reconcileJobRecords } = await import('./reconcile-records')
          await reconcileJobRecords({ job: j, actor: j.approvedBy ?? 'owner', actorType: 'owner', source: 'advancePromotion' })
        } catch (err) {
          console.warn('[operion] inline record reconciliation failed (cron will retry):', err instanceof Error ? err.message : err)
        }
        return { ok: true, job: j }
      }
      j.status = 'rollback_required'; j.failureCategory = 'health_failed'; j.failureSummary = 'production health check failed'; j.updatedAt = now(); await store.saveJob(j)
      return { ok: false, job: j, reason: 'production health check failed' }
    }
    return { ok: true, job: j }
  }, { onBusy: () => ({ ok: false, reason: 'target_locked' }), token: `${job.businessId}:${now()}` })
}

const RETRYABLE = new Set(['failed', 'build_failed', 'tests_failed', 'preview_failed', 'blocked'])
/** Re-dispatch a failed job's workflow (same manifest/branch). Owner-only via the route. */
export async function retryPreview(input: { jobId: string; env?: Record<string, string | undefined> }): Promise<ApproveResult> {
  const env = input.env ?? process.env
  const job = await store.getJob(input.jobId)
  if (!job) return { ok: false, reason: 'no_job' }
  if (!RETRYABLE.has(job.status)) return { ok: false, reason: `job is ${job.status}, not retryable` }
  const [business, update] = await Promise.all([getBusiness(job.businessId), getUpdate(job.updateId)])
  const repoRef = business ? businessRepoRef(business) : null
  if (!business || !update || !repoRef || !business.githubInstallationId || !business.automationWorkflowFile) return { ok: false, reason: 'target not configured' }
  if (!(flag('OPERION_PREVIEW_AUTOMATION_ENABLED', env) && flag('OPERION_GITHUB_ACTIONS_ENABLED', env))) return { ok: false, reason: 'preview automation not enabled' }
  return store.withBusinessLock<ApproveResult>(job.businessId, async () => {
    const j = await store.getJob(input.jobId)
    if (!j || !RETRYABLE.has(j.status)) return { ok: false, reason: 'job changed' }
    const provider = getAutomationProvider(env)
    const res = await provider.dispatchWorkflow(business.githubInstallationId!, repoRef, business.automationWorkflowFile!, business.defaultBranch, { deploymentRequestId: j.id, updateId: update.key, targetBranch: j.workBranch!, executionStrategy: j.strategy })
    if (!res.ok) { j.status = 'blocked'; j.failureCategory = 'provider_error'; j.failureSummary = res.error; j.updatedAt = now(); await store.saveJob(j); return { ok: false, job: j, reason: res.error } }
    j.status = 'creating_branch'; j.currentStep = 'branch'; j.attemptCount = (j.attemptCount ?? 0) + 1; j.startedAt = now(); j.failureCategory = undefined; j.failureSummary = undefined; j.updatedAt = now()
    await store.saveJob(j)
    return { ok: true, job: j }
  }, { onBusy: () => ({ ok: false, reason: 'target_locked' }), token: `${job.businessId}:${now()}` })
}

export type FinalizeResult = { ok: boolean; job?: UpdateAutomationJob; artifactsComplete?: boolean; needsAttention?: string; reason?: string }
/** Recover a review-ready job that is missing its PR and/or Preview URL. Idempotent:
 *  discovers existing artifacts before creating, never duplicates, never touches production. */
export async function finalizePreview(input: { jobId: string; env?: Record<string, string | undefined> }): Promise<FinalizeResult> {
  const env = input.env ?? process.env
  const job = await store.getJob(input.jobId)
  if (!job) return { ok: false, reason: 'no_job' }
  const business = await getBusiness(job.businessId)
  const repoRef = business ? businessRepoRef(business) : null
  if (!business || !repoRef || !business.githubInstallationId || !job.workBranch) return { ok: false, reason: 'target not configured' }

  return store.withBusinessLock<FinalizeResult>(job.businessId, async () => {
    const j = await store.getJob(input.jobId); if (!j) return { ok: false, reason: 'no_job' }
    const provider = getAutomationProvider(env)
    let needsAttention: string | undefined

    // 1) Pull request — discover, then create only if permitted.
    if (!j.pullRequestUrl) {
      const found = await provider.findPullRequest(business.githubInstallationId!, repoRef, j.workBranch!)
      if (found.ok && found.data) { j.pullRequestNumber = found.data.number; j.pullRequestUrl = found.data.url }
      else if (business.requirePullRequest !== false && flag('OPERION_GITHUB_ACTIONS_ENABLED', env)) {
        const update = await getUpdate(j.updateId)
        const created = await provider.createPullRequest(business.githubInstallationId!, repoRef, j.workBranch!, business.defaultBranch, `Operion: ${update?.title ?? j.updateId}`, `Automated Operion commit-transfer preview for ${j.updateId} (job ${j.id}). Preview-only — do not merge until owner review in Operion.`)
        if (created.ok) { j.pullRequestNumber = created.data.number; j.pullRequestUrl = created.data.url }
        else needsAttention = `Pull request could not be created (${created.error}). In the Supercharged repo: Settings → Actions → General → Workflow permissions → allow GitHub Actions to create pull requests.`
      }
    }

    // 2) Preview — discover the branch's git-integration deployment; if there's a VALID one,
    //    record it. Otherwise create a TOKEN-AUTHORIZED preview via the Vercel API, which is
    //    authorized by the account (not the commit author), so it bypasses Vercel's git-author
    //    gate that blocks bot/unverified-author commits.
    if (!j.previewUrl && business.previewProjectId) {
      const vercel = getPreviewProvider(env)
      const found = await vercel.findPreviewByBranch(business.previewProjectId, j.workBranch!)
      if (found.ok && found.data && !found.data.failed && found.data.url) {
        j.previewDeploymentId = found.data.deploymentId; j.previewUrl = found.data.url
      } else if (business.previewRepoId) {
        const created = await vercel.createPreviewDeployment({ project: business.previewProjectId, ref: j.workBranch!, repoId: business.previewRepoId })
        if (created.ok) { j.previewDeploymentId = created.data.deploymentId; j.previewUrl = created.data.url }
        else needsAttention = needsAttention ?? `Preview could not be created via the Vercel API (${created.error}). If it mentions the git author, disable git-author verification for the Supercharged project or add the deploy identity to the Vercel team.`
      } else {
        needsAttention = needsAttention ?? 'Set the Preview repository ID (numeric) so Operion can create the Preview directly.'
      }
    }

    j.updatedAt = now(); await store.saveJob(j)
    const complete = artifactsComplete(j, { requirePr: business.requirePullRequest, requirePreview: business.requirePreview })
    return { ok: true, job: j, artifactsComplete: complete, needsAttention }
  }, { onBusy: () => ({ ok: false, reason: 'target_locked' }), token: `${job.businessId}:${now()}` })
}

/** Automatic rollback: restore the captured known-good production deployment. Flag-gated
 *  + bounded; reconciler-driven so it self-heals a failed promotion. Never merges anything. */
export async function advanceRollback(input: { jobId: string; env?: Record<string, string | undefined> }): Promise<ApproveResult> {
  const env = input.env ?? process.env
  const job = await store.getJob(input.jobId)
  if (!job) return { ok: false, reason: 'no_job' }
  const gate = canAutoRollback({ status: job.status, flagEnabled: flag('OPERION_AUTOMATIC_ROLLBACK_ENABLED', env), eligible: job.automaticRollbackEligible, rollbackTargetDeploymentId: job.rollbackTargetDeploymentId, attemptCount: job.rollbackAttemptCount })
  if (!gate.ok) return { ok: false, reason: gate.reason }
  const business = await getBusiness(job.businessId)
  if (!business) return { ok: false, reason: 'business missing' }
  const projectId = productionProjectFor(business)
  return store.withBusinessLock<ApproveResult>(job.businessId, async () => {
    const j = await store.getJob(input.jobId); if (!j || j.status !== 'rollback_required') return { ok: false, reason: 'job changed' }
    j.status = 'rolling_back'; j.rollbackAttemptCount = (j.rollbackAttemptCount ?? 0) + 1; j.updatedAt = now(); await store.saveJob(j)
    const vercel = getPreviewProvider(env)
    const res = projectId && j.rollbackTargetDeploymentId ? await vercel.rollbackProduction(projectId, j.rollbackTargetDeploymentId) : { ok: false as const, error: 'no rollback target', category: 'config' }
    if (res.ok) { j.status = 'rolled_back'; j.rolledBackAt = now(); j.failureSummary = 'production restored to the previous verified deployment'; j.updatedAt = now(); await store.saveJob(j); return { ok: true, job: j } }
    j.status = 'rollback_required'; j.failureSummary = `automatic rollback failed: ${res.error}`; j.updatedAt = now(); await store.saveJob(j)
    return { ok: false, job: j, reason: res.error }
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
