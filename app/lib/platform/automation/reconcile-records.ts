// ── Operion post-deployment reconciliation — I/O applier ─────────────────────
//
// The write side of finalize.ts. Given a VERIFIED automation job (status `completed`),
// it loads the related records, computes the deterministic plan, and applies it
// idempotently: the DeploymentRecord (create-or-update, keyed by automationJobId so it
// never duplicates), the PlatformUpdate status, the PlatformBusiness commit/version/
// timestamps/health, an associated PlatformRelease, and the platform audit trail — then
// stamps `recordsFinalizedAt` on the job so it's finalized exactly once.
//
// Invariants preserved: this NEVER merges, deploys, rolls back, or sends customer comms.
// It only reconciles the system-of-record to match a deployment that already happened.

import type { UpdateAutomationJob } from './types'
import type { DeploymentRecord, PlatformBusiness, PlatformUpdate, PlatformRelease } from '../updates/types'
import { finalizationPlan, type JobFacts, type ReleaseTargetState } from './finalize'
import {
  getBusiness, saveBusiness, getUpdate, saveUpdate,
  listDeployments, saveDeployment, nextDeploymentId,
  saveRelease, listReleases, listCompat,
} from '../updates/store'
import { getJob, saveJob, listJobs } from './store'
import { recordPlatformAudit, type PlatformAuditAction } from '../updates/audit'

const now = () => Date.now()
const uniq = (xs: string[]) => [...new Set(xs)]

export type ReconcileSummary = {
  ok: boolean
  jobId: string
  action: 'finalized' | 'already_finalized' | 'skipped'
  reason?: string
  deploymentId?: string          // the platform DeploymentRecord id (DEP-*)
  vercelDeploymentId?: string
  commit?: string
  updateStatus?: { key: string; from: string; to: string }
  businessId?: string
  businessCommit?: string
  releaseStatus?: { version: string; from: string; to: string }
  auditIds: string[]
}

/** Target businesses an update is REQUIRED to reach: any with a non-cancelled automation
 *  job for it, plus any marked applicable via a compatibility record. The current business
 *  is always included by the caller. */
async function requiredTargetsForUpdate(updateKey: string, allJobs: UpdateAutomationJob[]): Promise<string[]> {
  const fromJobs = allJobs.filter((j) => j.updateId === updateKey && j.status !== 'cancelled').map((j) => j.businessId)
  const compats = await listCompat(updateKey)
  const fromCompat = compats
    .filter((c) => ['compatible', 'compatible_with_changes', 'already_present'].includes(c.status))
    .map((c) => c.businessId)
  return uniq([...fromJobs, ...fromCompat])
}

/** Businesses with a verified (deployed + passed) DeploymentRecord for this update. */
function verifiedTargetsFromDeployments(updateKey: string, deployments: DeploymentRecord[]): string[] {
  return uniq(
    deployments
      .filter((d) => d.updateKeys.includes(updateKey) && d.status === 'deployed' && d.verificationStatus === 'passed')
      .map((d) => d.businessId),
  )
}

/** The release (if any) an update belongs to, plus each target's verified/pending/failed state. */
function releaseTargetStates(release: PlatformRelease, deployments: DeploymentRecord[], justVerifiedBiz: string): ReleaseTargetState[] {
  return release.targetBusinessIds.map((biz): ReleaseTargetState => {
    const forBiz = deployments.filter((d) => d.businessId === biz &&
      (d.releaseVersion === release.version || d.updateKeys.some((k) => release.updateKeys.includes(k))))
    const verified = biz === justVerifiedBiz || forBiz.some((d) => d.status === 'deployed' && d.verificationStatus === 'passed')
    if (verified) return { businessId: biz, state: 'verified' }
    if (forBiz.some((d) => d.status === 'failed')) return { businessId: biz, state: 'failed' }
    return { businessId: biz, state: 'pending' }
  })
}

function jobFacts(job: UpdateAutomationJob): JobFacts {
  return {
    id: job.id, updateId: job.updateId, businessId: job.businessId, status: job.status,
    productionDeploymentId: job.productionDeploymentId, productionUrl: job.productionUrl,
    mergeCommit: job.mergeCommit, approvedCommit: job.approvedCommit, targetCommit: job.targetCommit,
    sourceRepository: job.sourceRepository, targetRepository: job.targetRepository,
    pullRequestNumber: job.pullRequestNumber, pullRequestUrl: job.pullRequestUrl,
    approvedBy: job.approvedBy, completedAt: job.completedAt,
    result: job.result ? { buildPassed: job.result.buildPassed, testsPassed: job.result.testsPassed } : null,
    traceId: job.traceId,
  }
}

