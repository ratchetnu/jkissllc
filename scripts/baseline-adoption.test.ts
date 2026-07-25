import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  baselineStateLabel,
  deriveBaselineState,
  evaluateBaselineAdoption,
  type AdoptionEvidenceInput,
  type BaselineAdoptionRecord,
} from '../app/lib/platform/release/baseline-adoption'
import { adoptBaseline, dryRunBaselineAdoption } from '../app/lib/platform/release/baseline-adoption-service'
import { evaluateVersionBump } from '../app/lib/platform/release/semver-policy'
import { deriveBusinessProvenance } from '../app/lib/platform/automation/finalize'
import type { PlatformBusiness } from '../app/lib/platform/updates/types'

const business = (patch: Partial<PlatformBusiness> = {}): PlatformBusiness => ({
  recordVersion: 1,
  id: 'supercharged',
  name: 'Supercharged',
  slug: 'supercharged',
  status: 'active',
  role: 'target',
  defaultBranch: 'main',
  releaseChannel: 'stable',
  updatePolicy: 'owner_approval',
  updatesPaused: false,
  manualApprovalRequired: true,
  autoDeployAllowed: false,
  healthStatus: 'healthy',
  currentCommit: 'a'.repeat(40),
  createdAt: 1,
  updatedAt: 1,
  ...patch,
})

const safeEvidence = (patch: Partial<AdoptionEvidenceInput> = {}): AdoptionEvidenceInput => ({
  targetProduct: 'supercharged',
  proposedVersion: '1.0.0',
  deployedCommit: 'a'.repeat(40),
  capabilityManifestHash: 'b'.repeat(64),
  expectedCapabilities: ['booking', 'payments'],
  deployedCapabilities: ['payments', 'booking'],
  deployedCommitEvidence: [{ reference: 'vercel:dpl_prod_1', verified: true }],
  schemaMigration: { state: 'verified', references: ['migration-audit:2026-07-25'] },
  relevantFlags: [{ name: 'BOOKING_ENABLED', expected: true, actual: true, reference: 'production-config:snapshot-1' }],
  verificationEvidence: [{ kind: 'production-smoke', reference: 'check:42', passed: true, verifiedAt: 100 }],
  ...patch,
})

test('provenance distinguishes verified, adopted, and unknown legacy baselines', () => {
  assert.equal(deriveBaselineState(business({ currentVersion: '1.0.0', baselineSource: 'installed_by_release' })), 'verified')
  assert.equal(deriveBaselineState(business({ currentVersion: '1.0.0', baselineSource: 'adopted' })), 'adopted')
  assert.equal(deriveBaselineState(business({ currentVersion: '1.0.0', baselineSource: undefined })), 'unknown')
  assert.equal(deriveBaselineState(business({ currentVersion: undefined, baselineSource: 'adopted' })), 'unknown')
  assert.notEqual(baselineStateLabel('verified'), baselineStateLabel('adopted'))
})

test('dry run returns safe_to_adopt with the complete report and rollback snapshot', () => {
  const result = evaluateBaselineAdoption(business(), safeEvidence())
  assert.equal(result.verdict, 'safe_to_adopt')
  assert.deepEqual(result.matchedCapabilities, ['booking', 'payments'])
  assert.deepEqual(result.missingCapabilities, [])
  assert.deepEqual(result.missingEvidence, [])
  assert.deepEqual(result.conflicts, [])
  assert.equal(result.rollbackSnapshot.currentVersion, undefined)
  assert.equal(result.rollbackSnapshot.currentCommit, 'a'.repeat(40))
  assert.equal(result.rollbackSnapshot.baselineSource, 'unknown')
  assert.deepEqual(result.recordsThatWouldChange, [
    'platform:business:supercharged',
    'platform:baseline-adoption:supercharged:<id>',
  ])
  assert.match(result.fingerprint, /^adopt_/)
})

test('dry run returns needs_review for conflicts', () => {
  const result = evaluateBaselineAdoption(
    business(),
    safeEvidence({
      deployedCapabilities: ['booking'],
      relevantFlags: [{ name: 'BOOKING_ENABLED', expected: true, actual: false, reference: 'production-config:snapshot-1' }],
    }),
  )
  assert.equal(result.verdict, 'needs_review')
  assert.deepEqual(result.missingCapabilities, ['payments'])
  assert.ok(result.conflicts.some(x => x.includes('flag state conflicts')))
})

test('dry run returns insufficient_evidence and never invents missing values', () => {
  const result = evaluateBaselineAdoption(
    business({ currentCommit: undefined }),
    safeEvidence({
      proposedVersion: '',
      deployedCommit: '',
      capabilityManifestHash: '',
      deployedCommitEvidence: [],
      schemaMigration: { state: 'unknown', references: [] },
      verificationEvidence: [],
    }),
  )
  assert.equal(result.verdict, 'insufficient_evidence')
  assert.equal(result.proposedVersion, '')
  assert.equal(result.deployedCommit, '')
  assert.ok(result.missingEvidence.length >= 5)
})

