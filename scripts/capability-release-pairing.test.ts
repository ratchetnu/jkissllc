// ── Pairing capability state with Operion releases ───────────────────────────
//
// The failure mode this exists to prevent, stated plainly: "Supercharged has no
// Stripe key" must never become "Supercharged does not need this security fix."
// Those look alike on a dashboard and mean opposite things — `not_applicable`
// removes a target from a rollout, so a shared-library fix would silently skip the
// business, and nobody would see a gap.
import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'

import { validateTargetEvidence, evaluateCapabilityImpact } from '../app/lib/platform/automation/target-evidence'
import { evaluatePreflight, APPROVED_STATUSES } from '../app/lib/platform/automation/preflight'
import { validateCallbackPayload, verifyCallback, signCallback, callbackMatchesJob } from '../app/lib/platform/automation/callback'
import type { PlatformUpdate, PlatformBusiness, TargetDeploymentEvidence } from '../app/lib/platform/updates/types'
import type { UpdateAutomationJob } from '../app/lib/platform/automation/types'

const NOW = 1_800_000_000_000

// A target that runs NO optional integrations at all.
const BARE_TARGET: TargetDeploymentEvidence = {
  commit: 'a1b2c3d4e5f6',
  buildId: 'dpl_abc123',
  capabilityProfileVersion: 1,
  capabilities: [
    { capability: 'bookings', state: 'capability_ready', enabled: true, configured: null },
    { capability: 'invoicing', state: 'capability_ready', enabled: true, configured: null },
    { capability: 'payments', state: 'capability_ready', enabled: true, configured: null },
    { capability: 'payments-stripe', state: 'capability_disabled', enabled: false, configured: false },
    { capability: 'sms-delivery', state: 'capability_disabled', enabled: false, configured: false },
    { capability: 'email-delivery', state: 'capability_disabled', enabled: false, configured: false },
  ],
  recordedAt: NOW,
  authentication: 'hmac-sha256',
}