/**
 * Reconcile all records for a verified job. Idempotent + fail-closed on preconditions.
 *  - Only acts on a `completed` job (verified). Anything else → skipped (no writes).
 *  - Short-circuits if already finalized, unless `force`.
 *  - Never creates a duplicate DeploymentRecord (found by automationJobId).
 */
export async function reconcileJobRecords(input: {
  jobId?: string
  job?: UpdateAutomationJob
  actor?: string
  actorType?: 'owner' | 'system'
  source?: string
  force?: boolean
}): Promise<ReconcileSummary> {
  const job = input.job ?? (input.jobId ? await getJob(input.jobId) : null)
  if (!job) return { ok: false, jobId: input.jobId ?? '?', action: 'skipped', reason: 'no_job', auditIds: [] }
  const actor = input.actor ?? 'system'
  const actorType = input.actorType ?? 'system'
  const source = input.source ?? 'reconciler'

  if (job.status !== 'completed') {
    return { ok: false, jobId: job.id, action: 'skipped', reason: `job is ${job.status}, not completed`, auditIds: [] }
  }
  if (job.recordsFinalizedAt && !input.force) {
    return { ok: true, jobId: job.id, action: 'already_finalized', reason: 'records already finalized', deploymentId: undefined, auditIds: [] }
  }

  const business = await getBusiness(job.businessId)
  if (!business) return { ok: false, jobId: job.id, action: 'skipped', reason: 'business missing', auditIds: [] }

  const [update, allJobs, deployments, releases] = await Promise.all([
    getUpdate(job.updateId), listJobs(500), listDeployments(500), listReleases(200),
  ])

  // Required + verified target sets for the update (current business always counts).
  const required = uniq([...(await requiredTargetsForUpdate(job.updateId, allJobs)), job.businessId])
  const verified = uniq([...verifiedTargetsFromDeployments(job.updateId, deployments), job.businessId])

  // Release association (optional).
  const releaseForUpdate = releases.find((r) => r.updateKeys.includes(job.updateId)) ?? null
  const release = releaseForUpdate ? { version: releaseForUpdate.version, status: releaseForUpdate.status } : null
  const releaseTargets = releaseForUpdate ? releaseTargetStates(releaseForUpdate, deployments, job.businessId) : null

  const existingDeployment = deployments.find((d) => d.automationJobId === job.id) ?? null

  const plan = finalizationPlan({
    job: jobFacts(job),
    update: update ? { key: update.key, status: update.status } : null,
    existingDeployment,
    requiredTargets: required,
    verifiedTargets: verified,
    release,
    releaseTargets,
    now: now(),
  })

  const auditIds: string[] = []
  const audit = async (a: {
    action: PlatformAuditAction; summary: string; priorStatus?: string; newStatus?: string
    commit?: string; deploymentId?: string; releaseVersion?: string
  }) => {
    const ev = await recordPlatformAudit({
      actor, actorType, source, action: a.action,
      businessId: job.businessId, updateKey: job.updateId, jobId: job.id,
      deploymentId: a.deploymentId, releaseVersion: a.releaseVersion, commit: a.commit,
      priorStatus: a.priorStatus, newStatus: a.newStatus, summary: a.summary, traceId: job.traceId,
    })
    if (ev) auditIds.push(ev.id)
  }

  // ── 1) DeploymentRecord (create-or-update, keyed by automationJobId) ───────
  const p = plan.deployment.patch
  let depId = existingDeployment?.id
  if (existingDeployment) {
    const merged: DeploymentRecord = {
      ...existingDeployment,
      status: p.status, verificationStatus: p.verificationStatus,
      buildStatus: p.buildStatus, healthCheckStatus: p.healthCheckStatus, smokeTestStatus: p.smokeTestStatus,
      deploymentId: p.deploymentId ?? existingDeployment.deploymentId,
      deploymentUrl: p.deploymentUrl ?? existingDeployment.deploymentUrl,
      targetCommit: p.targetCommit ?? existingDeployment.targetCommit,
      rollbackAvailable: p.rollbackAvailable,
      verifiedBy: actor, verifiedAt: p.verifiedAt, updatedAt: now(),
    }
    await saveDeployment(merged)
  } else {
    depId = await nextDeploymentId()
    const rec: DeploymentRecord = {
      recordVersion: 1, id: depId, businessId: job.businessId, updateKeys: [job.updateId],
      releaseVersion: releaseForUpdate?.version,
      repo: job.targetRepository, branch: business.defaultBranch, sourceCommit: job.sourceCommit,
      targetCommit: p.targetCommit, provider: business.deployProvider ?? 'vercel',
      deploymentId: p.deploymentId, deploymentUrl: p.deploymentUrl, automationJobId: job.id,
      environment: 'production', status: p.status,
      buildStatus: p.buildStatus, healthCheckStatus: p.healthCheckStatus, smokeTestStatus: p.smokeTestStatus,
      verificationStatus: p.verificationStatus, rollbackAvailable: p.rollbackAvailable,
      previousCommit: business.currentCommit,
      initiatedBy: job.approvedBy ?? actor, verifiedBy: actor,
      createdAt: now(), updatedAt: now(), verifiedAt: p.verifiedAt,
    }
    await saveDeployment(rec)
  }
  await audit({ action: 'promotion.deployment_verified', deploymentId: plan.facts.deploymentId, commit: plan.facts.commit, newStatus: 'verified', summary: `Deployment record ${depId} verified (${business.name})` })

  // ── 2) PlatformBusiness provenance ─────────────────────────────────────────
  const nextBiz: PlatformBusiness = {
    ...business,
    currentCommit: plan.business.currentCommit ?? business.currentCommit,
    latestVerifiedCommit: plan.business.latestVerifiedCommit ?? business.latestVerifiedCommit,
    currentVersion: plan.business.currentVersion ?? business.currentVersion,
    latestVerifiedVersion: plan.business.latestVerifiedVersion ?? business.latestVerifiedVersion,
    lastDeploymentAt: plan.business.lastDeploymentAt,
    lastVerificationAt: plan.business.lastVerificationAt,
    healthStatus: plan.business.healthStatus,
    updatedAt: now(),
  }
  await saveBusiness(nextBiz)
  await audit({ action: 'promotion.business_commit_updated', commit: plan.business.currentCommit, newStatus: 'healthy', summary: `${business.name} current commit → ${(plan.business.currentCommit ?? '').slice(0, 10)}, verified` })

  // ── 3) PlatformUpdate status ───────────────────────────────────────────────
  let updateStatus: ReconcileSummary['updateStatus']
  if (update && plan.update) {
    updateStatus = { key: plan.update.key, from: plan.update.from, to: plan.update.to }
    if (plan.update.from !== plan.update.to) {
      const nextUpd: PlatformUpdate = { ...update, status: plan.update.to, updatedAt: now() }
      await saveUpdate(nextUpd)
      await audit({
        action: plan.update.to === 'fully_deployed' ? 'promotion.update_fully_deployed' : 'promotion.update_partially_deployed',
        priorStatus: plan.update.from, newStatus: plan.update.to,
        summary: `${plan.update.key} ${plan.update.from} → ${plan.update.to}`,
      })
    }
  }

  // ── 4) PlatformRelease status ──────────────────────────────────────────────
  let releaseStatus: ReconcileSummary['releaseStatus']
  if (releaseForUpdate && plan.release) {
    releaseStatus = { version: plan.release.version, from: plan.release.from, to: plan.release.to }
    if (plan.release.from !== plan.release.to) {
      const nextRel: PlatformRelease = { ...releaseForUpdate, status: plan.release.to, updatedAt: now() }
      await saveRelease(nextRel)
      await audit({
        action: plan.release.to === 'completed' ? 'promotion.release_completed' : 'promotion.release_partially_completed',
        priorStatus: plan.release.from, newStatus: plan.release.to, releaseVersion: plan.release.version,
        summary: `Release ${plan.release.version} ${plan.release.from} → ${plan.release.to}`,
      })
    }
  }

  // ── 5) Stamp the job finalized (idempotency marker) ────────────────────────
  const freshJob = (await getJob(job.id)) ?? job
  freshJob.recordsFinalizedAt = now()
  freshJob.updatedAt = now()
  await saveJob(freshJob)
  await audit({ action: 'reconcile.records_finalized', newStatus: 'finalized', summary: `All records reconciled for ${job.id} (${business.name})` })

  return {
    ok: true, jobId: job.id, action: 'finalized',
    deploymentId: depId, vercelDeploymentId: plan.facts.deploymentId, commit: plan.facts.commit,
    updateStatus, businessId: job.businessId, businessCommit: plan.business.currentCommit,
    releaseStatus, auditIds,
  }
}

/** Sweep completed-but-unfinalized jobs (the reconciler fallback for a lost inline call).
 *  Bounded + idempotent; returns one summary per job it touched. */
export async function reconcileCompletedJobs(input: { actor?: string; source?: string; limit?: number } = {}): Promise<ReconcileSummary[]> {
  const jobs = (await listJobs(input.limit ?? 200)).filter((j) => j.status === 'completed' && !j.recordsFinalizedAt)
  const out: ReconcileSummary[] = []
  for (const job of jobs) {
    out.push(await reconcileJobRecords({ job, actor: input.actor ?? 'system', actorType: 'system', source: input.source ?? 'reconciler' }))
  }
  return out
}
