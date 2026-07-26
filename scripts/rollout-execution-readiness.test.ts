import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRolloutExecutionReadiness } from '../app/lib/platform/release/rollout-execution-readiness'
import type { PlatformRelease, ReleasePackage } from '../app/lib/platform/updates/types'
import type { UpdateAutomationJob } from '../app/lib/platform/automation/types'

const now = 1_900_000_000_000
const packageRecord: ReleasePackage = {
  recordVersion: 1,
  id: 'RPK-1001',
  targetProduct: 'supercharged',
  proposedVersion: '1.3.0',
  channel: 'stable',
  classification: 'capability',
  breakingChange: false,
  migration: 'none',
  updateKeys: ['UPD-1', 'UPD-2'],
  status: 'approved',
  blockingReasons: [],
  createdBy: 'owner',
  createdAt: now,
  updatedAt: now,
  approvedBy: 'owner',
  approvedAt: now,
  rolloutId: 'REL-1001',
  rolloutCreatedAt: now,
}
const rollout: PlatformRelease = {
  recordVersion: 1,
  id: 'REL-1001',
  packageId: 'RPK-1001',
  targetProduct: 'supercharged',
  version: '1.3.0',
  channel: 'stable',
  status: 'approved',
  updateKeys: ['UPD-1', 'UPD-2'],
  targetBusinessIds: ['supercharged'],
  createdAt: now,
  updatedAt: now,
}
const job = (id: string, updateId: string, commit = 'abc1234', deployment = 'dpl_preview'): UpdateAutomationJob => ({
  jobVersion: 1,
  id,
  businessId: 'supercharged',
  updateId,
  mode: 'live',
  status: 'awaiting_owner_review',
  strategy: 'commit_transfer',
  attemptCount: 1,
  currentStep: 'owner_review',
  idempotencyKey: id,
  targetCommit: commit,
  previewDeploymentId: deployment,
  createdAt: now,
  updatedAt: now,
})

test('an approved rollout is ready only when every update shares one verified artifact', () => {
  const result = evaluateRolloutExecutionReadiness({
    packageRecord,
    rollout,
    packagePolicyBlockers: [],
    jobs: [job('AUTO-1', 'UPD-1'), job('AUTO-2', 'UPD-2')],
  })
  assert.deepEqual(result, {
    ready: true,
    blockers: [],
    candidate: {
      targetProduct: 'supercharged',
      targetCommit: 'abc1234',
      sourceDeploymentId: 'dpl_preview',
      jobIds: ['AUTO-1', 'AUTO-2'],
      updateKeys: ['UPD-1', 'UPD-2'],
    },
  })
})

test('missing update evidence and mismatched artifacts fail closed', () => {
  const missing = evaluateRolloutExecutionReadiness({
    packageRecord,
    rollout,
    packagePolicyBlockers: [],
    jobs: [job('AUTO-1', 'UPD-1')],
  })
  assert.equal(missing.ready, false)
  if (!missing.ready) assert.deepEqual(missing.blockers.map((item) => item.code), ['UPDATE_CANDIDATE_MISSING'])

  const mismatched = evaluateRolloutExecutionReadiness({
    packageRecord,
    rollout,
    packagePolicyBlockers: [],
    jobs: [job('AUTO-1', 'UPD-1'), job('AUTO-2', 'UPD-2', 'different', 'dpl_other')],
  })
  assert.equal(mismatched.ready, false)
  if (!mismatched.ready) assert.ok(mismatched.blockers.some((item) => item.code === 'CANDIDATE_ARTIFACT_MISMATCH'))
})

test('wrong customer, terminal jobs, and incomplete candidate evidence never count', () => {
  const wrongCustomer = { ...job('AUTO-1', 'UPD-1'), businessId: 'jkiss' }
  const completed = { ...job('AUTO-2', 'UPD-2'), status: 'completed' as const }
  const noDeployment = { ...job('AUTO-3', 'UPD-1'), previewDeploymentId: undefined }
  const result = evaluateRolloutExecutionReadiness({
    packageRecord,
    rollout,
    packagePolicyBlockers: [],
    jobs: [wrongCustomer, completed, noDeployment],
  })
  assert.equal(result.ready, false)
  if (!result.ready) assert.deepEqual(
    result.blockers.map((item) => item.code),
    ['UPDATE_CANDIDATE_MISSING', 'UPDATE_CANDIDATE_MISSING'],
  )
})

