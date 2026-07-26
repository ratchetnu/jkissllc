// Increment 10 — the deployed commit is proven against LIVE provider evidence, not against a
// stored commit that only advances when an Operion job finalizes (and is therefore stale for
// any product deployed outside the pipeline).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  baselineConfirmationPhrase,
  baselineEvidenceHash,
  dryRunBaselineAdoption,
  sameCommit,
} from '../app/lib/platform/release/baseline-adoption'
import { adoptBaseline } from '../app/lib/platform/release/baseline-adoption-service'
import type { BaselineAdoptionRecord, PlatformBusiness } from '../app/lib/platform/updates/types'

const NOW = 1_800_000_000_000
const SECRET = 'test-owner-approval-secret-at-least-16'
const HASH = `sha256:${'a'.repeat(64)}`
const RECORDED = 'dd8f6586d53b54b20e144162f93c5b3911bad64a'   // last Operion-managed commit
const LIVE = '328d756bae1f4c2d9e7a3b5c8d0e2f4a6b8c0d2e'       // what Production actually serves

const business = (patch: Partial<PlatformBusiness> = {}): PlatformBusiness => ({
  recordVersion: 1, id: 'supercharged', name: 'Supercharged', slug: 'supercharged',
  status: 'active', role: 'target', defaultBranch: 'main', releaseChannel: 'stable',
  updatePolicy: 'owner_approval', updatesPaused: false, manualApprovalRequired: true,
  autoDeployAllowed: false, healthStatus: 'healthy',
  currentCommit: RECORDED, latestVerifiedCommit: RECORDED,
  createdAt: 100, updatedAt: 200, ...patch,
})

const evidence = (patch: Record<string, unknown> = {}) => ({
  proposedVersion: '1.0.0',
  deployedCommit: LIVE,
  capabilityManifestHash: HASH,
  capabilities: [{ id: 'booking', evidence: 'Production capability manifest' }],
  schemaMigrationState: { state: 'verified', schemaVersion: '12', evidence: 'Migration ledger' },
  relevantFlagState: { assessed: true, flags: { CREW_PORTAL_ENABLED: true } },
  verificationEvidence: [
    { kind: 'production_deployment', reference: 'dpl_live', verifiedAt: NOW - 1000 },
    { kind: 'health_check', reference: 'smoke/2026-07-26', verifiedAt: NOW - 500 },
  ],
  ...patch,
})

const dry = (o: Partial<Parameters<typeof dryRunBaselineAdoption>[0]> = {}) =>
  dryRunBaselineAdoption({
    business: business({ deployProject: 'supercharged' }),
    evidence: evidence(),
    now: NOW,
    approvalSecret: SECRET,
    liveProduction: { deploymentId: 'dpl_live', commit: LIVE },
    ...o,
  })

test('the live production commit is authoritative — a stale stored commit no longer blocks it', () => {
  const r = dry()
  assert.equal(r.verdict, 'safe_to_adopt')
  assert.equal(r.commitVerification.source, 'live_production')
  assert.equal(r.commitVerification.liveCommit, LIVE)
  assert.equal(r.commitVerification.liveDeploymentId, 'dpl_live')
  assert.ok(r.approvalToken, 'a safe verdict still mints a receipt')
  assert.deepEqual(r.conflicts, [])
})

test('adopting the STALE stored commit is refused once live evidence is readable', () => {
  const r = dry({ evidence: evidence({ deployedCommit: RECORDED }) })
  assert.equal(r.verdict, 'needs_review')
  assert.equal(r.approvalToken, undefined, 'no receipt is minted for a stale commit')
  assert.match(r.conflicts.join(' '), /recorded production commit is behind live Production/)
  assert.match(r.conflicts.join(' '), /328d756bae1f/)
})

test('a commit matching neither the record nor live Production is refused', () => {
  const r = dry({ evidence: evidence({ deployedCommit: 'f'.repeat(40) }) })
  assert.equal(r.verdict, 'needs_review')
  assert.match(r.conflicts.join(' '), /does not match live Production/)
  assert.equal(r.approvalToken, undefined)
})

test('businesses without a mapped provider retain record-only adoption', () => {
  const ok = dry({
    business: business(),
    liveProduction: null,
    evidence: evidence({ deployedCommit: RECORDED }),
  })
  assert.equal(ok.verdict, 'safe_to_adopt')
  assert.equal(ok.commitVerification.source, 'recorded_baseline')
  assert.equal(ok.commitVerification.liveCommit, undefined)

  const bad = dry({ business: business(), liveProduction: null })
  assert.equal(bad.verdict, 'needs_review')
  assert.match(bad.conflicts.join(' '), /does not match the recorded production commit/)
})

test('a mapped provider outage or incomplete response fails closed', () => {
  const unavailable = [
    null,
    {},
    { deploymentId: 'dpl_live' },
    { commit: LIVE },
    { deploymentId: 'dpl_live', commit: '' },
    { deploymentId: 'dpl_live', commit: 'nothex!!' },
  ]
  for (const liveProduction of unavailable) {
    const r = dry({
      liveProduction,
      evidence: evidence({ deployedCommit: RECORDED }),
    })
    assert.equal(r.commitVerification.source, 'live_production_unavailable')
    assert.equal(r.verdict, 'insufficient_evidence')
    assert.equal(r.approvalToken, undefined)
    assert.match(r.missingEvidence.join(' '), /live production deployment and commit from provider/)
  }
})