const update = (over: Partial<PlatformUpdate> = {}): PlatformUpdate => ({
  recordVersion: 1, key: 'UPD-9001', title: 't', summary: 's',
  type: 'security', scope: 'platform_core', severity: 'critical', priority: 'urgent', status: 'approved',
  breakingChange: false, migrationRequired: false, environmentChangeRequired: false,
  secretRequired: false, featureFlagRequired: false, manualPortRequired: false, rollbackSupported: true,
  sourceCommit: 'deadbeef',
  validation: { typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed', securityReview: 'passed', accessibilityReview: 'not_applicable', e2e: 'not_applicable', smokeTest: 'passed', ownerVerification: 'passed' },
  createdAt: 0, updatedAt: 0,
  ...over,
})

const business = (over: Partial<PlatformBusiness> = {}): PlatformBusiness => ({
  recordVersion: 1, id: 'supercharged', name: 'Supercharged', role: 'target',
  releaseChannel: 'stable', updatePolicy: 'owner_approved', healthStatus: 'healthy',
  repoName: 'ratchetnu/supercharged', defaultBranch: 'main',
  githubInstallationId: 'ghi_1', automationWorkflowFile: 'operion-update.yml',
  previewProjectId: 'prj_1', previewDeploymentProvider: 'vercel',
  configurationStatus: 'ready',
  createdAt: 0, updatedAt: 0,
  ...over,
} as PlatformBusiness)

// ── E. A core update installs regardless of optional integrations ────────────

test('a CORE security update is applicable to a target with every optional channel off', () => {
  const r = evaluateCapabilityImpact(update({ scope: 'platform_core', type: 'security' }), BARE_TARGET)
  assert.equal(r.installs, true)
  assert.equal(r.dormant, false, 'a core update is never dormant')
  assert.deepEqual(r.missingCapabilityCode, [])
  assert.match(r.rationale, /regardless of which optional features/)
})

test('a SHARED_MODULE update is likewise never dormant, even when it names optional capabilities', () => {
  const r = evaluateCapabilityImpact(
    update({ scope: 'shared_module', capabilityImpact: { affects: ['sms-delivery'], optionalOnly: true } }),
    BARE_TARGET,
  )
  assert.equal(r.installs, true)
  assert.equal(r.dormant, false, 'shared code reaches every compatible target')
})

test('an OPTIONAL-only update installs DORMANT — installed, not skipped', () => {
  const r = evaluateCapabilityImpact(
    update({ scope: 'industry_specific', capabilityImpact: { affects: ['sms-delivery', 'email-delivery'], optionalOnly: true } }),
    BARE_TARGET,
  )
  assert.equal(r.installs, true, 'installation is never conditioned on activation')
  assert.equal(r.dormant, true)
  assert.match(r.rationale, /stays dormant/)
  assert.match(r.rationale, /no redeployment/)
})

test('activation requirements are reported, and name only VARIABLES', () => {
  const enabledUnconfigured: TargetDeploymentEvidence = {
    ...BARE_TARGET,
    capabilities: [{ capability: 'sms-delivery', state: 'capability_setup_required', enabled: true, configured: false, missingVars: ['TWILIO_ACCOUNT_SID'] }],
  }
  const r = evaluateCapabilityImpact(update({ capabilityImpact: { affects: ['sms-delivery'] } }), enabledUnconfigured)
  assert.equal(r.installs, true)
  const cred = r.activationRequirements.find(a => a.kind === 'provider_credential')
  assert.equal(cred?.reference, 'TWILIO_ACCOUNT_SID')
})

test('MISSING CAPABILITY CODE is a real blocker — a genuine transfer dependency still blocks', () => {
  const missing: TargetDeploymentEvidence = {
    ...BARE_TARGET,
    capabilities: [{ capability: 'claims', state: 'capability_not_installed', enabled: false, configured: null }],
  }
  const r = evaluateCapabilityImpact(update({ capabilityImpact: { requiresCapabilityCode: ['claims'] } }), missing)
  assert.deepEqual(r.missingCapabilityCode, ['claims'])
  assert.match(r.rationale, /missing the code/)
})

test('absence of a report is NOT evidence of absence — an un-reporting target is not judged empty', () => {
  const r = evaluateCapabilityImpact(update({ capabilityImpact: { requiresCapabilityCode: ['claims'] } }), null)
  assert.deepEqual(r.missingCapabilityCode, [], 'a silent target must not be treated as missing everything')
  assert.equal(r.installs, true)
})

// ── Preflight: optional providers never block ────────────────────────────────

const preflightInput = (capabilityImpact?: ReturnType<typeof evaluateCapabilityImpact>) => ({
  update: update(),
  business: business(),
  compat: { recordVersion: 1, updateKey: 'UPD-9001', businessId: 'supercharged', status: 'compatible' as const, createdAt: 0, updatedAt: 0 },
  hasActiveJob: false,
  flags: { automation: true, preview: true, githubActions: true, controlPlane: true },
  requiredUpdates: { ok: true, missing: [] },
  transferReady: { ok: true },
  capabilityImpact,
})

test('preflight passes for a target with every optional provider off', () => {
  const r = evaluatePreflight(preflightInput(evaluateCapabilityImpact(update(), BARE_TARGET)))
  assert.equal(r.ok, true, JSON.stringify(r.gates.filter(g => !g.ok && g.blocking)))
})

test('NO preflight gate reads provider readiness — the invariant, asserted', () => {
  const r = evaluatePreflight(preflightInput(evaluateCapabilityImpact(update(), BARE_TARGET)))
  const text = JSON.stringify(r.gates).toLowerCase()
  for (const forbidden of ['stripe', 'twilio', 'resend']) {
    assert.ok(!text.includes(forbidden), `a preflight gate must never mention ${forbidden}`)
  }
})

test('activation is a SOFT gate: dormant install does not block, but is visible', () => {
  const impact = evaluateCapabilityImpact(
    update({ scope: 'industry_specific', capabilityImpact: { affects: ['sms-delivery'], optionalOnly: true } }),
    BARE_TARGET,
  )
  const r = evaluatePreflight(preflightInput(impact))
  const gate = r.gates.find(g => g.id === 'capability_activation')!
  assert.equal(gate.ok, false, 'the pending activation is surfaced')
  assert.equal(gate.blocking, false, 'and it does not hold the deployment')
  assert.equal(r.ok, true)
})

test('missing capability CODE blocks preflight — the one capability fact that may', () => {
  const missing: TargetDeploymentEvidence = { ...BARE_TARGET, capabilities: [{ capability: 'claims', state: 'capability_not_installed', enabled: false, configured: null }] }
  const impact = evaluateCapabilityImpact(update({ capabilityImpact: { requiresCapabilityCode: ['claims'] } }), missing)
  const r = evaluatePreflight(preflightInput(impact))
  assert.equal(r.ok, false)
  const gate = r.gates.find(g => g.id === 'capability_code_present')!
  assert.equal(gate.blocking, true)
  assert.equal(gate.ok, false)
})

test('APPROVED_STATUSES is unchanged — capability work did not widen dispatch eligibility', () => {
  assert.deepEqual(APPROVED_STATUSES, ['approved', 'ready_to_release', 'ready_for_review', 'included_in_release', 'partially_deployed'])
})

// ── Evidence validation: value-free, forgery- and replay-resistant ───────────

test('evidence is accepted only in its value-free shape', () => {
  const r = validateTargetEvidence({
    commit: 'a1b2c3d', buildId: 'dpl_x1', capabilities: [{ capability: 'sms-delivery', state: 'capability_disabled', enabled: false, configured: false }],
  }, NOW)
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.value.recordedAt, NOW)
  assert.equal(r.ok && r.value.authentication, 'hmac-sha256')
})

