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
import { getAutomationProvider, type UpdateAutomationProvider } from './provider'
import { getPreviewProvider } from './vercel-provider'
import { artifactsComplete, isAlreadyDeployed, retryEligibility } from './deploy-view'
import { getBusiness, getUpdate, getCompatMap, listDeployments } from '../updates/store'
import { evaluateRequiredUpdates, describeRequiredUpdates, type RequiredUpdateVerdict } from '../updates/policy'
import { buildCommitTransferManifest } from './manifest-builder'
import { parseRepoName } from './repo-identity'
import { productionProjectFor } from '../production-project'
import * as store from './store'
import { reconcilePublishForJob } from '../release/publish-store'

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
  /** Test seam only — production always resolves the real provider. */
  provider?: UpdateAutomationProvider
  /** Skip the (network-bound) exact transfer check. Used by the cheap UI poll. */
  skipTransferCheck?: boolean
}

/**
 * Resolve "Required updates" for one update × target (issue #48 Phase B).
 *
 * An update with no `dependencies` short-circuits with zero store reads, so every
 * record that predates this gate keeps its exact previous behaviour.
 */
export async function resolveRequiredUpdates(update: PlatformUpdate, business: PlatformBusiness): Promise<{
  ok: boolean; missing: string[]; detail?: string; verdicts: RequiredUpdateVerdict[]
}> {
  const deps = update.dependencies ?? []
  if (!deps.length) return { ok: true, missing: [], verdicts: [] }
  const [deployments, ...compatMaps] = await Promise.all([
    listDeployments(500),
    ...deps.map((k) => getCompatMap(k)),
  ])
  const compatByKey = new Map(deps.map((k, i) => [k, compatMaps[i]?.[business.id]?.status]))
  const r = evaluateRequiredUpdates({
    dependencies: deps,
    businessId: business.id,
    compatStatusFor: (k) => compatByKey.get(k),
    deployments,
  })
  return { ...r, detail: describeRequiredUpdates(r.verdicts) || undefined }
}

/**
 * The EXACT transfer, checked before a job exists (issue #48 Phase A → preflight).
 *
 * Builds the real commit-transfer manifest through the same builder the runner will
 * use, so the dependency-closure, drift, rename and exclusion gates all speak here.
 * Read-only: the builder never writes. Repository identities come from the canonical
 * records (`update.sourceRepo`, `businessRepoRef`) and never from request input.
 */
export async function checkTransferReady(input: {
  update: PlatformUpdate; business: PlatformBusiness; compat?: UpdateCompatibility
  provider?: UpdateAutomationProvider
}): Promise<{ ok: boolean; reason?: string }> {
  const { update, business, compat } = input
  const provider = input.provider ?? getAutomationProvider()
  // A provider that cannot READ is not evidence that the transfer is incomplete.
  // With no GitHub App credentials the inert StubProvider fails every call, and
  // turning that into "transfer incomplete" would block every unprovisioned
  // environment — while the real safety net (dispatch stops at "execution not
  // configured") already covers that case. Leave the gate unevaluated instead.
  if (provider.name === 'stub') return { ok: true }
  const sourceRepo = parseRepoName(update.sourceRepo)
  const targetRepo = businessRepoRef(business)
  // Anything missing here is already covered by an earlier, cheaper gate; not a
  // reason to invent a second failure for the same cause.
  if (!sourceRepo || !targetRepo || !update.sourceCommit || !business.githubInstallationId || !business.defaultBranch) {
    return { ok: true }
  }
  const built = await buildCommitTransferManifest({
    provider,
    installationId: business.githubInstallationId,
    sourceRepo, sourceRepoName: update.sourceRepo!, sourceCommit: update.sourceCommit,
    targetRepo, targetBranch: business.defaultBranch,
    updateKey: update.key,
    compatibility: compat,
  })
  return built.ok ? { ok: true } : { ok: false, reason: built.error }
}

/** READ-ONLY preflight evaluation — no job is created, nothing is dispatched. The UI calls
 *  this to render readiness + disable "Prepare Preview" until every blocking gate passes. */