test('package policy drift and rollout identity drift both block execution readiness', () => {
  const result = evaluateRolloutExecutionReadiness({
    packageRecord,
    rollout: { ...rollout, targetProduct: 'jkiss', updateKeys: ['UPD-1'] },
    packagePolicyBlockers: ['installed baseline changed'],
    jobs: [job('AUTO-1', 'UPD-1'), job('AUTO-2', 'UPD-2')],
  })
  assert.equal(result.ready, false)
  if (!result.ready) assert.deepEqual(
    result.blockers.map((item) => item.code),
    ['PACKAGE_POLICY_STALE', 'ROLLOUT_IDENTITY_MISMATCH'],
  )
})

test('approval and rollout lifecycle gaps fail closed with explicit reasons', () => {
  const result = evaluateRolloutExecutionReadiness({
    packageRecord: { ...packageRecord, status: 'ready_for_approval', updateKeys: [] },
    rollout: null,
    packagePolicyBlockers: [],
    jobs: [],
  })
  assert.equal(result.ready, false)
  if (!result.ready) assert.deepEqual(
    result.blockers.map((item) => item.code),
    ['PACKAGE_NOT_APPROVED', 'ROLLOUT_MISSING', 'UPDATE_CANDIDATE_MISSING'],
  )

  const unapprovedRollout = evaluateRolloutExecutionReadiness({
    packageRecord,
    rollout: { ...rollout, status: 'draft' },
    packagePolicyBlockers: [],
    jobs: [job('AUTO-1', 'UPD-1'), job('AUTO-2', 'UPD-2')],
  })
  assert.equal(unapprovedRollout.ready, false)
  if (!unapprovedRollout.ready) assert.deepEqual(
    unapprovedRollout.blockers.map((item) => item.code),
    ['ROLLOUT_NOT_APPROVED'],
  )
})

test('newest verified candidate is selected deterministically for each update', () => {
  const old = { ...job('AUTO-OLD', 'UPD-1', 'old1234', 'dpl_old'), updatedAt: now - 10 }
  const result = evaluateRolloutExecutionReadiness({
    packageRecord: { ...packageRecord, updateKeys: ['UPD-1'] },
    rollout: { ...rollout, updateKeys: ['UPD-1'] },
    packagePolicyBlockers: [],
    jobs: [old, job('AUTO-NEW', 'UPD-1')],
  })
  assert.equal(result.ready, true)
  if (result.ready) assert.equal(result.candidate.jobIds[0], 'AUTO-NEW')
})

test('equally recent candidates for different artifacts fail closed regardless of input order', () => {
  const packageOne = { ...packageRecord, updateKeys: ['UPD-1'] }
  const rolloutOne = { ...rollout, updateKeys: ['UPD-1'] }
  const candidateA = job('AUTO-A', 'UPD-1', 'commit-a', 'dpl_a')
  const candidateB = job('AUTO-B', 'UPD-1', 'commit-b', 'dpl_b')

  for (const jobs of [[candidateA, candidateB], [candidateB, candidateA]]) {
    const result = evaluateRolloutExecutionReadiness({
      packageRecord: packageOne,
      rollout: rolloutOne,
      packagePolicyBlockers: [],
      jobs,
    })
    assert.equal(result.ready, false)
    if (!result.ready) assert.deepEqual(
      result.blockers.map((item) => item.code),
      ['CANDIDATE_AMBIGUOUS'],
    )
  }
})

test('equally recent evidence for the same artifact remains deterministic', () => {
  const result = evaluateRolloutExecutionReadiness({
    packageRecord: { ...packageRecord, updateKeys: ['UPD-1'] },
    rollout: { ...rollout, updateKeys: ['UPD-1'] },
    packagePolicyBlockers: [],
    jobs: [job('AUTO-B', 'UPD-1'), job('AUTO-A', 'UPD-1')],
  })
  assert.equal(result.ready, true)
  if (result.ready) {
    assert.equal(result.candidate.jobIds[0], 'AUTO-A')
    assert.equal(result.candidate.targetCommit, 'abc1234')
    assert.equal(result.candidate.sourceDeploymentId, 'dpl_preview')
  }
})
