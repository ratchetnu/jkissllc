// ── Operion post-deployment reconciliation — PURE decision core ──────────────
//
// When an owner-approved production promotion is VERIFIED (the automation job reaches
// `completed`), every related record must reconcile automatically — the owner should
// never hand-set a deployment/update/business/release status again. This module is the
// deterministic decision: given the verified job + the current records, compute exactly
// what each record should become. No I/O, no clock (caller passes `now`) → fully testable.
//
// The applier (reconcile-records.ts) performs the writes; this file decides them. Keeping
// the decision pure means the reconciler and the inline post-promotion path share ONE
// source of truth for "what deployed/verified means for the records."

import type { DeploymentRecord, DeploymentStatus, VerificationStatus, CheckStatus, UpdateStatus, ReleaseStatus } from '../updates/types'
import type { PlatformAuditAction } from '../updates/audit'

// ── Facts extracted from a verified job ──────────────────────────────────────
export type JobFacts = {
  id: string
  updateId: string
  businessId: string
  status: string
  productionDeploymentId?: string
  productionUrl?: string
  mergeCommit?: string
  approvedCommit?: string
  targetCommit?: string
  sourceRepository?: string
  targetRepository?: string
  pullRequestNumber?: number
  pullRequestUrl?: string
  approvedBy?: string
  completedAt?: number
  result?: { buildPassed?: boolean; testsPassed?: boolean; smokePassed?: boolean } | null
  traceId?: string
}

export type DeploymentFacts = {
  deploymentId?: string
  deploymentUrl?: string
  commit?: string             // the commit that reached production
  verifiedAt: number
  buildPassed: boolean
  healthPassed: boolean
  smokePassed?: boolean       // undefined ⇒ smoke tests not run ⇒ not_applicable (not a failure)
}

/** The production commit is the merge commit; fall back to approved/target head. */
export function productionCommit(job: Pick<JobFacts, 'mergeCommit' | 'approvedCommit' | 'targetCommit'>): string | undefined {
  return job.mergeCommit || job.approvedCommit || job.targetCommit || undefined
}

/** Extract the deployment facts for a job that has completed verification. A job only
 *  reaches `completed` after production is READY and the health check passed, so build +
 *  health are true; smoke is carried through only if the workflow reported it. */
export function deploymentFactsFromJob(job: JobFacts, now: number): DeploymentFacts {
  return {
    deploymentId: job.productionDeploymentId,
    deploymentUrl: job.productionUrl,
    commit: productionCommit(job),
    verifiedAt: job.completedAt ?? now,
    buildPassed: true,
    healthPassed: true,
    smokePassed: job.result?.smokePassed,
  }
}

// ── External production-deployment matching (Phase 4) ────────────────────────
// When a production deployment happened outside Operion (or a callback was lost), the
// reconciler must attach the RIGHT Vercel deployment to a pending job before verifying —
// and must NEVER guess when it's ambiguous. Pure so the match rule is testable.
export type DeploymentCandidate = { deploymentId: string; commit?: string; ready?: boolean; failed?: boolean }
export type DeploymentMatch =
  | { kind: 'unique'; deploymentId: string; reason: string }
  | { kind: 'ambiguous'; deploymentIds: string[]; reason: string }
  | { kind: 'none'; reason: string }

/** Commit equality that tolerates short/long SHAs (prefix match either direction). */
export function commitMatches(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const x = a.toLowerCase(), y = b.toLowerCase()
  return x === y || (x.length >= 7 && y.startsWith(x)) || (y.length >= 7 && x.startsWith(y))
}

/** Pick the one ready, non-failed production deployment whose commit matches the expected
 *  merged commit. 0 → none; exactly 1 → unique; >1 → ambiguous (owner attention, never a guess). */
export function resolveDeploymentMatch(candidates: DeploymentCandidate[], expectedCommit: string | undefined): DeploymentMatch {
  if (!expectedCommit) return { kind: 'none', reason: 'no expected commit to match against' }
  const hits = candidates.filter((c) => c.ready && !c.failed && commitMatches(c.commit, expectedCommit))
  if (hits.length === 1) return { kind: 'unique', deploymentId: hits[0].deploymentId, reason: `matched commit ${expectedCommit.slice(0, 10)}` }
  if (hits.length > 1) return { kind: 'ambiguous', deploymentIds: hits.map((h) => h.deploymentId), reason: `${hits.length} deployments match commit ${expectedCommit.slice(0, 10)} — owner must disambiguate` }
  return { kind: 'none', reason: `no ready deployment matches commit ${expectedCommit.slice(0, 10)}` }
}