export async function evaluatePreviewReadiness(input: ReadinessInput): Promise<PreflightResult> {
  const env = input.env ?? process.env
  const [hasActiveJob, requiredUpdates] = await Promise.all([
    store.activeJobForBusiness(input.business.id).then(Boolean),
    resolveRequiredUpdates(input.update, input.business),
  ])
  // The transfer check costs GitHub reads, so it runs only when every cheaper gate
  // already passes — and never for the read-only UI poll.
  let transferReady: { ok: boolean; reason?: string } | undefined
  if (!input.skipTransferCheck && requiredUpdates.ok) {
    const cheap = evaluatePreflight({
      update: input.update, business: input.business, compat: input.compat, hasActiveJob,
      flags: {
        automation: flag('OPERION_AUTOMATION_ENABLED', env),
        preview: flag('OPERION_PREVIEW_AUTOMATION_ENABLED', env),
        githubActions: flag('OPERION_GITHUB_ACTIONS_ENABLED', env),
        controlPlane: env.VERCEL_ENV !== 'preview',
      },
      approvals: input.approvals,
      requiredUpdates,
    })
    if (cheap.ok) transferReady = await checkTransferReady({ update: input.update, business: input.business, compat: input.compat, provider: input.provider })
  }
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
    requiredUpdates,
    transferReady,
  })
}

/** Validate + create an automation job for a preview. Dispatch only if fully enabled +
 *  provisioned; otherwise the job stops at `blocked` (execution not configured). */
export async function preparePreview(input: {
  update: PlatformUpdate; business: PlatformBusiness; compat?: UpdateCompatibility
  actor: string; strategy?: ExecutionStrategy; approvals?: { migration?: boolean; environment?: boolean }
  env?: Record<string, string | undefined>
  /** Test seam only — production always resolves the real provider. */
  provider?: UpdateAutomationProvider
}): Promise<PrepareResult> {
  const { update, business, compat, actor } = input
  const env = input.env ?? process.env
  // Full readiness INCLUDING the exact transfer check. A failure here means no job is
  // created, no branch, no dispatch, no deployment — nothing external happens at all.
  const preflight = await evaluatePreviewReadiness({ update, business, compat, approvals: input.approvals, env, provider: input.provider })
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
      const provider = input.provider ?? getAutomationProvider(env)
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

export type ApproveResult = { ok: boolean; job?: UpdateAutomationJob; reason?: string; detail?: string }

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
    // Capture the known-good rollback target BEFORE we change production.
    //
    // GAP A. Eligibility is computed at prepare from `business.currentCommit` — a
    // COMMIT — but a rollback executes against a DEPLOYMENT ID. Previously the two
    // were never linked: the lookup here was unguarded, took whatever production
    // deployment happened to be newest, and the merge proceeded regardless. A job
    // could therefore be marked rollback-eligible, change production, fail, and only
    // then discover it had nothing to roll back to.
    //
    // Now the target is resolved FOR THE VERIFIED COMMIT and must be `ready`. If the
    // flag is on and that cannot be established, the promotion is REFUSED before
    // production changes — asserting recoverability we do not have is worse than not
    // promoting. If the flag is off, promotion proceeds (unchanged behaviour) but the
    // absence is recorded, so nobody discovers it mid-incident.
    const projectId = productionProjectFor(input.business)
    const autoRollbackOn = flag('OPERION_AUTOMATIC_ROLLBACK_ENABLED', env)
    if (!j.rollbackTargetDeploymentId) {
      const verifiedCommit = input.business.currentCommit
      let reason: string | undefined
      if (!projectId) reason = 'no production project configured'
      else if (!verifiedCommit) reason = 'business has no verified current commit to roll back to'
      else {
        const cur = await getPreviewProvider(env).findProductionDeployment(projectId, verifiedCommit)
        if (!cur.ok) reason = `could not read the current production deployment: ${cur.error}`
        else if (!cur.data) reason = `no production deployment found for the verified commit ${verifiedCommit.slice(0, 8)}`
        else if (!cur.data.ready) reason = `the production deployment for ${verifiedCommit.slice(0, 8)} is ${cur.data.state}, not ready`
        else {
          j.rollbackTargetDeploymentId = cur.data.deploymentId
          j.rollbackTargetCommit = verifiedCommit
        }
      }
      if (reason) {
        if (autoRollbackOn && j.automaticRollbackEligible) {
          // Refuse. Do NOT enter `merging` claiming a recovery path we lack.
          j.status = 'failed'; j.failureCategory = 'promotion_failed'
          j.failureSummary = `refused to promote: automatic rollback is enabled but no verified rollback target could be captured — ${reason}`
          j.rollbackUnavailableReason = reason
          j.updatedAt = now(); await store.saveJob(j)
          return { ok: false, job: j, reason: j.failureSummary }
        }
        // Flag off (or job not eligible): proceed, but record the gap explicitly and
        // make sure nothing downstream believes automatic recovery is available.
        j.rollbackUnavailableReason = reason
        j.automaticRollbackEligible = false
      }
    }
    j.status = 'merging'; j.currentStep = 'production'; j.updatedAt = now(); await store.saveJob(j)
    const provider = getAutomationProvider(env)
    const merged = await provider.mergePullRequest(input.business.githubInstallationId, repoRef, j.pullRequestNumber, j.approvedCommit ?? j.targetCommit ?? '')
    if (!merged.ok) {
      j.status = 'failed'; j.failureCategory = merged.category === 'commit_drift' ? 'commit_drift' : 'merge_conflict'; j.failureSummary = merged.error; j.updatedAt = now(); await store.saveJob(j)
      return { ok: false, job: j, reason: merged.error }
    }
    const productionDeployStartedAt = now()
    j.mergeCommit = merged.data.mergeCommit; j.status = 'production_deploying'; j.currentStep = 'production'
    j.productionDeployStartedAt = productionDeployStartedAt; j.updatedAt = productionDeployStartedAt; await store.saveJob(j)
    return { ok: true, job: j }
  }, { onBusy: () => ({ ok: false, reason: 'target_locked' }), token: `${job.businessId}:${now()}` })
}