test('dry-run service is read-only', async () => {
  let reads = 0
  const result = await dryRunBaselineAdoption({
    getBusiness: async () => { reads++; return business() },
  }, safeEvidence())
  assert.equal(result.ok, true)
  assert.equal(reads, 1)
})

test('no adoption write occurs without explicit owner approval after dry run', async () => {
  let writes = 0
  const current = business()
  const deps = {
    getBusiness: async () => current,
    persist: async () => { writes++; return 'written' as const },
  }
  const dry = evaluateBaselineAdoption(current, safeEvidence())
  const declined = await adoptBaseline({
    deps, evidence: safeEvidence(), dryRunFingerprint: dry.fingerprint,
    ownerApproved: false, actor: 'owner-1', now: 200,
  })
  assert.equal(declined.ok, false)
  if (!declined.ok) assert.equal(declined.code, 'OWNER_APPROVAL_REQUIRED')
  assert.equal(writes, 0)

  const stale = await adoptBaseline({
    deps, evidence: safeEvidence(), dryRunFingerprint: 'adopt_stale',
    ownerApproved: true, actor: 'owner-1', now: 200,
  })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.code, 'DRY_RUN_CHANGED')
  assert.equal(writes, 0)
})

test('failed or review-needed adoption changes nothing', async () => {
  let writes = 0
  const current = business()
  const evidence = safeEvidence({ deployedCapabilities: ['booking'] })
  const dry = evaluateBaselineAdoption(current, evidence)
  const result = await adoptBaseline({
    deps: {
      getBusiness: async () => current,
      persist: async () => { writes++; return 'written' as const },
    },
    evidence, dryRunFingerprint: dry.fingerprint, ownerApproved: true, actor: 'owner-1', now: 200,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'EVIDENCE_NOT_SAFE')
  assert.equal(writes, 0)
  assert.equal(current.currentVersion, undefined)
})

test('approved safe adoption updates currentVersion and writes a complete adopted record', async () => {
  let persisted: {
    expectedBusiness: PlatformBusiness
    nextBusiness: PlatformBusiness
    record: BaselineAdoptionRecord
  } | undefined
  const current = business()
  const evidence = safeEvidence()
  const dry = evaluateBaselineAdoption(current, evidence)
  const result = await adoptBaseline({
    deps: {
      getBusiness: async () => current,
      persist: async input => { persisted = input; return 'written' },
    },
    evidence, dryRunFingerprint: dry.fingerprint, ownerApproved: true, actor: 'owner-1', now: 200,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.business.currentVersion, '1.0.0')
  assert.equal(result.business.latestVerifiedVersion, '1.0.0')
  assert.equal(result.business.baselineSource, 'adopted')
  assert.equal(result.record.baselineSource, 'adopted')
  assert.equal(result.record.adoptedBy, 'owner-1')
  assert.equal(result.record.adoptedAt, 200)
  assert.equal(result.record.ownerApproval.dryRunFingerprint, dry.fingerprint)
  assert.deepEqual(result.record.rollbackSnapshot, dry.rollbackSnapshot)
  assert.ok(persisted)
})

test('verified finalization remains the other version writer and unknown stays unknown', () => {
  const facts = {
    businessId: 'supercharged',
    updateKey: 'UPD-2000',
    commit: 'c'.repeat(40),
    verifiedAt: 300,
    buildPassed: true,
    healthPassed: true,
  }
  const unknown = deriveBusinessProvenance({ facts })
  assert.equal(unknown.currentVersion, undefined)
  assert.equal(unknown.baselineSource, undefined)
  const verified = deriveBusinessProvenance({ facts, releaseVersion: '1.1.0' })
  assert.equal(verified.currentVersion, '1.1.0')
  assert.equal(verified.latestVerifiedVersion, '1.1.0')
  assert.equal(verified.baselineSource, 'installed_by_release')
})

test('an adopted baseline resolves semver policy baseline_required without changing the policy', () => {
  const before = evaluateVersionBump({
    proposedVersion: '1.1.0', previousVersion: undefined,
    classification: 'capability', channel: 'stable',
  })
  assert.equal(before.reason, 'baseline_required')
  const after = evaluateVersionBump({
    proposedVersion: '1.1.0', previousVersion: '1.0.0',
    classification: 'capability', channel: 'stable',
  })
  assert.equal(after.ok, true)
  assert.equal(after.reason, 'valid')
})

test('the general business editor cannot write installed version provenance', () => {
  const route = readFileSync('app/api/admin/platform/businesses/[id]/route.ts', 'utf8')
  const editableFields = route.match(/for \(const k of \[([\s\S]*?)\] as const\)/)?.[1] ?? ''
  assert.doesNotMatch(editableFields, /currentVersion|latestVerifiedVersion|currentCommit|baselineSource/)
})
