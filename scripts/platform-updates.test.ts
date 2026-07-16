// Operion Update Center — hermetic tests for the pure policy, prompt generator, and
// owner-gate logic. No Redis, no clock (now is passed in).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseVersion, compareVersions, isPending, isTerminal, canTransitionUpdate,
  ageDays, agingBucket, computeUpdateKpis, deploymentGatesPass, canMarkVerified,
  updateReleaseEligible, compatRollup, businessesBehind, computeAttention,
} from '../app/lib/platform/updates/policy'
import { buildDeploymentPrompt } from '../app/lib/platform/updates/prompt'
import { isPlatformOwner } from '../app/api/admin/_lib/session'
import type { PlatformUpdate, PlatformBusiness, DeploymentRecord, UpdateCompatibility, ValidationChecklist } from '../app/lib/platform/updates/types'

const T = 1_700_000_000_000
const DAY = 86_400_000
const PASS: ValidationChecklist = { typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed', securityReview: 'not_applicable', accessibilityReview: 'not_applicable', e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed' }

function mkUpdate(p: Partial<PlatformUpdate> = {}): PlatformUpdate {
  return {
    recordVersion: 1, key: 'UPD-1001', title: 'T', summary: 'S', type: 'feature', scope: 'platform_core',
    severity: 'medium', priority: 'normal', status: 'discovered', breakingChange: false, migrationRequired: false,
    environmentChangeRequired: false, secretRequired: false, featureFlagRequired: false, manualPortRequired: false,
    rollbackSupported: true, validation: PASS, createdAt: T, updatedAt: T, ...p,
  }
}
function mkBiz(p: Partial<PlatformBusiness> = {}): PlatformBusiness {
  return {
    recordVersion: 1, id: 'b', name: 'B', slug: 'b', status: 'active', role: 'target', defaultBranch: 'main',
    releaseChannel: 'stable', updatePolicy: 'owner_approval', updatesPaused: false, manualApprovalRequired: true,
    autoDeployAllowed: false, healthStatus: 'healthy', createdAt: T, updatedAt: T, ...p,
  }
}

// ── Version ──────────────────────────────────────────────────────────────────
test('version parse + compare (with v prefix, missing parts)', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: undefined })
  assert.deepEqual(parseVersion('2'), { major: 2, minor: 0, patch: 0, pre: undefined })
  assert.equal(parseVersion('nope'), null)
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1)
  assert.equal(compareVersions('v2.0.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions(undefined, '1.0.0'), -1)  // unknown sorts lowest
})

// ── Status / transitions ─────────────────────────────────────────────────────
test('pending/terminal + transition rules', () => {
  assert.equal(isPending('blocked'), true)
  assert.equal(isPending('fully_deployed'), false)
  assert.equal(isTerminal('archived'), true)
  assert.equal(canTransitionUpdate('discovered', 'approved'), true)
  assert.equal(canTransitionUpdate('approved', 'approved'), false)     // no-op rejected
  assert.equal(canTransitionUpdate('archived', 'discovered'), false)   // archived is locked
})

// ── Aging ────────────────────────────────────────────────────────────────────
test('aging days + buckets', () => {
  assert.equal(ageDays(T - 5 * DAY, T), 5)
  assert.equal(agingBucket(T, T), 'today')
  assert.equal(agingBucket(T - 2 * DAY, T), '1-3d')
  assert.equal(agingBucket(T - 10 * DAY, T), '8-14d')
  assert.equal(agingBucket(T - 40 * DAY, T), '30d+')
})

// ── KPIs ─────────────────────────────────────────────────────────────────────
test('KPI rollup counts pending, blocked, aging, older-than-14', () => {
  const updates = [
    mkUpdate({ key: 'a', status: 'partially_deployed', updatedAt: T - 20 * DAY }),  // pending, stale
    mkUpdate({ key: 'b', status: 'blocked', updatedAt: T - 2 * DAY }),
    mkUpdate({ key: 'c', status: 'ready_for_review' }),
    mkUpdate({ key: 'd', status: 'fully_deployed' }),                                // not pending
  ]
  const k = computeUpdateKpis(updates, T)
  assert.equal(k.total, 4)
  assert.equal(k.pending, 3)             // a, b, c
  assert.equal(k.blocked, 1)
  assert.equal(k.readyForReview, 1)
  assert.equal(k.fullyDeployed, 1)
  assert.equal(k.olderThan14, 1)         // a
  assert.equal(k.byAging['30d+'] + k.byAging['15-30d'], 1)
})

// ── Verification gates ───────────────────────────────────────────────────────
test('deployment gates + verify (pass, waive, refuse)', () => {
  assert.equal(deploymentGatesPass({ buildStatus: 'passed', healthCheckStatus: 'passed', smokeTestStatus: 'passed' }), true)
  assert.equal(deploymentGatesPass({ buildStatus: 'passed', healthCheckStatus: 'failed', smokeTestStatus: 'passed' }), false)
  assert.equal(canMarkVerified({ buildStatus: 'passed', healthCheckStatus: 'passed', smokeTestStatus: 'skipped' }), true)
  assert.equal(canMarkVerified({ buildStatus: 'unknown', healthCheckStatus: 'unknown', smokeTestStatus: 'unknown' }), false) // no gates, no waiver
  assert.equal(canMarkVerified({ buildStatus: 'failed', healthCheckStatus: 'failed', smokeTestStatus: 'failed' }, 'owner accepts risk'), true) // waived
})

