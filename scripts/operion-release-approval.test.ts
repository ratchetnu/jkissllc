// Increment 3B.3 — Owner Approval + Typed-Confirmation Gate tests.
//
// Covers the PURE gate logic (phrase, binding fingerprint, state derivation, the creation
// gate across every rejection), the KV store (idempotency, single-use consume, revoke,
// expiry, invalidation) against a hermetic in-memory Upstash-REST fake, and STATIC safety
// guards proving the route/store never publish, deploy, or call a provider. No live KV, no
// network, no execution.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  approvalPhrase, matchesApprovalPhrase, releaseBindingFingerprint, deriveApprovalState, isApprovalUsable,
  evaluateApprovalGate, approvalStateLabel, APPROVAL_TTL_MS, APPROVAL_TARGET,
  type ReleaseApproval, type ApprovalBinding, type ApprovalGateInput,
} from '../app/lib/platform/release/approval'
import type { EligibilityResult } from '../app/lib/platform/release/promotion-eligibility'
import { FLAG_DEFAULTS } from '../app/lib/platform/flags'

// ── Fixtures ──────────────────────────────────────────────────────────────────
const eligible: EligibilityResult = { eligible: true, reasons: [], warnings: [], requirements: [], evaluatedAt: 1, candidate: null }
const ineligible: EligibilityResult = { eligible: false, reasons: [{ code: 'PROMOTION_DISABLED', category: 'feature_flags', message: 'flag off' }], warnings: [], requirements: [], evaluatedAt: 1, candidate: null }
const BINDING: ApprovalBinding = { businessId: 'supercharged', releaseId: 'abc1234', sourceDeploymentId: 'dpl_prev9', targetEnvironment: APPROVAL_TARGET }

const gateInput = (over: Partial<ApprovalGateInput> = {}): ApprovalGateInput => ({
  isOwner: true, gateEnabled: true,
  business: { id: 'supercharged', slug: 'supercharged' },
  testOnly: false, eligibility: eligible, previewReady: true,
  binding: { businessId: 'supercharged', releaseId: 'abc1234', sourceDeploymentId: 'dpl_prev9', targetEnvironment: APPROVAL_TARGET },
  claimed: { businessId: 'supercharged', releaseId: 'abc1234', sourceDeploymentId: 'dpl_prev9', targetEnvironment: 'production' },
  phraseInput: 'APPROVE SUPERCHARGED FOR PRODUCTION',
  ...over,
})

// ── PURE: phrase ────────────────────────────────────────────────────────────
test('phrase: release-specific, never a generic CONFIRM', () => {
  assert.equal(approvalPhrase('supercharged'), 'APPROVE SUPERCHARGED FOR PRODUCTION')
  assert.equal(approvalPhrase('  jkiss '), 'APPROVE JKISS FOR PRODUCTION')
})
test('phrase match: exact content, case/whitespace tolerant; wrong slug + generic rejected', () => {
  assert.equal(matchesApprovalPhrase('APPROVE SUPERCHARGED FOR PRODUCTION', 'supercharged'), true)
  assert.equal(matchesApprovalPhrase('  approve   supercharged   for production ', 'supercharged'), true) // tolerant
  assert.equal(matchesApprovalPhrase('APPROVE JKISS FOR PRODUCTION', 'supercharged'), false)              // wrong slug
  assert.equal(matchesApprovalPhrase('CONFIRM', 'supercharged'), false)                                  // generic
  assert.equal(matchesApprovalPhrase('APPROVE SUPERCHARGED', 'supercharged'), false)                     // partial
  assert.equal(matchesApprovalPhrase('', 'supercharged'), false)
})

// ── PURE: binding fingerprint ────────────────────────────────────────────────
test('fingerprint: stable, and changes when ANY bound field changes', () => {
  const base = releaseBindingFingerprint(BINDING)
  assert.equal(base, releaseBindingFingerprint({ ...BINDING }))                    // stable
  assert.notEqual(base, releaseBindingFingerprint({ ...BINDING, releaseId: 'zzz' }))
  assert.notEqual(base, releaseBindingFingerprint({ ...BINDING, sourceDeploymentId: 'dpl_other' }))
  assert.notEqual(base, releaseBindingFingerprint({ ...BINDING, businessId: 'jkiss' }))
})

