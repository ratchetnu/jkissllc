// Approval domain: legal transitions, mandatory human decider, no bypass of
// approval, restricted actions never approvable.
import assert from 'node:assert/strict'
import test from 'node:test'

import { canTransition, transition, nextStatuses, isRestrictedRisk, riskFloorForAction } from '../app/lib/platform/approvals/machine'
import type { ApprovalRequest } from '../app/lib/platform/approvals/types'

function make(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap_1', tenantId: 'jkiss', requestedAction: 'send.reminder', requestingWorkerId: 'ai-workforce',
    approverRole: 'admin', riskClass: 'low', actionPreview: 'Text crew a reminder', explanation: 'Due today',
    evidence: [], confidence: 0.9, expectedImpact: 'low', expiresAt: 0, status: 'pending', createdAt: 0, ...over,
  }
}

test('legal transition pending → approved (with a decider) works', () => {
  const r = transition(make(), 'approved', { decidedBy: 'owner', decisionReason: 'ok' })
  assert.equal(r.status, 'approved')
  assert.equal(r.decidedBy, 'owner')
})

test('illegal transition draft → completed throws', () => {
  assert.throws(() => transition(make({ status: 'draft' }), 'completed'))
})

test('approving without a human decider is refused', () => {
  assert.throws(() => transition(make(), 'approved'), /decidedBy/)
})

test('approval cannot be bypassed: pending → executing is illegal', () => {
  assert.equal(canTransition('pending', 'executing'), false)
  assert.throws(() => transition(make(), 'executing'))
  // The only legal path to execution is via approved.
  assert.equal(canTransition('approved', 'executing'), true)
})

test('restricted (Level-5) actions can never be approved', () => {
  assert.equal(isRestrictedRisk('restricted'), true)
  assert.throws(() => transition(make({ riskClass: 'restricted' }), 'approved', { decidedBy: 'owner' }), /restricted/)
})

test('a prohibited action id floors the risk to restricted', () => {
  assert.equal(riskFloorForAction('record.delete', 'low'), 'restricted')
  assert.equal(riskFloorForAction('send.reminder', 'low'), 'low')
})

test('execution failure carries rollback metadata', () => {
  const approved = transition(make(), 'approved', { decidedBy: 'owner' })
  const executing = transition(approved, 'executing')
  const failed = transition(executing, 'failed', { executionResult: { ok: false, detail: 'provider error' }, rollbackMetadata: { undo: 'none-needed' } })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.executionResult?.ok, false)
  assert.deepEqual(failed.rollbackMetadata, { undo: 'none-needed' })
})

test('terminal statuses have no outgoing transitions', () => {
  for (const s of ['rejected', 'expired', 'completed', 'failed', 'cancelled'] as const) {
    assert.deepEqual(nextStatuses(s), [])
  }
})