/** Confirm the post-merge production deployment + health, then complete. Reconciler-driven so
 *  it survives the browser closing. Never merges again; only advances a promoting job. */
export const PRODUCTION_DEPLOY_TIMEOUT_MS = 30 * 60_000

export async function advancePromotion(input: { jobId: string; env?: Record<string, string | undefined>; at?: number }): Promise<ApproveResult> {
  const env = input.env ?? process.env
  const t = input.at ?? now()
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
      const deploymentTimedOut = t - (j.productionDeployStartedAt ?? j.updatedAt) >= PRODUCTION_DEPLOY_TIMEOUT_MS
      if ((!prod.ok || !prod.data) && deploymentTimedOut) {
        j.status = 'failed'; j.failureCategory = 'promotion_failed'
        j.failureSummary = `no ready production deployment appeared within ${Math.round(PRODUCTION_DEPLOY_TIMEOUT_MS / 60_000)} minutes of the merge`
        j.updatedAt = t; await store.saveJob(j)
        await reconcilePublishForJob({ jobId: j.id, status: 'failed', now: t, reason: j.failureSummary }).catch(() => null)
        return { ok: false, job: j, reason: j.failureSummary }
      }
      if (!prod.ok || !prod.data) return { ok: true, job: j, reason: 'awaiting production deployment' }
      if (prod.data.failed) {
        j.status = 'rollback_required'; j.failureCategory = 'promotion_failed'; j.failureSummary = 'production build failed'; j.updatedAt = now(); await store.saveJob(j)
        await reconcilePublishForJob({ jobId: j.id, status: 'failed', now: j.updatedAt, reason: j.failureSummary }).catch(() => null)
        return { ok: false, job: j, reason: 'production deploy failed' }
      }
      if (!prod.data.ready && deploymentTimedOut) {
        j.status = 'failed'; j.failureCategory = 'promotion_failed'
        j.failureSummary = `production deployment did not become ready within ${Math.round(PRODUCTION_DEPLOY_TIMEOUT_MS / 60_000)} minutes of the merge`
        j.updatedAt = t; await store.saveJob(j)
        await reconcilePublishForJob({ jobId: j.id, status: 'failed', now: t, deploymentId: prod.data.deploymentId, reason: j.failureSummary }).catch(() => null)
        return { ok: false, job: j, reason: j.failureSummary }
      }
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
        await reconcilePublishForJob({ jobId: j.id, status: 'completed', now: j.updatedAt, deploymentId: j.productionDeploymentId }).catch(() => null)
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
      await reconcilePublishForJob({ jobId: j.id, status: 'failed', now: j.updatedAt, deploymentId: j.productionDeploymentId, reason: j.failureSummary }).catch(() => null)
      return { ok: false, job: j, reason: 'production health check failed' }
    }
    return { ok: true, job: j }
  }, { onBusy: () => ({ ok: false, reason: 'target_locked' }), token: `${job.businessId}:${now()}` })
}