// ── Update status: fully vs partially deployed ───────────────────────────────
export type UpdateStatusDecision = { to: UpdateStatus; reason: string }

/** An update is fully_deployed only when EVERY required target has a verified deployment;
 *  otherwise partially_deployed. `verifiedTargets` must already include the target that
 *  just verified (the applier adds the current business before calling). */
export function deriveUpdateStatus(requiredTargets: string[], verifiedTargets: string[]): UpdateStatusDecision {
  const req = new Set(requiredTargets)
  // Never let an empty required-set produce a premature "fully_deployed": the applier
  // always seeds the current business into required, so req.size ≥ 1 here.
  const verified = new Set(verifiedTargets.filter((t) => req.has(t)))
  if (req.size > 0 && verified.size >= req.size) {
    return { to: 'fully_deployed', reason: `all ${req.size} required target${req.size === 1 ? '' : 's'} verified` }
  }
  const pending = [...req].filter((t) => !verified.has(t))
  return { to: 'partially_deployed', reason: `${verified.size}/${req.size} verified — pending: ${pending.join(', ') || 'none'}` }
}

// ── Release status roll-up ───────────────────────────────────────────────────
export type ReleaseTargetState = { businessId: string; state: 'verified' | 'pending' | 'failed' }
export type ReleaseStatusDecision = { to: ReleaseStatus; reason: string }

export function deriveReleaseStatus(targets: ReleaseTargetState[]): ReleaseStatusDecision {
  if (!targets.length) return { to: 'partially_completed', reason: 'no targets recorded' }
  const verified = targets.filter((t) => t.state === 'verified').length
  const failed = targets.filter((t) => t.state === 'failed').length
  if (verified === targets.length) return { to: 'completed', reason: `all ${targets.length} target(s) verified` }
  if (failed === targets.length) return { to: 'failed', reason: `all ${targets.length} target(s) failed` }
  return { to: 'partially_completed', reason: `${verified} verified, ${failed} failed, ${targets.length - verified - failed} pending` }
}

// ── Business provenance patch ────────────────────────────────────────────────
export type BusinessProvenancePatch = {
  currentCommit?: string
  latestVerifiedCommit?: string
  currentVersion?: string
  latestVerifiedVersion?: string
  lastDeploymentAt: number
  lastVerificationAt: number
  healthStatus: 'healthy'
}

/** Advance a business's version/commit provenance from a verified deployment. Commit
 *  provenance is always authoritative (we know the exact merged commit). Version fields
 *  are adopted ONLY from an associated release version — we never invent a semver. */
export function deriveBusinessProvenance(input: {
  facts: DeploymentFacts
  releaseVersion?: string
}): BusinessProvenancePatch {
  const at = input.facts.verifiedAt
  const patch: BusinessProvenancePatch = {
    lastDeploymentAt: at,
    lastVerificationAt: at,
    healthStatus: 'healthy',
  }
  if (input.facts.commit) {
    patch.currentCommit = input.facts.commit
    patch.latestVerifiedCommit = input.facts.commit
  }
  if (input.releaseVersion) {
    patch.currentVersion = input.releaseVersion
    patch.latestVerifiedVersion = input.releaseVersion
  }
  return patch
}

// ── Deployment record field patch (create-or-update, idempotent) ─────────────
const check = (b: boolean | undefined): CheckStatus => (b === true ? 'passed' : b === false ? 'failed' : 'not_applicable')

export type DeploymentPatch = {
  status: DeploymentStatus
  verificationStatus: VerificationStatus
  buildStatus: CheckStatus
  healthCheckStatus: CheckStatus
  smokeTestStatus: CheckStatus
  deploymentId?: string
  deploymentUrl?: string
  targetCommit?: string
  verifiedAt: number
  rollbackAvailable: boolean
}