test('commit comparison tolerates git abbreviations in either direction', () => {
  assert.equal(sameCommit(LIVE.slice(0, 7), LIVE), true)
  assert.equal(sameCommit(LIVE, LIVE.slice(0, 12)), true)
  assert.equal(sameCommit(LIVE.toUpperCase(), LIVE), true)
  assert.equal(sameCommit(RECORDED, LIVE), false)
  assert.equal(sameCommit(undefined, LIVE), false)
  const short = dry({ evidence: evidence({ deployedCommit: LIVE.slice(0, 7) }) })
  assert.equal(short.verdict, 'safe_to_adopt')
})

test('the receipt is bound to both live commit and deployment identity', () => {
  const first = dry()
  const moved = dry({ liveProduction: { deploymentId: 'dpl_next', commit: 'a'.repeat(40) },
                      evidence: evidence({ deployedCommit: 'a'.repeat(40) }) })
  assert.notEqual(first.evidenceHash, moved.evidenceHash, 'hash must change when Production moves')
  const redeployed = dry({ liveProduction: { deploymentId: 'dpl_rebuilt', commit: LIVE } })
  assert.notEqual(
    first.evidenceHash,
    redeployed.evidenceHash,
    'hash must change when the deployment changes even if its commit does not',
  )

  // A business without a mapped provider keeps the legacy hash shape.
  const ev = evidence({ deployedCommit: RECORDED })
  const omitted = dryRunBaselineAdoption({ business: business(), evidence: ev, now: NOW })
  const explicitNull = dryRunBaselineAdoption({
    business: business(),
    evidence: ev,
    now: NOW,
    liveProduction: null,
  })
  assert.equal(omitted.evidenceHash, explicitNull.evidenceHash)
  assert.equal(typeof baselineEvidenceHash, 'function')
})

test('adopt writes the provider full commit even when the owner supplied an abbreviation', async () => {
  const target = business({ deployProject: 'supercharged' })
  const abbreviatedEvidence = evidence({ deployedCommit: LIVE.slice(0, 7) })
  const run = dry({ evidence: abbreviatedEvidence })
  let savedBusiness: PlatformBusiness | undefined
  let savedAdoption: BaselineAdoptionRecord | undefined
  const result = await adoptBaseline({
    business: target, evidence: abbreviatedEvidence, approvalToken: run.approvalToken!,
    confirmationPhrase: baselineConfirmationPhrase('supercharged'),
    actor: 'owner', now: NOW, approvalSecret: SECRET,
    liveProduction: { deploymentId: 'dpl_live', commit: LIVE },
    deps: {
      nextId: async () => 'BAS-1001',
      save: async (a, b) => { savedAdoption = a; savedBusiness = b; return true },
      audit: async () => undefined as never,
    },
  })
  assert.equal(result.ok, true)
  assert.equal(savedBusiness?.currentVersion, '1.0.0')
  assert.equal(savedBusiness?.baselineSource, 'adopted')
  assert.equal(savedBusiness?.currentCommit, LIVE, 'the stale stored commit is refreshed to the proven one')
  assert.equal(savedBusiness?.latestVerifiedCommit, LIVE)
  assert.equal(savedAdoption?.deployedCommit, LIVE)
  assert.equal(savedAdoption?.commitVerification.source, 'live_production')
  assert.equal(savedAdoption?.commitVerification.liveDeploymentId, 'dpl_live')
})

test('adopt does NOT advance the stored commit on record-only evidence', async () => {
  const target = business()
  const run = dryRunBaselineAdoption({
    business: target, evidence: evidence({ deployedCommit: RECORDED }), now: NOW,
    approvalSecret: SECRET, liveProduction: null,
  })
  assert.equal(run.verdict, 'safe_to_adopt')
  let savedBusiness: PlatformBusiness | undefined
  const result = await adoptBaseline({
    business: target, evidence: evidence({ deployedCommit: RECORDED }), approvalToken: run.approvalToken!,
    confirmationPhrase: baselineConfirmationPhrase('supercharged'),
    actor: 'owner', now: NOW, approvalSecret: SECRET, liveProduction: null,
    deps: { nextId: async () => 'BAS-1002', save: async (_a, b) => { savedBusiness = b; return true }, audit: async () => undefined as never },
  })
  assert.equal(result.ok, true)
  assert.equal(savedBusiness?.currentCommit, RECORDED, 'unproven evidence never advances the commit')
})

test('a receipt from before a Production move cannot be spent after it', async () => {
  const target = business({ deployProject: 'supercharged' })
  const run = dry()                       // receipt bound to LIVE
  const result = await adoptBaseline({
    business: target, evidence: evidence(), approvalToken: run.approvalToken!,
    confirmationPhrase: baselineConfirmationPhrase('supercharged'),
    actor: 'owner', now: NOW, approvalSecret: SECRET,
    liveProduction: { deploymentId: 'dpl_newer', commit: 'b'.repeat(40) },   // Production moved
    deps: { nextId: async () => 'BAS-1003', save: async () => true, audit: async () => undefined as never },
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /no longer safe to adopt|receipt/)
})

test('a receipt cannot be spent after a same-commit Production redeploy', async () => {
  const target = business({ deployProject: 'supercharged' })
  const run = dry()
  const result = await adoptBaseline({
    business: target,
    evidence: evidence(),
    approvalToken: run.approvalToken!,
    confirmationPhrase: baselineConfirmationPhrase('supercharged'),
    actor: 'owner',
    now: NOW,
    approvalSecret: SECRET,
    liveProduction: { deploymentId: 'dpl_rebuilt', commit: LIVE },
    deps: {
      nextId: async () => 'BAS-1004',
      save: async () => true,
      audit: async () => undefined as never,
    },
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reason, /receipt/)
})
