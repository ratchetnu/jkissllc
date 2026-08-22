import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  baselineConfirmationPhrase,
  baselineSourceOf,
  dryRunBaselineAdoption,
  verifyBaselineApprovalToken,
} from '../app/lib/platform/release/baseline-adoption'
import { adoptBaseline } from '../app/lib/platform/release/baseline-adoption-service'
import { deriveBusinessProvenance } from '../app/lib/platform/automation/finalize'
import { reconcileJobRecords } from '../app/lib/platform/automation/reconcile-records'
import { evaluateVersionBump } from '../app/lib/platform/release/semver-policy'
import type { PlatformBusiness } from '../app/lib/platform/updates/types'

const NOW = 1_800_000_000_000
const SECRET = 'test-owner-approval-secret-at-least-16'
const HASH = `sha256:${'a'.repeat(64)}`

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
  currentCommit: 'abcdef1234567890',
  latestVerifiedCommit: 'abcdef1234567890',
  createdAt: 100,
  updatedAt: 200,
  ...patch,
})

const completeEvidence = (patch: Record<string, unknown> = {}) => ({
  proposedVersion: '1.4.0',
  deployedCommit: 'abcdef1234567890',
  capabilityManifestHash: HASH,
  capabilities: [
    { id: 'booking', evidence: 'Production capability manifest' },
    { id: 'crew-routing', evidence: 'Production capability manifest' },
  ],
  schemaMigrationState: { state: 'verified', schemaVersion: '12', evidence: 'Migration ledger' },
  relevantFlagState: { assessed: true, flags: { CREW_PORTAL_ENABLED: true } },
  verificationEvidence: [
    { kind: 'production_deployment', reference: 'dpl_verified', verifiedAt: NOW - 1000 },
    { kind: 'health_check', reference: 'smoke/2026-07-25', verifiedAt: NOW - 500 },
  ],
  ...patch,
})

test('legacy baseline provenance remains unknown and never fabricates a version', () => {
  const target = business({ currentVersion: undefined, baselineSource: undefined })
  assert.equal(baselineSourceOf(target), 'unknown')
  const result = dryRunBaselineAdoption({
    business: target,
    evidence: { deployedCommit: target.currentCommit },
    now: NOW,
    approvalSecret: SECRET,
  })
  assert.equal(result.verdict, 'insufficient_evidence')
  assert.equal(result.proposedVersion, undefined)
  assert.equal(result.approvalToken, undefined)
})

test('dry run returns all three verdicts and only safe evidence gets an approval receipt', () => {
  const safe = dryRunBaselineAdoption({ business: business(), evidence: completeEvidence(), now: NOW, approvalSecret: SECRET })
  assert.equal(safe.verdict, 'safe_to_adopt')
  assert.equal(safe.proposedVersion, '1.4.0')
  assert.ok(safe.approvalToken)
  assert.deepEqual(safe.missingEvidence, [])
  assert.deepEqual(safe.conflicts, [])

  const missing = dryRunBaselineAdoption({ business: business(), evidence: {}, now: NOW, approvalSecret: SECRET })
  assert.equal(missing.verdict, 'insufficient_evidence')
  assert.equal(missing.approvalToken, undefined)

  const conflict = dryRunBaselineAdoption({
    business: business(),
    evidence: completeEvidence({ deployedCommit: '9999999999999999' }),
    now: NOW,
    approvalSecret: SECRET,
  })
  assert.equal(conflict.verdict, 'needs_review')
  assert.match(conflict.conflicts.join(' '), /does not match/)
  assert.equal(conflict.approvalToken, undefined)
})

test('approval receipt is evidence-bound, business-bound, and expires', () => {
  const target = business()
  const checked = dryRunBaselineAdoption({ business: target, evidence: completeEvidence(), now: NOW, approvalSecret: SECRET })
  assert.ok(checked.approvalToken)
  const expected = {
    targetProduct: target.id,
    evidenceHash: checked.evidenceHash,
    businessUpdatedAt: target.updatedAt,
  }
  assert.equal(verifyBaselineApprovalToken(checked.approvalToken!, SECRET, expected, NOW), true)
  assert.equal(verifyBaselineApprovalToken(`${checked.approvalToken}x`, SECRET, expected, NOW), false)
  assert.equal(verifyBaselineApprovalToken(checked.approvalToken!, SECRET, { ...expected, evidenceHash: 'changed' }, NOW), false)
  assert.equal(verifyBaselineApprovalToken(checked.approvalToken!, SECRET, expected, NOW + 15 * 60_000 + 1), false)
})

test('declined, missing, or mismatched owner approval performs no write', async () => {
  const target = business()
  const checked = dryRunBaselineAdoption({ business: target, evidence: completeEvidence(), now: NOW, approvalSecret: SECRET })
  let writes = 0
  const deps = {
    nextId: async () => 'BADOPT-1001',
    save: async () => { writes++; return true },
    audit: async () => null,
  }
  for (const approval of [
    { token: '', phrase: baselineConfirmationPhrase(target.id) },
    { token: checked.approvalToken!, phrase: '' },
    { token: checked.approvalToken!, phrase: 'ADOPT SOMETHING ELSE' },
  ]) {
    const result = await adoptBaseline({
      business: target,
      evidence: completeEvidence(),
      approvalToken: approval.token,
      confirmationPhrase: approval.phrase,
      actor: 'owner:test',
      now: NOW,
      approvalSecret: SECRET,
      deps,
    })
    assert.equal(result.ok, false)
  }
  assert.equal(writes, 0)
})