// ── Release eligibility ──────────────────────────────────────────────────────
test('release eligibility requires approval + tests + build', () => {
  assert.equal(updateReleaseEligible(mkUpdate({ status: 'approved' })).eligible, true)
  assert.equal(updateReleaseEligible(mkUpdate({ status: 'discovered' })).eligible, false)
  assert.equal(updateReleaseEligible(mkUpdate({ status: 'approved', validation: { ...PASS, tests: 'failed' } })).eligible, false)
  assert.equal(updateReleaseEligible(mkUpdate({ status: 'approved', migrationRequired: true, rollbackSupported: false })).eligible, false)
})

// ── Compatibility rollup + behind ────────────────────────────────────────────
test('compat rollup + businessesBehind', () => {
  const compats: UpdateCompatibility[] = [
    { recordVersion: 1, updateKey: 'a', businessId: 'x', status: 'compatible', createdAt: T, updatedAt: T },
    { recordVersion: 1, updateKey: 'a', businessId: 'y', status: 'compatible_with_changes', createdAt: T, updatedAt: T },
    { recordVersion: 1, updateKey: 'a', businessId: 'z', status: 'blocked', createdAt: T, updatedAt: T },
  ]
  const r = compatRollup(compats)
  assert.equal(r.compatible, 1); assert.equal(r.withChanges, 1); assert.equal(r.blocked, 1)
  const behind = businessesBehind([mkBiz({ id: 'a', role: 'target', currentVersion: '1.0.0' }), mkBiz({ id: 'b', role: 'target', currentVersion: '2.0.0' })], '2.0.0')
  assert.deepEqual(behind.map((b) => b.id), ['a'])
})

// ── Attention ────────────────────────────────────────────────────────────────
test('attention surfaces blocked, review, failed deployment, awaiting verification', () => {
  const updates = [mkUpdate({ key: 'a', status: 'blocked' }), mkUpdate({ key: 'b', status: 'ready_for_review' })]
  const deployments: DeploymentRecord[] = [
    { recordVersion: 1, id: 'd1', businessId: 'x', updateKeys: ['a'], status: 'failed', verificationStatus: 'pending', rollbackAvailable: false, createdAt: T, updatedAt: T },
    { recordVersion: 1, id: 'd2', businessId: 'y', updateKeys: ['b'], status: 'deployed', verificationStatus: 'pending', rollbackAvailable: true, createdAt: T, updatedAt: T },
  ]
  const a = computeAttention(updates, deployments, T)
  const kinds = a.map((x) => x.kind)
  assert.ok(kinds.includes('blocked'))
  assert.ok(kinds.includes('review'))
  assert.ok(kinds.includes('deploy_failed'))
  assert.ok(kinds.includes('await_verify'))
})

// ── Prompt generator ─────────────────────────────────────────────────────────
test('deployment prompt embeds metadata + safety guardrails, excludes flagged components', () => {
  const source = mkBiz({ id: 'jkiss', name: 'J KISS LLC', role: 'source', repoName: 'ratchetnu/jkissllc' })
  const target = mkBiz({ id: 'supercharged', name: 'Supercharged Enterprises', repoName: 'x/supercharged', productionUrl: 'https://sc.com' })
  const upd = mkUpdate({ key: 'UPD-1', title: 'Booking redesign', sourceCommit: '14827b7', featureFlagRequired: true })
  const compat: UpdateCompatibility[] = [{ recordVersion: 1, updateKey: 'UPD-1', businessId: 'supercharged', status: 'compatible_with_changes', reason: 'branding', componentsToExclude: ['jkiss-logo'], createdAt: T, updatedAt: T }]
  const p = buildDeploymentPrompt({ updates: [upd], source, target, compat })
  assert.ok(p.includes('J KISS LLC → Supercharged Enterprises'))
  assert.ok(p.includes('14827b7'))
  assert.ok(p.includes('x/supercharged'))
  assert.ok(p.includes('EXCLUDE all source secrets'))          // guardrail present
  assert.ok(p.includes('jkiss-logo'))                          // excluded component surfaced
  assert.ok(p.includes('do NOT deploy if any fails') || p.includes('do NOT deploy'))
  assert.ok(!p.includes('${'))                                 // no un-interpolated template holes
})

// ── Owner gate ───────────────────────────────────────────────────────────────
test('isPlatformOwner: owner admin yes; named admin only via allowlist; manager/crew never', () => {
  assert.equal(isPlatformOwner({ sub: 'owner', role: 'admin' }, {}), true)
  assert.equal(isPlatformOwner({ sub: 'nunu', role: 'admin' }, {}), false)                              // named admin, not allowlisted
  assert.equal(isPlatformOwner({ sub: 'nunu', role: 'admin' }, { PLATFORM_OWNER_SUBS: 'nunu, other' }), true)
  assert.equal(isPlatformOwner({ sub: 'owner', role: 'manager' }, {}), false)                           // wrong role
  assert.equal(isPlatformOwner({ sub: 'someone', role: 'crew' }, { PLATFORM_OWNER_SUBS: 'someone' }), false)
  assert.equal(isPlatformOwner(null, {}), false)
})