export function deriveDeploymentPatch(facts: DeploymentFacts): DeploymentPatch {
  return {
    status: 'deployed',
    verificationStatus: 'passed',
    buildStatus: check(facts.buildPassed),
    healthCheckStatus: check(facts.healthPassed),
    smokeTestStatus: check(facts.smokePassed),
    deploymentId: facts.deploymentId,
    deploymentUrl: facts.deploymentUrl,
    targetCommit: facts.commit,
    verifiedAt: facts.verifiedAt,
    rollbackAvailable: true,
  }
}

// ── The full plan ────────────────────────────────────────────────────────────
export type AuditIntent = {
  action: PlatformAuditAction
  priorStatus?: string
  newStatus?: string
  commit?: string
  deploymentId?: string
  releaseVersion?: string
  summary: string
}

export type FinalizationPlan = {
  facts: DeploymentFacts
  deployment: { create: boolean; patch: DeploymentPatch }
  update: { key: string; from: UpdateStatus; to: UpdateStatus } | null
  business: BusinessProvenancePatch
  release: { version: string; from: ReleaseStatus; to: ReleaseStatus } | null
  audits: AuditIntent[]
}

/** Compose the complete set of record changes for a verified job. Deterministic:
 *  same inputs → same plan. The applier translates this into idempotent writes. */
export function finalizationPlan(input: {
  job: JobFacts
  update: { key: string; status: UpdateStatus } | null
  existingDeployment: DeploymentRecord | null
  requiredTargets: string[]
  verifiedTargets: string[]
  release: { version: string; status: ReleaseStatus } | null
  releaseTargets: ReleaseTargetState[] | null
  now: number
}): FinalizationPlan {
  const facts = deploymentFactsFromJob(input.job, input.now)
  const deployPatch = deriveDeploymentPatch(facts)
  const business = deriveBusinessProvenance({ facts, releaseVersion: input.release?.version })

  const audits: AuditIntent[] = []
  audits.push({ action: 'promotion.deployment_verified', deploymentId: facts.deploymentId, commit: facts.commit, newStatus: 'verified', summary: `Production deployment ${facts.deploymentId ?? '(unknown)'} verified for ${input.job.businessId}` })
  audits.push({ action: 'promotion.business_commit_updated', commit: facts.commit, summary: `${input.job.businessId} current commit → ${(facts.commit ?? '').slice(0, 10)}` })

  // Update status
  let update: FinalizationPlan['update'] = null
  if (input.update) {
    const decision = deriveUpdateStatus(input.requiredTargets, input.verifiedTargets)
    update = { key: input.update.key, from: input.update.status, to: decision.to }
    if (decision.to === 'fully_deployed') audits.push({ action: 'promotion.update_fully_deployed', priorStatus: input.update.status, newStatus: 'fully_deployed', summary: `${input.update.key} fully deployed — ${decision.reason}` })
    else audits.push({ action: 'promotion.update_partially_deployed', priorStatus: input.update.status, newStatus: 'partially_deployed', summary: `${input.update.key} partially deployed — ${decision.reason}` })
    audits.push({ action: 'promotion.update_target_deployed', newStatus: 'deployed', summary: `${input.update.key} deployed to ${input.job.businessId}` })
  }

  // Release status
  let release: FinalizationPlan['release'] = null
  if (input.release && input.releaseTargets) {
    const decision = deriveReleaseStatus(input.releaseTargets)
    release = { version: input.release.version, from: input.release.status, to: decision.to }
    if (decision.to === 'completed') audits.push({ action: 'promotion.release_completed', priorStatus: input.release.status, newStatus: 'completed', releaseVersion: input.release.version, summary: `Release ${input.release.version} completed — ${decision.reason}` })
    else if (decision.to === 'partially_completed') audits.push({ action: 'promotion.release_partially_completed', priorStatus: input.release.status, newStatus: 'partially_completed', releaseVersion: input.release.version, summary: `Release ${input.release.version} partially completed — ${decision.reason}` })
  }

  return {
    facts,
    deployment: { create: !input.existingDeployment, patch: deployPatch },
    update,
    business,
    release,
    audits,
  }
}