/** Re-dispatch a failed job's workflow (same manifest/branch). Owner-only via the route.
 *  Eligibility is `retryEligibility()` in deploy-view — the SAME helper the Retry button and
 *  its copy use, so the UI can never offer a retry the dispatcher will refuse (or hide one it
 *  would allow). The local RETRYABLE set that used to live here was one of three disagreeing
 *  job-status sets and is gone. */
export async function retryPreview(input: { jobId: string; env?: Record<string, string | undefined> }): Promise<ApproveResult> {
  const env = input.env ?? process.env
  const job = await store.getJob(input.jobId)
  if (!job) return { ok: false, reason: 'no_job' }
  const [business, update] = await Promise.all([getBusiness(job.businessId), getUpdate(job.updateId)])
  const repoRef = business ? businessRepoRef(business) : null
  if (!business || !update || !repoRef || !business.githubInstallationId || !business.automationWorkflowFile) return { ok: false, reason: 'target not configured' }
  // A retry IS a dispatch, so it clears the same bar as the first one — including the
  // update's own status. This check previously did not exist here, which let an ARCHIVED
  // update be re-fired indefinitely from the Release Center (UPD-1004 reached attempt 5).
  // Blocked here means: no dispatch, no branch, no attemptCount increment, nothing written.
  const eligible = retryEligibility({ jobStatus: job.status, failureCategory: job.failureCategory, updateStatus: update.status, attemptCount: job.attemptCount })
  if (!eligible.ok) return { ok: false, reason: eligible.reason, detail: eligible.detail }
  if (!(flag('OPERION_PREVIEW_AUTOMATION_ENABLED', env) && flag('OPERION_GITHUB_ACTIONS_ENABLED', env))) return { ok: false, reason: 'preview automation not enabled' }
  return store.withBusinessLock<ApproveResult>(job.businessId, async () => {
    const j = await store.getJob(input.jobId)
    // Re-evaluated inside the lock against the freshly-read job — the status or attempt
    // count may have moved while we waited.
    if (!j) return { ok: false, reason: 'job changed' }
    const still = retryEligibility({ jobStatus: j.status, failureCategory: j.failureCategory, updateStatus: update.status, attemptCount: j.attemptCount })
    if (!still.ok) return { ok: false, reason: still.reason, detail: still.detail }
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
    if (res.ok) {
      // GAP B. A 200 from Vercel means the rollback was ACCEPTED, not finished — it
      // runs asynchronously. Recording `rolled_back` here claimed "production
      // restored" on evidence nothing had checked. The job now stays `rolling_back`
      // until pollRollback() sees Vercel report 'succeeded'.
      j.rollbackStartedAt = now(); j.rollbackPollCount = 0; j.rollbackLastPolledAt = undefined
      j.failureSummary = 'rollback started — awaiting confirmation from Vercel'
      j.updatedAt = now(); await store.saveJob(j)
      return { ok: true, job: j }
    }
    j.status = 'rollback_required'; j.failureSummary = `automatic rollback failed to start: ${res.error}`; j.updatedAt = now(); await store.saveJob(j)
    return { ok: false, job: j, reason: res.error }
  }, { onBusy: () => ({ ok: false, reason: 'target_locked' }), token: `${job.businessId}:${now()}` })
}

/** Bounded confirmation polling for an in-flight rollback (GAP B).
 *
 *  Vercel's rollback is asynchronous, so completion is a separate FACT that has to
 *  be read. This is driven by stored timestamps rather than an in-process timer, so
 *  it is safe across crashes and duplicate invocations: every call re-reads the job,
 *  refuses if the job is not `rolling_back`, and respects the backoff and the poll
 *  ceiling recorded on the record itself.
 */
export const ROLLBACK_MAX_POLLS = 20
export const ROLLBACK_POLL_BACKOFF_MS = 15_000
export const ROLLBACK_TIMEOUT_MS = 15 * 60_000