test('approved adoption writes provenance, immutable evidence, rollback snapshot, and audit', async () => {
  const target = business()
  const checked = dryRunBaselineAdoption({ business: target, evidence: completeEvidence(), now: NOW, approvalSecret: SECRET })
  const saved: unknown[][] = []
  const audits: unknown[] = []
  const result = await adoptBaseline({
    business: target,
    evidence: completeEvidence(),
    approvalToken: checked.approvalToken!,
    confirmationPhrase: baselineConfirmationPhrase(target.id),
    actor: 'owner:42',
    now: NOW,
    approvalSecret: SECRET,
    deps: {
      nextId: async () => 'BADOPT-1001',
      save: async (...args) => { saved.push(args); return true },
      audit: async (event) => { audits.push(event); return null },
    },
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.business.currentVersion, '1.4.0')
  assert.equal(result.business.baselineSource, 'adopted')
  assert.equal(result.business.baselineAdoptionId, 'BADOPT-1001')
  assert.equal(result.adoption.adoptedBy, 'owner:42')
  assert.equal(result.adoption.ownerApproval.evidenceHash, checked.evidenceHash)
  assert.equal(result.adoption.rollbackSnapshot.baselineSource, 'unknown')
  assert.equal(result.adoption.rollbackSnapshot.currentVersion, undefined)
  assert.equal(saved.length, 1)
  assert.equal(saved[0][2], target.updatedAt, 'CAS uses the business revision checked by the owner')
  assert.equal(audits.length, 1)
  assert.equal((audits[0] as { action: string }).action, 'baseline.adopted')
})

test('a stale business revision fails closed and is not reported as adopted', async () => {
  const target = business()
  const checked = dryRunBaselineAdoption({ business: target, evidence: completeEvidence(), now: NOW, approvalSecret: SECRET })
  let audits = 0
  const result = await adoptBaseline({
    business: target,
    evidence: completeEvidence(),
    approvalToken: checked.approvalToken!,
    confirmationPhrase: baselineConfirmationPhrase(target.id),
    actor: 'owner:42',
    now: NOW,
    approvalSecret: SECRET,
    deps: {
      nextId: async () => 'BADOPT-1001',
      save: async () => false,
      audit: async () => { audits++; return null },
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.reason, /changed after the dry run/)
  assert.equal(audits, 0)
})

test('an adopted baseline enables later semantic version policy without changing pricing or release rules', () => {
  const adopted = business({ currentVersion: '1.4.0', baselineSource: 'adopted' })
  const result = evaluateVersionBump({
    proposedVersion: '1.4.1',
    previousVersion: adopted.currentVersion,
    classification: 'fix',
    channel: 'stable',
  })
  assert.equal(result.ok, true)
})

test('verified finalization is the other allowed source and rejects malformed release versions', () => {
  const patch = deriveBusinessProvenance({
    facts: { commit: 'abcdef1', verifiedAt: NOW } as never,
    releaseVersion: 'v2.0.0',
  })
  assert.equal(patch.currentVersion, '2.0.0')
  assert.equal(patch.latestVerifiedVersion, '2.0.0')
  assert.equal(patch.baselineSource, 'installed_by_release')
  assert.throws(() => deriveBusinessProvenance({
    facts: { commit: 'abcdef1', verifiedAt: NOW } as never,
    releaseVersion: 'release-two',
  }), /invalid semantic version/)
})

test('failed, cancelled, blocked, and superseded attempts cannot reach provenance writes', async () => {
  for (const status of ['failed', 'cancelled', 'blocked', 'superseded']) {
    const result = await reconcileJobRecords({
      job: {
        id: `AUTO-${status}`,
        updateId: 'UPD-TEST',
        businessId: 'supercharged',
        status,
      } as never,
    })
    assert.equal(result.action, 'skipped')
    assert.match(result.reason ?? '', new RegExp(`job is ${status}`))
  }
})

test('generic business editing cannot write either release version field', () => {
  const source = readFileSync('app/api/admin/platform/businesses/[id]/route.ts', 'utf8')
  const patchBody = source.slice(source.indexOf('export const PATCH'))
  assert.doesNotMatch(patchBody, /f\.(?:currentVersion|latestVerifiedVersion)/)
  const editable = /for \(const k of \[([^\]]+)\]/.exec(patchBody)?.[1] ?? ''
  assert.doesNotMatch(editable, /currentVersion|latestVerifiedVersion/)
})

test('the browser consumes the server verdict instead of reimplementing evidence policy', () => {
  const source = readFileSync('app/admin/operations/release/BaselineAdoptionPanel.tsx', 'utf8')
  // The action was renamed when evidence collection moved server-side: the browser no
  // longer SENDS evidence to be judged, it asks the server to go and read it. The
  // property under test is unchanged — no policy, no crypto, no version parsing here.
  assert.match(source, /action: 'check_evidence'/)
  assert.doesNotMatch(source, /createBaselineApprovalToken|verifyBaselineApprovalToken|parseSemanticVersion/)
  // And the browser must not be able to submit a commit at all.
  assert.doesNotMatch(source, /setCommit|deployedCommit:\s*commit\b/)
})