// ── PURE: state derivation ───────────────────────────────────────────────────
const mkApproval = (over: Partial<ReleaseApproval> = {}): ReleaseApproval => ({
  recordVersion: 1, id: 'APRV-1001', businessId: 'supercharged', businessSlug: 'supercharged',
  releaseId: 'abc1234', sourceDeploymentId: 'dpl_prev9', targetEnvironment: APPROVAL_TARGET,
  bindingFingerprint: releaseBindingFingerprint(BINDING), approvedBy: 'owner', approvedAt: 1000,
  expiresAt: 1000 + APPROVAL_TTL_MS, phraseVerified: true, status: 'active', createdSource: 'test', ...over,
})
test('state: none / active / expired / invalidated / consumed / revoked', () => {
  const fp = releaseBindingFingerprint(BINDING)
  assert.equal(deriveApprovalState(null, 2000, fp), 'none')
  assert.equal(deriveApprovalState(mkApproval(), 2000, fp), 'active')
  assert.equal(deriveApprovalState(mkApproval(), 1000 + APPROVAL_TTL_MS + 1, fp), 'expired')
  assert.equal(deriveApprovalState(mkApproval(), 2000, 'fp_different'), 'invalidated')       // release data changed
  assert.equal(deriveApprovalState(mkApproval({ status: 'consumed', consumedAt: 1500 }), 2000, fp), 'consumed')
  assert.equal(deriveApprovalState(mkApproval({ status: 'revoked', revokedAt: 1500 }), 2000, fp), 'revoked')
  assert.equal(isApprovalUsable(mkApproval(), 2000, fp), true)
  assert.equal(isApprovalUsable(mkApproval(), 2000, 'fp_x'), false)
  assert.equal(approvalStateLabel('invalidated'), 'Approval invalidated — release data changed')
})

// ── PURE: the creation gate (every rejection + the happy path) ───────────────
test('gate: allows an eligible, owner-authorized, phrase-correct approval', () => {
  const r = evaluateApprovalGate(gateInput())
  assert.equal(r.allowed, true)
  assert.deepEqual(r.allowed && r.binding, BINDING)
})
test('gate: rejects non-owner', () => { assert.deepEqual(fail(gateInput({ isOwner: false })), 'OWNER_REQUIRED') })
test('gate: rejects when the gate flag is disabled', () => { assert.deepEqual(fail(gateInput({ gateEnabled: false })), 'GATE_DISABLED') })
test('gate: rejects a missing business', () => { assert.deepEqual(fail(gateInput({ business: null })), 'BUSINESS_NOT_FOUND') })
test('gate: rejects TEST ONLY business', () => { assert.deepEqual(fail(gateInput({ testOnly: true })), 'TEST_ONLY_BUSINESS') })
test('gate: rejects a not-eligible release (blockers)', () => { assert.deepEqual(fail(gateInput({ eligibility: ineligible })), 'NOT_ELIGIBLE') })
test('gate: rejects when preview is not READY', () => { assert.deepEqual(fail(gateInput({ previewReady: false })), 'PREVIEW_NOT_READY') })
test('gate: rejects missing release context', () => {
  assert.deepEqual(fail(gateInput({ binding: { businessId: 'supercharged', targetEnvironment: APPROVAL_TARGET } })), 'RELEASE_CONTEXT_MISSING')
})
test('gate: rejects a mismatched business / release / deployment id', () => {
  assert.deepEqual(fail(gateInput({ claimed: { businessId: 'jkiss', releaseId: 'abc1234', sourceDeploymentId: 'dpl_prev9' } })), 'BUSINESS_MISMATCH')
  assert.deepEqual(fail(gateInput({ claimed: { businessId: 'supercharged', releaseId: 'WRONG', sourceDeploymentId: 'dpl_prev9' } })), 'RELEASE_MISMATCH')
  assert.deepEqual(fail(gateInput({ claimed: { businessId: 'supercharged', releaseId: 'abc1234', sourceDeploymentId: 'dpl_WRONG' } })), 'DEPLOYMENT_MISMATCH')
  assert.deepEqual(fail(gateInput({ claimed: { targetEnvironment: 'preview' } })), 'DEPLOYMENT_MISMATCH')
})
test('gate: rejects a wrong phrase (checked last, so it never masks a blocker)', () => {
  assert.deepEqual(fail(gateInput({ phraseInput: 'CONFIRM' })), 'PHRASE_MISMATCH')
  assert.deepEqual(fail(gateInput({ phraseInput: 'APPROVE JKISS FOR PRODUCTION' })), 'PHRASE_MISMATCH')
  // a blocker outranks a correct phrase
  assert.deepEqual(fail(gateInput({ testOnly: true, phraseInput: 'APPROVE SUPERCHARGED FOR PRODUCTION' })), 'TEST_ONLY_BUSINESS')
})

