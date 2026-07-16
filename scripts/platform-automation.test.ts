// Operion automation — hermetic tests for the pure control-plane logic: state-machine
// invariants (esp. the owner-gated production boundary), preflight gates, server-side
// allowlists, signed callbacks, and the fail-closed provider. No Redis, no network.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canTransition, isTerminal, isActive, stepFor, isProductionApprovalTransition, isProductionPhase, STEP_ORDER,
} from '../app/lib/platform/automation/machine'
import type { AutomationStatus } from '../app/lib/platform/automation/types'
import {
  evaluatePreflight, isRepoAllowed, isBranchAllowed, workBranchFor, commitDriftDetected, automaticRollbackEligible,
} from '../app/lib/platform/automation/preflight'
import { signCallback, verifyCallback, validateCallbackPayload } from '../app/lib/platform/automation/callback'
import { StubProvider, getAutomationProvider } from '../app/lib/platform/automation/provider'
import { automationIdempotencyKey } from '../app/lib/platform/automation/orchestrator'
import type { PlatformUpdate, PlatformBusiness, UpdateCompatibility, ValidationChecklist } from '../app/lib/platform/updates/types'

const T = 1_700_000_000_000
const PASS: ValidationChecklist = { typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed', securityReview: 'not_applicable', accessibilityReview: 'not_applicable', e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed' }
const ALL_STATUSES: AutomationStatus[] = ['draft', 'validating', 'blocked', 'queued', 'creating_branch', 'applying_update', 'testing', 'build_failed', 'preview_deploying', 'preview_ready', 'awaiting_owner_review', 'approved_for_production', 'merging', 'production_deploying', 'verifying', 'completed', 'failed', 'cancelled', 'rollback_required', 'rolling_back', 'rolled_back']

function mkUpdate(p: Partial<PlatformUpdate> = {}): PlatformUpdate {
  return { recordVersion: 1, key: 'UPD-1001', title: 'T', summary: 'S', type: 'design', scope: 'platform_core', severity: 'low', priority: 'normal', status: 'approved', breakingChange: false, migrationRequired: false, environmentChangeRequired: false, secretRequired: false, featureFlagRequired: false, manualPortRequired: true, rollbackSupported: true, validation: PASS, sourceCommit: 'abc1234', createdAt: T, updatedAt: T, ...p }
}
function mkBiz(p: Partial<PlatformBusiness> = {}): PlatformBusiness {
  return { recordVersion: 1, id: 'supercharged', name: 'SC', slug: 'sc', status: 'active', role: 'target', defaultBranch: 'main', releaseChannel: 'beta', updatePolicy: 'owner_approval', updatesPaused: false, manualApprovalRequired: true, autoDeployAllowed: false, healthStatus: 'healthy', configurationStatus: 'ready', githubInstallationId: '123', repositoryOwner: 'ratchetnu', repositoryNameOnly: 'supercharged', automationWorkflowFile: 'operion-update.yml', previewProjectId: 'prj_x', previewDeploymentProvider: 'vercel', createdAt: T, updatedAt: T, ...p }
}
const mkCompat = (p: Partial<UpdateCompatibility> = {}): UpdateCompatibility => ({ recordVersion: 1, updateKey: 'UPD-1001', businessId: 'supercharged', status: 'compatible_with_changes', createdAt: T, updatedAt: T, ...p })

// ── State machine invariants ─────────────────────────────────────────────────
test('production is reachable ONLY via the owner-gated transition', () => {
  // No status other than awaiting_owner_review may transition to approved_for_production.
  for (const s of ALL_STATUSES) {
    const legal = canTransition(s, 'approved_for_production')
    assert.equal(legal, s === 'awaiting_owner_review', `${s} → approved_for_production should be ${s === 'awaiting_owner_review'}`)
  }
  assert.equal(isProductionApprovalTransition('awaiting_owner_review', 'approved_for_production'), true)
  assert.equal(isProductionApprovalTransition('preview_ready', 'approved_for_production'), false)
})

test('preview_ready does NOT auto-advance to production; it goes to owner review only', () => {
  assert.equal(canTransition('preview_ready', 'awaiting_owner_review'), true)
  assert.equal(canTransition('preview_ready', 'approved_for_production'), false)
  assert.equal(canTransition('preview_ready', 'merging'), false)
})

test('transitions, terminality, steps', () => {
  assert.equal(canTransition('draft', 'validating'), true)
  assert.equal(canTransition('completed', 'merging'), false)
  assert.equal(canTransition('failed', 'queued'), true)          // retry
  assert.equal(isTerminal('completed'), true)
  assert.equal(isTerminal('awaiting_owner_review'), false)
  assert.equal(isActive('preview_deploying'), true)
  assert.equal(stepFor('awaiting_owner_review'), 'owner_review')
  assert.equal(isProductionPhase('merging'), true)
  assert.equal(isProductionPhase('preview_ready'), false)
  assert.equal(STEP_ORDER[0], 'preflight')
})

