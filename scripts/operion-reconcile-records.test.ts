// Operion post-deployment reconciliation — pure decision tests.
// Covers the finalize.ts decision core: deployment facts, update/release status roll-ups,
// business provenance, the full finalization plan, and external deployment matching.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  productionCommit, deploymentFactsFromJob, deriveDeploymentPatch,
  deriveUpdateStatus, deriveReleaseStatus, deriveBusinessProvenance,
  finalizationPlan, resolveDeploymentMatch, commitMatches,
  type JobFacts,
} from '../app/lib/platform/automation/finalize'
import type { DeploymentRecord } from '../app/lib/platform/updates/types'

const NOW = 1_700_000_000_000

const baseJob: JobFacts = {
  id: 'AUTO-1001', updateId: 'UPD-1006', businessId: 'supercharged', status: 'completed',
  productionDeploymentId: 'dpl_7GRq', productionUrl: 'https://sc.example.app',
  mergeCommit: 'dd8f6586d5aa', approvedCommit: '37d3e9697b', targetCommit: '37d3e9697b',
  approvedBy: 'owner', completedAt: NOW,
}

// ── production commit precedence ──────────────────────────────────────────────
test('productionCommit prefers merge → approved → target', () => {
  assert.equal(productionCommit({ mergeCommit: 'm', approvedCommit: 'a', targetCommit: 't' }), 'm')
  assert.equal(productionCommit({ approvedCommit: 'a', targetCommit: 't' }), 'a')
  assert.equal(productionCommit({ targetCommit: 't' }), 't')
  assert.equal(productionCommit({}), undefined)
})

// ── deployment facts + patch ──────────────────────────────────────────────────
test('a completed job yields deployed + verified facts (build/health passed)', () => {
  const f = deploymentFactsFromJob(baseJob, NOW)
  assert.equal(f.deploymentId, 'dpl_7GRq')
  assert.equal(f.commit, 'dd8f6586d5aa')
  assert.equal(f.buildPassed, true)
  assert.equal(f.healthPassed, true)
  assert.equal(f.smokePassed, undefined) // no smoke reported ⇒ not applicable
  assert.equal(f.verifiedAt, NOW)
})

test('deriveDeploymentPatch marks deployed+passed; smoke undefined ⇒ not_applicable', () => {
  const p = deriveDeploymentPatch(deploymentFactsFromJob(baseJob, NOW))
  assert.equal(p.status, 'deployed')
  assert.equal(p.verificationStatus, 'passed')
  assert.equal(p.buildStatus, 'passed')
  assert.equal(p.healthCheckStatus, 'passed')
  assert.equal(p.smokeTestStatus, 'not_applicable')
  assert.equal(p.rollbackAvailable, true)
  assert.equal(p.deploymentId, 'dpl_7GRq')
})

test('smoke failure carries through to failed check', () => {
  const j: JobFacts = { ...baseJob, result: { smokePassed: false } }
  assert.equal(deriveDeploymentPatch(deploymentFactsFromJob(j, NOW)).smokeTestStatus, 'failed')
})

// ── update status roll-up ─────────────────────────────────────────────────────
test('single required target verified ⇒ fully_deployed', () => {
  const d = deriveUpdateStatus(['supercharged'], ['supercharged'])
  assert.equal(d.to, 'fully_deployed')
})

test('one of two required targets verified ⇒ partially_deployed', () => {
  const d = deriveUpdateStatus(['supercharged', 'jkiss'], ['supercharged'])
  assert.equal(d.to, 'partially_deployed')
  assert.match(d.reason, /jkiss/)
})

test('extra verified target not in required set does not over-count', () => {
  const d = deriveUpdateStatus(['supercharged', 'jkiss'], ['supercharged', 'other'])
  assert.equal(d.to, 'partially_deployed')
})

// ── release status roll-up ────────────────────────────────────────────────────
test('release: all verified ⇒ completed; some ⇒ partially_completed; all failed ⇒ failed', () => {
  assert.equal(deriveReleaseStatus([{ businessId: 'a', state: 'verified' }, { businessId: 'b', state: 'verified' }]).to, 'completed')
  assert.equal(deriveReleaseStatus([{ businessId: 'a', state: 'verified' }, { businessId: 'b', state: 'pending' }]).to, 'partially_completed')
  assert.equal(deriveReleaseStatus([{ businessId: 'a', state: 'failed' }]).to, 'failed')
  assert.equal(deriveReleaseStatus([{ businessId: 'a', state: 'verified' }, { businessId: 'b', state: 'failed' }]).to, 'partially_completed')
})

