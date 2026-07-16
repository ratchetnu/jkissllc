// Operion production promotion — pure decision tests (Sprint 2).
import assert from 'node:assert/strict'
import test from 'node:test'
import { canPromote, promotionDriftDetected, promotionStage, PROMOTION_STAGES, PROMOTION_ACTIVE } from '../app/lib/platform/automation/promotion'

const ready = { status: 'awaiting_owner_review', approvedCommit: 'abc', targetCommit: 'abc', pullRequestNumber: 1, flagEnabled: true, businessAllows: true }

test('canPromote: needs flag + business setting + review state + PR + no drift', () => {
  assert.equal(canPromote(ready).ok, true)
  assert.equal(canPromote({ ...ready, flagEnabled: false }).ok, false)          // flag off
  assert.equal(canPromote({ ...ready, businessAllows: false }).ok, false)        // business off
  assert.equal(canPromote({ ...ready, status: 'preview_ready' }).ok, false)      // wrong state
  assert.equal(canPromote({ ...ready, pullRequestNumber: undefined }).ok, false) // no PR
  assert.equal(canPromote({ ...ready, targetCommit: 'zzz' }).ok, false)          // commit drift
})

test('canPromote: default-off flags block promotion (the safe state)', () => {
  const r = canPromote({ ...ready, flagEnabled: false })
  assert.equal(r.ok, false); assert.match(r.reason ?? '', /disabled/)
})

test('promotionDriftDetected', () => {
  assert.equal(promotionDriftDetected('abc', 'abc'), false)
  assert.equal(promotionDriftDetected('abc', 'def'), true)
  assert.equal(promotionDriftDetected(undefined, 'def'), false)
})

test('promotionStage walks Approved → Merging → Deploying → Verifying → Live', () => {
  assert.equal(PROMOTION_STAGES.length, 5)
  assert.deepEqual(promotionStage('approved_for_production'), { reached: 0, failedAt: null })
  assert.deepEqual(promotionStage('merging'), { reached: 1, failedAt: null })
  assert.deepEqual(promotionStage('production_deploying'), { reached: 2, failedAt: null })
  assert.deepEqual(promotionStage('verifying'), { reached: 3, failedAt: null })
  assert.deepEqual(promotionStage('completed'), { reached: 4, failedAt: null })
  assert.equal(promotionStage('rollback_required').failedAt, 3)
  assert.equal(promotionStage('failed').failedAt, 1)
})

test('PROMOTION_ACTIVE covers the in-flight states only', () => {
  for (const s of ['approved_for_production', 'merging', 'production_deploying', 'verifying']) assert.equal(PROMOTION_ACTIVE.has(s), true)
  for (const s of ['completed', 'awaiting_owner_review', 'rolled_back']) assert.equal(PROMOTION_ACTIVE.has(s), false)
})