test('a target CANNOT smuggle a credential value through missingVars', () => {
  const r = validateTargetEvidence({
    capabilities: [{ capability: 'sms-delivery', state: 'capability_setup_required', enabled: true, configured: false, missingVars: ['sk_live_51HxxxxSECRET'] }],
  }, NOW)
  assert.equal(r.ok, true)
  // The entry is DROPPED, not truncated — a truncated secret is still a secret.
  assert.equal(r.ok && r.value.capabilities.length, 0)
  assert.match((r.ok ? r.warnings : []).join(' '), /not a variable name/)
})

test('a target cannot smuggle free text through a state code or a capability id', () => {
  const r = validateTargetEvidence({
    capabilities: [
      { capability: 'sms-delivery', state: 'the token is AC0123456789abcdef', enabled: true, configured: false },
      { capability: 'DATABASE_URL=postgres://u:p@h/db', state: 'capability_ready', enabled: true, configured: true },
    ],
  }, NOW)
  assert.equal(r.ok && r.value.capabilities.length, 0)
})

test('a target CANNOT set its own record time — our clock wins', () => {
  const r = validateTargetEvidence({ reportedAt: 1, capabilities: [] }, NOW)
  assert.equal(r.ok && r.value.recordedAt, NOW, 'recordedAt is ours')
  assert.equal(r.ok && r.value.reportedAt, 1, 'the target’s claim is kept as advisory only')
})

test('structurally impossible evidence is refused outright', () => {
  assert.equal(validateTargetEvidence({ capabilities: 'nope' }, NOW).ok, false)
  assert.equal(validateTargetEvidence({ commit: 'not a sha', capabilities: [] }, NOW).ok, false)
  assert.equal(validateTargetEvidence(null, NOW).ok, false)
  assert.equal(validateTargetEvidence({ capabilities: new Array(200).fill({ capability: 'x', state: 'y', enabled: true, configured: null }) }, NOW).ok, false)
})

test('duplicate capability entries are dropped, so a later one cannot override an earlier', () => {
  const r = validateTargetEvidence({
    capabilities: [
      { capability: 'sms-delivery', state: 'capability_disabled', enabled: false, configured: false },
      { capability: 'sms-delivery', state: 'capability_ready', enabled: true, configured: true },
    ],
  }, NOW)
  assert.equal(r.ok && r.value.capabilities.length, 1)
  assert.equal(r.ok && r.value.capabilities[0].enabled, false, 'first wins; a duplicate cannot upgrade itself')
})

// ── The signed channel: forgery + replay ─────────────────────────────────────