// ── Preflight ────────────────────────────────────────────────────────────────
const flagsOn = { automation: true, preview: true, githubActions: true }
test('preflight passes when everything is green', () => {
  const r = evaluatePreflight({ update: mkUpdate(), business: mkBiz(), compat: mkCompat(), hasActiveJob: false, flags: flagsOn })
  assert.equal(r.ok, true, JSON.stringify(r.gates.filter(g => !g.ok)))
})
test('preflight blocks when automation off / not approved / no commit / unassessed / blocked / conflicting / not configured', () => {
  const base = { business: mkBiz(), compat: mkCompat(), hasActiveJob: false, flags: flagsOn }
  const fail = (id: string, x: Parameters<typeof evaluatePreflight>[0]) => { const r = evaluatePreflight(x); assert.equal(r.ok, false); assert.ok(r.gates.find(g => g.id === id && !g.ok), `expected failed gate ${id}`) }
  fail('automation_enabled', { ...base, update: mkUpdate(), flags: { ...flagsOn, automation: false } })
  fail('update_approved', { ...base, update: mkUpdate({ status: 'discovered' }) })
  fail('source_commit', { ...base, update: mkUpdate({ sourceCommit: undefined }) })
  fail('compat_assessed', { ...base, update: mkUpdate(), compat: mkCompat({ status: 'under_review' }) })
  fail('compat_not_blocked', { ...base, update: mkUpdate(), compat: mkCompat({ status: 'incompatible' }) })
  fail('no_conflicting_job', { ...base, update: mkUpdate(), hasActiveJob: true })
  fail('target_configured', { ...base, update: mkUpdate(), business: mkBiz({ configurationStatus: 'not_configured' }) })
  fail('migration_approved', { ...base, update: mkUpdate({ migrationRequired: true }) })
  fail('env_approved', { ...base, update: mkUpdate({ secretRequired: true }) })
})
test('preflight: risky changes pass once explicitly approved', () => {
  const r = evaluatePreflight({ update: mkUpdate({ migrationRequired: true, secretRequired: true }), business: mkBiz(), compat: mkCompat(), hasActiveJob: false, flags: flagsOn, approvals: { migration: true, environment: true } })
  assert.equal(r.ok, true)
})

// ── Allowlists / drift / rollback ────────────────────────────────────────────
test('repo + branch allowlists reject anything unregistered', () => {
  const b = mkBiz({ allowedTargetBranches: ['main'] })
  assert.equal(isRepoAllowed(b, 'ratchetnu', 'supercharged'), true)
  assert.equal(isRepoAllowed(b, 'evil', 'supercharged'), false)
  assert.equal(isRepoAllowed(b, 'ratchetnu', 'other'), false)
  assert.equal(isBranchAllowed(b, 'main', 'target'), true)
  assert.equal(isBranchAllowed(b, 'attacker-branch', 'target'), false)
  assert.equal(workBranchFor('UPD-1001'), 'operion/upd-1001')
  assert.equal(workBranchFor('../../etc/passwd'), 'operion/------etc-passwd')  // sanitized: no slashes/dots, no path traversal
})
test('commit drift + automatic rollback eligibility', () => {
  assert.equal(commitDriftDetected('abc', 'abc'), false)
  assert.equal(commitDriftDetected('abc', 'def'), true)
  assert.equal(automaticRollbackEligible({ enabled: true, rollbackWorkflowFile: 'rb.yml', irreversibleMigration: false, previousVerifiedCommit: 'v1' }), true)
  assert.equal(automaticRollbackEligible({ enabled: false, rollbackWorkflowFile: 'rb.yml', irreversibleMigration: false, previousVerifiedCommit: 'v1' }), false)
  assert.equal(automaticRollbackEligible({ enabled: true, rollbackWorkflowFile: 'rb.yml', irreversibleMigration: true, previousVerifiedCommit: 'v1' }), false)  // irreversible migration
})

// ── Signed callbacks ─────────────────────────────────────────────────────────
test('callback signature verify: valid, bad sig, stale, missing secret', () => {
  const secret = 's3cr3t'; const body = '{"deliveryId":"d1","jobId":"AUTO-1001","status":"preview_ready"}'; const ts = String(T)
  const sig = signCallback(body, ts, secret)
  assert.equal(verifyCallback(body, ts, sig, secret, T).ok, true)
  assert.equal(verifyCallback(body, ts, 'deadbeef', secret, T).ok, false)               // bad sig
  assert.equal(verifyCallback(body, ts, sig, secret, T + 10 * 60_000).ok, false)         // stale (replay window)
  assert.equal(verifyCallback(body, ts, sig, undefined, T).ok, false)                    // no secret configured
  assert.equal(verifyCallback(body, ts, sig, 'wrong', T).ok, false)                      // wrong secret
})
test('callback payload schema rejects malformed', () => {
  assert.equal(validateCallbackPayload({ deliveryId: 'd', jobId: 'j', status: 'preview_ready' }).ok, true)
  assert.equal(validateCallbackPayload({ jobId: 'j', status: 'preview_ready' }).ok, false)      // missing deliveryId
  assert.equal(validateCallbackPayload({ deliveryId: 'd', jobId: 'j', status: 'PROMOTE' }).ok, false) // bad status (no promote path!)
  assert.equal(validateCallbackPayload('nope').ok, false)
})

// ── Provider fails closed ────────────────────────────────────────────────────
test('StubProvider fails closed on every write op; getAutomationProvider returns stub without a GitHub App', async () => {
  const p = new StubProvider()
  const r = await p.dispatchWorkflow('1', { owner: 'o', name: 'n' }, 'wf.yml', 'main', {})
  assert.equal(r.ok, false)
  assert.equal((await p.promoteProduction('prj', 'dep')).ok, false)
  assert.equal(getAutomationProvider({}).name, 'stub')                        // no GITHUB_APP_* → stub
  assert.equal(getAutomationProvider({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k' }).name, 'stub') // live provider deferred → still stub
})

test('idempotency key is deterministic per (business, update, commit)', () => {
  assert.equal(automationIdempotencyKey('sc', 'UPD-1', 'abc'), automationIdempotencyKey('sc', 'UPD-1', 'abc'))
  assert.notEqual(automationIdempotencyKey('sc', 'UPD-1', 'abc'), automationIdempotencyKey('sc', 'UPD-1', 'def'))
})
