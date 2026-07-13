// Modify Estimate validation + duplicate-send / idempotency guards.
import assert from 'node:assert/strict'
import test from 'node:test'

import { validateEstimateModification } from '../app/lib/estimate-modify'
import { transition, canTransition } from '../app/lib/platform/approvals/machine'
import type { ApprovalRequest } from '../app/lib/platform/approvals/types'

test('modify: a valid change passes', () => {
  assert.deepEqual(validateEstimateModification({ overriddenUsd: 650, loadMin: 0.5, loadMax: 0.75, laborUsd: 200, disposalUsd: 120, trips: 1, reason: 'access harder than photos showed' }), { ok: true })
})

test('modify: reason is required', () => {
  const r = validateEstimateModification({ overriddenUsd: 650, reason: '  ' })
  assert.equal(r.ok, false)
})

test('modify: final amount must be > 0', () => {
  assert.equal(validateEstimateModification({ overriddenUsd: 0, reason: 'x' }).ok, false)
  assert.equal(validateEstimateModification({ reason: 'x' }).ok, false)
})

test('modify: rejects negatives and invalid ranges', () => {
  assert.equal(validateEstimateModification({ overriddenUsd: 650, disposalUsd: -5, reason: 'x' }).ok, false)
  assert.equal(validateEstimateModification({ overriddenUsd: 650, loadMin: 0.8, loadMax: 0.5, reason: 'x' }).ok, false)
  assert.equal(validateEstimateModification({ overriddenUsd: 650, trips: 1.5, reason: 'x' }).ok, false)
})

const approved = (): ApprovalRequest => ({
  id: 'appr_1', tenantId: 'jkiss', requestedAction: 'quote.send', requestingWorkerId: 'ai-sales',
  approverRole: 'admin', riskClass: 'medium', actionPreview: 'x', explanation: 'y', evidence: [],
  confidence: 0.6, expectedImpact: 'z', expiresAt: 9e12, status: 'approved', decidedBy: 'owner', createdAt: 1,
})

test('duplicate send / repeat approval is illegal (state machine)', () => {
  // Once approved (quote sent), it cannot be approved again → prevents a duplicate send.
  assert.equal(canTransition('approved', 'approved'), false)
  assert.throws(() => transition(approved(), 'approved', { decidedBy: 'owner' }), /illegal approval transition/)
  // Nor can a rejected one be re-approved.
  assert.equal(canTransition('rejected', 'approved'), false)
})