export async function pollRollback(input: { jobId: string; env?: Record<string, string | undefined>; at?: number }): Promise<ApproveResult> {
  const env = input.env ?? process.env
  const t = input.at ?? now()
  const job = await store.getJob(input.jobId)
  if (!job) return { ok: false, reason: 'no_job' }
  // Only an in-flight rollback is pollable. A duplicate invocation against a job
  // that already settled is a no-op, never a second rollback.
  if (job.status !== 'rolling_back') return { ok: false, reason: `job is ${job.status}, not rolling_back` }
  if (!job.rollbackStartedAt) return { ok: false, reason: 'no rollback in flight' }

  // Backoff: derived from the stored timestamp, so a crash-restart cannot poll faster.
  if (job.rollbackLastPolledAt && t - job.rollbackLastPolledAt < ROLLBACK_POLL_BACKOFF_MS) {
    return { ok: false, reason: 'backoff' }
  }

  const business = await getBusiness(job.businessId)
  if (!business) return { ok: false, reason: 'business missing' }
  const projectId = productionProjectFor(business)
  if (!projectId) return { ok: false, reason: 'no production project' }

  return store.withBusinessLock<ApproveResult>(job.businessId, async () => {
    const j = await store.getJob(input.jobId)
    // Re-check under the lock: another invocation may have settled it already.
    if (!j || j.status !== 'rolling_back') return { ok: false, reason: 'job changed' }

    j.rollbackPollCount = (j.rollbackPollCount ?? 0) + 1
    j.rollbackLastPolledAt = t
    const timedOut = t - (j.rollbackStartedAt ?? t) >= ROLLBACK_TIMEOUT_MS
    const exhausted = j.rollbackPollCount >= ROLLBACK_MAX_POLLS

    const st = await getPreviewProvider(env).rollbackStatus(projectId)

    if (st.ok && st.data.status === 'succeeded') {
      // The ONLY path that may claim the rollback finished — and only when Vercel
      // agrees the target it restored is the one we asked for.
      const restoredWrong = !!st.data.toDeploymentId && !!j.rollbackTargetDeploymentId
        && st.data.toDeploymentId !== j.rollbackTargetDeploymentId
      if (restoredWrong) {
        j.status = 'rollback_required'
        j.failureSummary = `rollback reported success for a DIFFERENT deployment (${st.data.toDeploymentId}) than the captured target (${j.rollbackTargetDeploymentId}) — needs a human`
        j.updatedAt = now(); await store.saveJob(j)
        return { ok: false, job: j, reason: j.failureSummary }
      }
      j.status = 'rolled_back'; j.rolledBackAt = now(); j.rollbackConfirmedAt = now()
      j.failureSummary = 'production restored to the previous verified deployment (confirmed by Vercel)'
      j.updatedAt = now(); await store.saveJob(j)
      return { ok: true, job: j }
    }

    if (st.ok && st.data.status === 'failed') {
      j.status = 'rollback_required'
      j.failureSummary = 'Vercel reported the rollback FAILED — production is still on the bad deployment'
      j.updatedAt = now(); await store.saveJob(j)
      return { ok: false, job: j, reason: j.failureSummary }
    }

    // in_progress, unknown, or an unreadable status. Keep waiting — but only within
    // the bounds, and never claim an outcome we do not have.
    if (timedOut || exhausted) {
      j.status = 'rollback_required'
      const why = timedOut ? `did not confirm within ${Math.round(ROLLBACK_TIMEOUT_MS / 60_000)} minutes` : `did not confirm after ${ROLLBACK_MAX_POLLS} checks`
      const seen = st.ok ? `last status: ${st.data.status}` : `status unreadable: ${st.error}`
      j.failureSummary = `rollback ${why} — ${seen}. Production state is UNCONFIRMED; verify manually before retrying.`
      j.failureCategory = 'timeout'
      j.updatedAt = now(); await store.saveJob(j)
      return { ok: false, job: j, reason: j.failureSummary }
    }

    j.failureSummary = st.ok
      ? `rollback in progress — Vercel reports ${st.data.status} (check ${j.rollbackPollCount}/${ROLLBACK_MAX_POLLS})`
      : `rollback in progress — status unreadable (${st.error}), will retry`
    j.updatedAt = now(); await store.saveJob(j)
    return { ok: false, job: j, reason: 'pending' }
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