function fail(i: ApprovalGateInput): string | true {
  const r = evaluateApprovalGate(i)
  return r.allowed ? true : r.code
}

// ── Flag default ─────────────────────────────────────────────────────────────
test('flag: OPERION_APPROVAL_GATE_ENABLED defaults OFF (incl. Production)', () => {
  assert.equal(FLAG_DEFAULTS.OPERION_APPROVAL_GATE_ENABLED, false)
})

// ── STORE: hermetic in-memory Upstash-REST fake ──────────────────────────────
function installFakeKv() {
  const kv = new Map<string, string>()
  const prevUrl = process.env.KV_REST_API_URL, prevTok = process.env.KV_REST_API_TOKEN
  const prevFetch = globalThis.fetch
  process.env.KV_REST_API_URL = 'http://fake-kv'
  process.env.KV_REST_API_TOKEN = 'fake-token'
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const args = (JSON.parse(init.body) as unknown[]).map(String)
    const cmd = args[0].toUpperCase()
    let result: unknown = null
    if (cmd === 'INCR') { const k = args[1]; const n = (parseInt(kv.get(k) || '0', 10) || 0) + 1; kv.set(k, String(n)); result = n }
    else if (cmd === 'GET') { result = kv.has(args[1]) ? kv.get(args[1]) : null }
    else if (cmd === 'SET') {
      const k = args[1], v = args[2]
      if (args.includes('NX') && kv.has(k)) result = null
      else { kv.set(k, v); result = 'OK' }
    }
    else if (cmd === 'DEL') { kv.delete(args[1]); result = 1 }
    else if (cmd === 'PEXPIRE' || cmd === 'EXPIRE' || cmd === 'ZADD') { result = 1 }
    return { json: async () => ({ result }) }
  }) as never
  return {
    kv,
    restore() {
      globalThis.fetch = prevFetch
      if (prevUrl === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = prevUrl
      if (prevTok === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = prevTok
    },
  }
}

test('store: create → active pointer; idempotent reuse for the same binding; consume; revoke', async () => {
  const fake = installFakeKv()
  try {
    const store = await import('../app/lib/platform/release/approval-store')
    const now = 5_000_000
    const c1 = await store.createApproval({ now, business: { id: 'supercharged', slug: 'supercharged' }, binding: BINDING, approvedBy: 'owner', phraseVerified: true })
    assert.equal(c1.ok, true)
    assert.equal(c1.ok && c1.reused, false)
    const id = c1.ok ? c1.approval.id : ''
    assert.match(id, /^APRV-/)

    // Idempotent: a second create for the same live binding REUSES it (no conflicting active approval).
    const c2 = await store.createApproval({ now: now + 1000, business: { id: 'supercharged', slug: 'supercharged' }, binding: BINDING, approvedBy: 'owner', phraseVerified: true })
    assert.equal(c2.ok && c2.reused, true)
    assert.equal(c2.ok && c2.approval.id, id)

    const active = await store.getActiveApprovalFor('supercharged')
    assert.equal(active?.id, id)

    // Single-use consume with the matching fingerprint.
    const fp = releaseBindingFingerprint(BINDING)
    const consumed = await store.consumeApproval(id, { now: now + 2000, expectedFingerprint: fp })
    assert.equal(consumed.ok, true)
    // A second consume fails (already consumed).
    const again = await store.consumeApproval(id, { now: now + 3000, expectedFingerprint: fp })
    assert.equal(again.ok, false)
  } finally { fake.restore() }
})

test('store: consume refuses when the binding changed (invalidated) or expired', async () => {
  const fake = installFakeKv()
  try {
    const store = await import('../app/lib/platform/release/approval-store')
    const now = 6_000_000
    const c = await store.createApproval({ now, business: { id: 'jkiss', slug: 'jkiss' }, binding: { ...BINDING, businessId: 'jkiss' }, approvedBy: 'owner', phraseVerified: true })
    const id = c.ok ? c.approval.id : ''
    // Wrong fingerprint (release data changed) → not consumable.
    const bad = await store.consumeApproval(id, { now: now + 1000, expectedFingerprint: 'fp_changed' })
    assert.equal(bad.ok, false)
    // Expired → not consumable.
    const expired = await store.consumeApproval(id, { now: now + APPROVAL_TTL_MS + 1, expectedFingerprint: releaseBindingFingerprint({ ...BINDING, businessId: 'jkiss' }) })
    assert.equal(expired.ok, false)
  } finally { fake.restore() }
})

test('store: revoke an active approval; revoking a non-active one is a safe no-op', async () => {
  const fake = installFakeKv()
  try {
    const store = await import('../app/lib/platform/release/approval-store')
    const now = 7_000_000
    const c = await store.createApproval({ now, business: { id: 'supercharged', slug: 'supercharged' }, binding: BINDING, approvedBy: 'owner', phraseVerified: true })
    const id = c.ok ? c.approval.id : ''
    const rev = await store.revokeApproval(id, now + 100)
    assert.equal(rev?.status, 'revoked')
    const again = await store.revokeApproval(id, now + 200)
    assert.equal(again?.status, 'revoked')  // no-op, stays revoked
  } finally { fake.restore() }
})

// ── STATIC safety: no publish / deploy / provider / secret from this phase ───
function src(rel: string) { return readFileSync(new URL(rel, import.meta.url), 'utf8') }

test('safety: approval store + route never publish, deploy, merge, or call a provider', () => {
  for (const f of ['../app/lib/platform/release/approval-store.ts', '../app/api/admin/release/businesses/[id]/approval/route.ts', '../app/lib/platform/release/approval.ts']) {
    const s = src(f)
    for (const forbidden of ['promoteProduction', 'dispatchWorkflow', 'createBranch', 'mergePullRequest', 'createPullRequest', 'preparePreview', 'createPreviewDeployment', 'advancePromotion', 'transitionJob', 'saveBusiness', 'saveJob', 'VERCEL_TOKEN', 'GITHUB_APP', 'KV_REST_API']) {
      assert.equal(s.includes(forbidden), false, `${f} must not reference ${forbidden}`)
    }
  }
})
test('safety: route is owner-gated, flag-gated for writes, no-store, and audits', () => {
  const s = src('../app/api/admin/release/businesses/[id]/approval/route.ts')
  assert.match(s, /requirePlatformOwner/)                          // owner-gated
  assert.match(s, /OPERION_APPROVAL_GATE_ENABLED/)                 // gate-flagged
  assert.match(s, /no-store/)
  assert.match(s, /recordPlatformAudit/)                           // audits created/rejected/revoked
  assert.match(s, /approval\.created/); assert.match(s, /approval\.rejected/)
  // POST/DELETE hard-refuse when the flag is off.
  assert.match(s, /isEnabled\('OPERION_APPROVAL_GATE_ENABLED'\)/)
})
test('safety: the read-only Publish Review drawer still does a single no-store GET (unchanged)', () => {
  const s = src('../app/admin/operations/release/PublishReviewDrawer.tsx')
  assert.match(s, /cache: 'no-store'/)
  // The publish-review payload fetch is still a GET (no method override on that call).
  assert.equal(/publish-review`[^)]*method:/.test(s), false)
  // The approval panel is a SEPARATE component, not inline in the read-only content.
  assert.match(s, /ReleaseApprovalPanel/)
})
