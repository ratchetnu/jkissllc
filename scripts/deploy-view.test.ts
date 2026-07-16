// Operion one-click deploy view model + reconciler — pure tests.
import assert from 'node:assert/strict'
import test from 'node:test'
import { deployPrimary, deployStage, isTransientFailure, isOwnerRetryable, failureExplanation, DEPLOY_STAGES } from '../app/lib/platform/automation/deploy-view'
import { reconcileDecision } from '../app/lib/platform/automation/reconcile'

test('isTransientFailure: only infra categories auto-retry', () => {
  for (const c of ['timeout', 'provider_error', 'internal_error']) assert.equal(isTransientFailure(c), true, c)
  for (const c of ['tests_failed', 'build_failed', 'apply_failed', 'preview_failed', 'commit_drift', 'merge_conflict', undefined]) assert.equal(isTransientFailure(c), false, String(c))
})

test('isOwnerRetryable: code/transfer failures retryable; drift/conflict not', () => {
  assert.equal(isOwnerRetryable('preview_failed', 'preview_failed'), true)   // the pilot lint case
  assert.equal(isOwnerRetryable('failed', undefined), true)
  assert.equal(isOwnerRetryable('build_failed', 'build_failed'), true)
  assert.equal(isOwnerRetryable('failed', 'commit_drift'), false)
  assert.equal(isOwnerRetryable('failed', 'merge_conflict'), false)
  assert.equal(isOwnerRetryable('awaiting_owner_review', undefined), false)  // not a failure
})

test('deployPrimary: one adaptive action per state', () => {
  assert.deepEqual(deployPrimary(null, true), { kind: 'deploy', label: 'Deploy Preview' })
  assert.deepEqual(deployPrimary(null, false), { kind: 'fix', label: 'Fix configuration' })
  assert.equal(deployPrimary({ status: 'creating_branch' }, true).kind, 'running')
  assert.equal(deployPrimary({ status: 'awaiting_owner_review' }, true).kind, 'review')
  assert.equal(deployPrimary({ status: 'preview_ready' }, true).kind, 'review')
  // The pilot: failed on lint → Retry Preview (not a fresh Prepare).
  assert.deepEqual(deployPrimary({ status: 'failed', failureCategory: 'preview_failed' }, true), { kind: 'retry', label: 'Retry Preview' })
  assert.equal(deployPrimary({ status: 'failed', failureCategory: 'commit_drift' }, true).kind, 'regenerate')
  assert.equal(deployPrimary({ status: 'approved_for_production' }, true).kind, 'approved')
})

test('deployStage: friendly 6-stage mapping incl. failed-at from lint result', () => {
  assert.equal(DEPLOY_STAGES.length, 6)
  assert.deepEqual(deployStage({ status: 'creating_branch' }), { reached: 1, failedAt: null })
  assert.deepEqual(deployStage({ status: 'awaiting_owner_review' }), { reached: 5, failedAt: null })
  // lint failure → preview_failed + lintPassed:false → failed at "Verifying code" (index 2)
  assert.deepEqual(deployStage({ status: 'failed', failureCategory: 'preview_failed', result: { lintPassed: false } }), { reached: 2, failedAt: 2 })
  // real preview build failure (no code gate failure) → "Building Preview" (index 4)
  assert.deepEqual(deployStage({ status: 'preview_failed', failureCategory: 'preview_failed', result: { lintPassed: true, buildPassed: true } }), { reached: 4, failedAt: 4 })
  assert.deepEqual(deployStage({ status: 'build_failed', failureCategory: 'build_failed' }), { reached: 2, failedAt: 2 })
})

test('failureExplanation: plain-English, no raw field names', () => {
  assert.match(failureExplanation({ status: 'failed', failureCategory: 'preview_failed', result: { lintPassed: false } }), /did not pass lint/)
  assert.match(failureExplanation({ status: 'failed', failureCategory: 'tests_failed' }), /did not pass the target’s tests/)
  assert.match(failureExplanation({ status: 'failed', failureCategory: 'timeout' }), /temporary infrastructure error/)
})

// ── reconciler ──
const base = { status: 'creating_branch', startedAt: 1000, heartbeatAt: 1000, attemptCount: 0 }
test('reconcile: run succeeded → await callback', () => {
  assert.equal(reconcileDecision({ job: base, ghRun: { status: 'completed', conclusion: 'success' }, now: 2000 }).action, 'await_callback')
})
test('reconcile: run failed but job still active → finalize (missed callback repair)', () => {
  const d = reconcileDecision({ job: base, ghRun: { status: 'completed', conclusion: 'failure' }, now: 2000 })
  assert.equal(d.action, 'finalize'); assert.equal(d.action === 'finalize' && d.status, 'failed')
})
test('reconcile: silent too long → finalize as timeout', () => {
  const d = reconcileDecision({ job: base, ghRun: { status: 'in_progress', conclusion: null }, now: 1000 + 21 * 60_000 })
  assert.equal(d.action, 'finalize'); assert.equal(d.action === 'finalize' && d.failureCategory, 'timeout')
})
test('reconcile: in progress within budget → none', () => {
  assert.equal(reconcileDecision({ job: base, ghRun: { status: 'in_progress', conclusion: null }, now: 2000 }).action, 'none')
})
test('reconcile: transient failure within budget → auto_retry; exhausted → none', () => {
  assert.equal(reconcileDecision({ job: { ...base, status: 'failed', failureCategory: 'timeout', attemptCount: 0 }, ghRun: null, now: 2000 }).action, 'auto_retry')
  assert.equal(reconcileDecision({ job: { ...base, status: 'failed', failureCategory: 'timeout', attemptCount: 2 }, ghRun: null, now: 2000 }).action, 'none')
  // non-transient failure is never auto-retried
  assert.equal(reconcileDecision({ job: { ...base, status: 'failed', failureCategory: 'tests_failed', attemptCount: 0 }, ghRun: null, now: 2000 }).action, 'none')
})