const SECRET = 'shared-callback-secret'
const evidenceBody = (jobId: string, branch: string, deliveryId: string) => JSON.stringify({
  deliveryId, jobId, status: 'preview_ready', branch, commit: 'a1b2c3d',
  capabilityEvidence: { commit: 'a1b2c3d', capabilities: [{ capability: 'sms-delivery', state: 'capability_disabled', enabled: false, configured: false }] },
})

test('UNSIGNED evidence is rejected — it never reaches the validator', () => {
  const body = evidenceBody('AUTO-1', 'operion/upd-9001', 'd1')
  assert.equal(verifyCallback(body, String(NOW), null, SECRET, NOW).ok, false)
  assert.equal(verifyCallback(body, String(NOW), 'deadbeef', SECRET, NOW).ok, false)
})

test('evidence signed with the WRONG secret is rejected', () => {
  const body = evidenceBody('AUTO-1', 'operion/upd-9001', 'd1')
  const sig = signCallback(body, String(NOW), 'attacker-secret')
  assert.equal(verifyCallback(body, String(NOW), sig, SECRET, NOW).ok, false)
})

test('TAMPERED evidence invalidates the signature (the body is what is signed)', () => {
  const body = evidenceBody('AUTO-1', 'operion/upd-9001', 'd1')
  const sig = signCallback(body, String(NOW), SECRET)
  const tampered = body.replace('"enabled":false', '"enabled":true')
  assert.notEqual(tampered, body)
  assert.equal(verifyCallback(tampered, String(NOW), sig, SECRET, NOW).ok, false)
})

test('REPLAYED evidence is rejected by the freshness window', () => {
  const body = evidenceBody('AUTO-1', 'operion/upd-9001', 'd1')
  const ts = String(NOW - 10 * 60_000)
  const sig = signCallback(body, ts, SECRET)
  const v = verifyCallback(body, ts, sig, SECRET, NOW)
  assert.equal(v.ok, false)
  assert.match(v.reason ?? '', /replay|window/i)
})

test('a genuine, fresh, signed report is accepted and its evidence validated', () => {
  const body = evidenceBody('AUTO-1', 'operion/upd-9001', 'd1')
  const sig = signCallback(body, String(NOW), SECRET)
  assert.equal(verifyCallback(body, String(NOW), sig, SECRET, NOW).ok, true)
  const parsed = validateCallbackPayload(JSON.parse(body), { at: NOW })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && parsed.value.capabilityEvidence?.capabilities[0].capability, 'sms-delivery')
  assert.equal(parsed.ok && parsed.value.capabilityEvidence?.recordedAt, NOW)
})

test('evidence for ANOTHER job cannot be bound — a valid HMAC alone is not enough', () => {
  const job = { id: 'AUTO-1', workBranch: 'operion/upd-9001', status: 'testing' } as UpdateAutomationJob
  const parsed = validateCallbackPayload(JSON.parse(evidenceBody('AUTO-1', 'operion/other-branch', 'd2')), { at: NOW })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.ok && callbackMatchesJob(parsed.value, job), false)
})

test('MALFORMED evidence does not fail the whole callback — a reporting bug is not a stuck deploy', () => {
  const parsed = validateCallbackPayload({
    deliveryId: 'd3', jobId: 'AUTO-1', status: 'preview_ready', branch: 'operion/upd-9001',
    capabilityEvidence: { capabilities: 'garbage' },
  }, { at: NOW })
  assert.equal(parsed.ok, true, 'the preview result is still recorded')
  assert.equal(parsed.ok && parsed.value.capabilityEvidence, undefined)
  assert.match((parsed.ok && parsed.value.evidenceWarnings || []).join(' '), /rejected/)
})

test('the HMAC is over the exact body, so evidence cannot be spliced between deliveries', () => {
  const a = evidenceBody('AUTO-1', 'operion/upd-9001', 'd1')
  const b = evidenceBody('AUTO-1', 'operion/upd-9001', 'd2')
  const sigA = signCallback(a, String(NOW), SECRET)
  assert.equal(verifyCallback(b, String(NOW), sigA, SECRET, NOW).ok, false)
  // Sanity: the digests genuinely differ.
  assert.notEqual(crypto.createHash('sha256').update(a).digest('hex'), crypto.createHash('sha256').update(b).digest('hex'))
})