// ── business provenance ───────────────────────────────────────────────────────
test('business provenance always sets commit + timestamps; version only from a release', () => {
  const facts = deploymentFactsFromJob(baseJob, NOW)
  const noRel = deriveBusinessProvenance({ facts })
  assert.equal(noRel.currentCommit, 'dd8f6586d5aa')
  assert.equal(noRel.latestVerifiedCommit, 'dd8f6586d5aa')
  assert.equal(noRel.currentVersion, undefined) // never invent a version
  assert.equal(noRel.lastDeploymentAt, NOW)
  assert.equal(noRel.lastVerificationAt, NOW)
  assert.equal(noRel.healthStatus, 'healthy')

  const withRel = deriveBusinessProvenance({ facts, releaseVersion: 'v1.4.0' })
  assert.equal(withRel.currentVersion, 'v1.4.0')
  assert.equal(withRel.latestVerifiedVersion, 'v1.4.0')
})

// ── full plan (the live Supercharged case) ────────────────────────────────────
test('finalizationPlan for the Supercharged promotion: create deployment, fully_deployed, commit updated', () => {
  const plan = finalizationPlan({
    job: baseJob,
    update: { key: 'UPD-1006', status: 'in_progress' },
    existingDeployment: null,
    requiredTargets: ['supercharged'],
    verifiedTargets: ['supercharged'],
    release: null, releaseTargets: null, now: NOW,
  })
  assert.equal(plan.deployment.create, true)
  assert.equal(plan.deployment.patch.status, 'deployed')
  assert.deepEqual(plan.update, { key: 'UPD-1006', from: 'in_progress', to: 'fully_deployed' })
  assert.equal(plan.business.currentCommit, 'dd8f6586d5aa')
  assert.equal(plan.release, null)
  const actions = plan.audits.map(a => a.action)
  assert.ok(actions.includes('promotion.update_fully_deployed'))
  assert.ok(actions.includes('promotion.deployment_verified'))
  assert.ok(actions.includes('promotion.business_commit_updated'))
})

test('finalizationPlan is idempotent-friendly: existing deployment ⇒ update (not create)', () => {
  const existing = { id: 'DEP-1001', automationJobId: 'AUTO-1001' } as unknown as DeploymentRecord
  const plan = finalizationPlan({
    job: baseJob, update: { key: 'UPD-1006', status: 'fully_deployed' }, existingDeployment: existing,
    requiredTargets: ['supercharged'], verifiedTargets: ['supercharged'], release: null, releaseTargets: null, now: NOW,
  })
  assert.equal(plan.deployment.create, false)
  // already fully_deployed ⇒ same status, no phantom transition
  assert.equal(plan.update?.from, plan.update?.to)
})

// ── external deployment matching (Phase 4) ────────────────────────────────────
test('commitMatches tolerates short/long SHAs', () => {
  assert.equal(commitMatches('dd8f658', 'dd8f6586d5aa'), true)
  assert.equal(commitMatches('dd8f6586d5aa', 'dd8f658'), true)
  assert.equal(commitMatches('dd8f658', 'ffffffff'), false)
  assert.equal(commitMatches(undefined, 'dd8f658'), false)
})

test('resolveDeploymentMatch: unique / ambiguous / none', () => {
  const ready = (id: string, commit: string) => ({ deploymentId: id, commit, ready: true, failed: false })
  assert.deepEqual(
    resolveDeploymentMatch([ready('dpl_a', 'dd8f6586'), ready('dpl_b', 'cccccccc')], 'dd8f658'),
    { kind: 'unique', deploymentId: 'dpl_a', reason: 'matched commit dd8f658' },
  )
  assert.equal(resolveDeploymentMatch([ready('dpl_a', 'dd8f658'), ready('dpl_b', 'dd8f658')], 'dd8f658').kind, 'ambiguous')
  assert.equal(resolveDeploymentMatch([ready('dpl_a', 'cccccccc')], 'dd8f658').kind, 'none')
  // a matching commit that isn't ready must not match
  assert.equal(resolveDeploymentMatch([{ deploymentId: 'dpl_a', commit: 'dd8f658', ready: false }], 'dd8f658').kind, 'none')
  assert.equal(resolveDeploymentMatch([ready('dpl_a', 'dd8f658')], undefined).kind, 'none')
})
