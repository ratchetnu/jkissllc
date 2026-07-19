// Increment 3B.4 — Controlled Production Publish tests.
//
// Covers the PURE publish gate (phrase, mode resolution, every rejection + happy path), and
// the executor+store end-to-end against a hermetic in-memory Upstash-REST fake (single
// promotion, atomic approval consumption, idempotency/duplicate protection, promote-failure,
// audit events) with an INJECTED promote (no real Vercel call, ever). Plus static safety
// guards. No live KV, no network, no execution.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  publishPhrase, matchesPublishPhrase, resolvePublishMode, evaluatePublishGate, publishUxState,
  type PublishGateInput,
} from '../app/lib/platform/release/publish'
import { releaseBindingFingerprint, APPROVAL_TARGET, APPROVAL_TTL_MS, type ApprovalBinding, type ReleaseApproval } from '../app/lib/platform/release/approval'
import type { EligibilityResult } from '../app/lib/platform/release/promotion-eligibility'

const eligible: EligibilityResult = { eligible: true, reasons: [], warnings: [], requirements: [], evaluatedAt: 1, candidate: null }
const ineligible: EligibilityResult = { eligible: false, reasons: [{ code: 'PROMOTION_DISABLED', category: 'feature_flags', message: 'x' }], warnings: [], requirements: [], evaluatedAt: 1, candidate: null }
const BINDING: ApprovalBinding = { businessId: 'supercharged', releaseId: 'abc1234', sourceDeploymentId: 'dpl_prev9', targetEnvironment: APPROVAL_TARGET }
const FP = releaseBindingFingerprint(BINDING)

const mkApproval = (over: Partial<ReleaseApproval> = {}): ReleaseApproval => ({
  recordVersion: 1, id: 'APRV-1001', businessId: 'supercharged', businessSlug: 'supercharged',
  releaseId: 'abc1234', sourceDeploymentId: 'dpl_prev9', targetEnvironment: APPROVAL_TARGET,
  bindingFingerprint: FP, approvedBy: 'owner', approvedAt: 1000, expiresAt: 1000 + APPROVAL_TTL_MS,
  phraseVerified: true, status: 'active', createdSource: 'test', ...over,
})

const gateInput = (over: Partial<PublishGateInput> = {}): PublishGateInput => ({
  now: 2000, isOwner: true, approvalGateEnabled: true, publishEnabled: true,
  business: { id: 'supercharged', slug: 'supercharged' }, testOnly: false, eligibility: eligible, previewReady: true,
  approval: mkApproval(), binding: { businessId: 'supercharged', releaseId: 'abc1234', sourceDeploymentId: 'dpl_prev9', targetEnvironment: APPROVAL_TARGET },
  claimed: { releaseId: 'abc1234', sourceDeploymentId: 'dpl_prev9' },
  phraseInput: 'PUBLISH SUPERCHARGED TO PRODUCTION', ...over,
})
const fail = (i: PublishGateInput) => { const r = evaluatePublishGate(i); return r.allowed ? true : r.code }

// ── PURE: phrase + mode ──────────────────────────────────────────────────────
test('phrase: PUBLISH <SLUG> TO PRODUCTION, distinct from approval, never generic', () => {
  assert.equal(publishPhrase('supercharged'), 'PUBLISH SUPERCHARGED TO PRODUCTION')
  assert.equal(matchesPublishPhrase('publish supercharged to production', 'supercharged'), true)
  assert.equal(matchesPublishPhrase('APPROVE SUPERCHARGED FOR PRODUCTION', 'supercharged'), false) // not the approval phrase
  assert.equal(matchesPublishPhrase('CONFIRM', 'supercharged'), false)
  assert.equal(matchesPublishPhrase('PUBLISH JKISS TO PRODUCTION', 'supercharged'), false)
})
test('mode: live ONLY in Production runtime + flag; simulated everywhere else', () => {
  assert.equal(resolvePublishMode({ VERCEL_ENV: 'production', OPERION_PRODUCTION_PROMOTION_ENABLED: 'true' }), 'live')
  assert.equal(resolvePublishMode({ VERCEL_ENV: 'production' }), 'simulated')               // flag off
  assert.equal(resolvePublishMode({ VERCEL_ENV: 'preview', OPERION_PRODUCTION_PROMOTION_ENABLED: 'true' }), 'simulated') // preview
  assert.equal(resolvePublishMode({}), 'simulated')
})
test('ux state mapping — truthful states', () => {
  assert.equal(publishUxState('promoting'), 'queued')
  assert.equal(publishUxState('verifying'), 'verifying')
  assert.equal(publishUxState('completed'), 'ready')
  assert.equal(publishUxState('failed'), 'failed')
  assert.equal(publishUxState(undefined), 'idle')
})

// ── PURE: gate rejections + happy path ───────────────────────────────────────
test('gate: allows an owner, enabled, eligible, approved, phrase-correct publish', () => {
  const r = evaluatePublishGate(gateInput())
  assert.equal(r.allowed, true)
  assert.deepEqual(r.allowed && r.binding, BINDING)
})
test('gate: owner rejection', () => assert.equal(fail(gateInput({ isOwner: false })), 'OWNER_REQUIRED'))
test('gate: approval gate disabled', () => assert.equal(fail(gateInput({ approvalGateEnabled: false })), 'APPROVAL_GATE_DISABLED'))
test('gate: publish disabled (promotion flag off)', () => assert.equal(fail(gateInput({ publishEnabled: false })), 'PUBLISH_DISABLED'))
test('gate: TEST ONLY rejection', () => assert.equal(fail(gateInput({ testOnly: true })), 'TEST_ONLY_BUSINESS'))
test('gate: not eligible rejection', () => assert.equal(fail(gateInput({ eligibility: ineligible })), 'NOT_ELIGIBLE'))
test('gate: preview not READY rejection', () => assert.equal(fail(gateInput({ previewReady: false })), 'PREVIEW_NOT_READY'))
test('gate: no active approval', () => assert.equal(fail(gateInput({ approval: null })), 'NO_ACTIVE_APPROVAL'))
test('gate: expired approval', () => assert.equal(fail(gateInput({ approval: mkApproval({ expiresAt: 1500 }), now: 2000 })), 'APPROVAL_EXPIRED'))
test('gate: consumed approval', () => assert.equal(fail(gateInput({ approval: mkApproval({ status: 'consumed' }) })), 'APPROVAL_CONSUMED'))
test('gate: fingerprint mismatch (release data changed) invalidates', () => {
  assert.equal(fail(gateInput({ binding: { businessId: 'supercharged', releaseId: 'DIFFERENT', sourceDeploymentId: 'dpl_prev9', targetEnvironment: APPROVAL_TARGET }, claimed: {} })), 'APPROVAL_INVALIDATED')
})
test('gate: deployment mismatch (claimed vs current)', () => {
  assert.equal(fail(gateInput({ claimed: { releaseId: 'abc1234', sourceDeploymentId: 'dpl_WRONG' } })), 'DEPLOYMENT_MISMATCH')
})
test('gate: wrong phrase, checked last so it never masks a blocker', () => {
  assert.equal(fail(gateInput({ phraseInput: 'CONFIRM' })), 'PHRASE_MISMATCH')
  assert.equal(fail(gateInput({ testOnly: true, phraseInput: 'PUBLISH SUPERCHARGED TO PRODUCTION' })), 'TEST_ONLY_BUSINESS')
})

// ── Hermetic in-memory Upstash-REST fake (strings + sorted sets, for audit) ──
function installFakeKv() {
  const kv = new Map<string, string>()
  const z = new Map<string, { score: number; member: string }[]>()
  const prev = { url: process.env.KV_REST_API_URL, tok: process.env.KV_REST_API_TOKEN, fetch: globalThis.fetch }
  process.env.KV_REST_API_URL = 'http://fake-kv'; process.env.KV_REST_API_TOKEN = 'fake'
  globalThis.fetch = (async (_u: string, init: { body: string }) => {
    const a = (JSON.parse(init.body) as unknown[]).map(String); const cmd = a[0].toUpperCase()
    let result: unknown = null
    if (cmd === 'INCR') { const n = (parseInt(kv.get(a[1]) || '0', 10) || 0) + 1; kv.set(a[1], String(n)); result = n }
    else if (cmd === 'GET') result = kv.has(a[1]) ? kv.get(a[1]) : null
    else if (cmd === 'SET') { if (a.includes('NX') && kv.has(a[1])) result = null; else { kv.set(a[1], a[2]); result = 'OK' } }
    else if (cmd === 'DEL') { kv.delete(a[1]); result = 1 }
    else if (cmd === 'ZADD') { const arr = z.get(a[1]) ?? []; const m = a[3]; const f = arr.filter((x) => x.member !== m); f.push({ score: Number(a[2]), member: m }); z.set(a[1], f); result = 1 }
    else if (cmd === 'ZREVRANGE') { const arr = (z.get(a[1]) ?? []).slice().sort((x, y) => y.score - x.score).map((x) => x.member); result = arr.slice(Number(a[2]), a[3] === '-1' ? undefined : Number(a[3]) + 1) }
    else if (cmd === 'ZRANGE') { const arr = (z.get(a[1]) ?? []).slice().sort((x, y) => x.score - y.score).map((x) => x.member); result = arr.slice(Number(a[2]), Number(a[3]) + 1) }
    else if (cmd === 'ZCARD') result = (z.get(a[1]) ?? []).length
    else if (cmd === 'ZREM') { z.set(a[1], (z.get(a[1]) ?? []).filter((x) => x.member !== a[2])); result = 1 }
    else if (cmd === 'PEXPIRE' || cmd === 'EXPIRE') result = 1
    return { json: async () => ({ result }) }
  }) as never
  return { kv, restore() { globalThis.fetch = prev.fetch; if (prev.url === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = prev.url; if (prev.tok === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = prev.tok } }
}

async function seedActiveApproval(now: number, business = { id: 'supercharged', slug: 'supercharged' }, binding = BINDING) {
  const store = await import('../app/lib/platform/release/approval-store')
  const c = await store.createApproval({ now, business, binding, approvedBy: 'owner', phraseVerified: true })
  assert.equal(c.ok, true)
  return c.ok ? c.approval : (null as never)
}

function spyPromote(result: { ok: true; promotedDeploymentId?: string } | { ok: false; error: string }) {
  const calls: { project: string; dep: string }[] = []
  const fn = async (project: string, dep: string) => { calls.push({ project, dep }); return result }
  return { fn, calls }
}

// ── Executor: successful publish, consume, single promotion, audit ───────────
test('executor: successful simulated publish — one promotion, approval consumed, audit trail', async () => {
  const fake = installFakeKv()
  try {
    const { executePublish } = await import('../app/lib/platform/release/publish-executor')
    const { getActiveApprovalFor } = await import('../app/lib/platform/release/approval-store')
    const { listPlatformAuditForRef } = await import('../app/lib/platform/updates/audit')
    const now = 10_000_000
    const approval = await seedActiveApproval(now)
    const promote = spyPromote({ ok: true, promotedDeploymentId: 'dpl_prev9' })
    const r = await executePublish({ now: now + 1000, actor: 'owner', business: { id: 'supercharged', slug: 'supercharged', project: 'supercharged' }, approval, binding: BINDING, mode: 'simulated', promote: promote.fn })
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.publish.status, 'completed')
    assert.equal(promote.calls.length, 1)                       // EXACTLY ONE promotion

    // Approval is now consumed.
    const after = await getActiveApprovalFor('supercharged')
    assert.equal(after?.status, 'consumed')

    // Audit trail present.
    const events = await listPlatformAuditForRef({ businessId: 'supercharged' }, 50)
    const actions = events.map((e) => e.action)
    for (const a of ['approval.consumed', 'publish.started', 'deployment.promoted', 'publish.completed']) {
      assert.ok(actions.includes(a as never), `missing audit ${a}`)
    }
  } finally { fake.restore() }
})

test('executor: idempotent — a repeat for the same approval never promotes twice', async () => {
  const fake = installFakeKv()
  try {
    const { executePublish } = await import('../app/lib/platform/release/publish-executor')
    const now = 11_000_000
    const approval = await seedActiveApproval(now)
    const promote = spyPromote({ ok: true, promotedDeploymentId: 'dpl_prev9' })
    const biz = { id: 'supercharged', slug: 'supercharged', project: 'supercharged' }
    const r1 = await executePublish({ now: now + 1, actor: 'owner', business: biz, approval, binding: BINDING, mode: 'simulated', promote: promote.fn })
    const r2 = await executePublish({ now: now + 2, actor: 'owner', business: biz, approval, binding: BINDING, mode: 'simulated', promote: promote.fn })
    assert.equal(r1.ok && !r1.idempotent, true)
    assert.equal(r2.ok && r2.idempotent, true)                  // second returns the SAME record
    assert.ok(r1.ok && r2.ok)
    if (r1.ok && r2.ok) assert.equal(r1.publish.id, r2.publish.id)
    assert.equal(promote.calls.length, 1)                       // promoted once, not twice
  } finally { fake.restore() }
})

test('executor: promote failure → publish.failed, approval still consumed (no retry, no rollback)', async () => {
  const fake = installFakeKv()
  try {
    const { executePublish } = await import('../app/lib/platform/release/publish-executor')
    const { getActiveApprovalFor } = await import('../app/lib/platform/release/approval-store')
    const { listPlatformAuditForRef } = await import('../app/lib/platform/updates/audit')
    const now = 12_000_000
    const approval = await seedActiveApproval(now, { id: 'jkiss', slug: 'jkiss' }, { ...BINDING, businessId: 'jkiss' })
    const promote = spyPromote({ ok: false, error: 'Vercel auth/permission denied' })
    const r = await executePublish({ now: now + 1, actor: 'owner', business: { id: 'jkiss', slug: 'jkiss', project: 'jkissllc' }, approval, binding: { ...BINDING, businessId: 'jkiss' }, mode: 'live', promote: promote.fn })
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.code, 'PROMOTE_FAILED')
    assert.equal(!r.ok && r.publish?.status, 'failed')
    assert.equal((await getActiveApprovalFor('jkiss'))?.status, 'consumed')  // single-use: burned
    const actions = (await listPlatformAuditForRef({ businessId: 'jkiss' }, 50)).map((e) => e.action)
    assert.ok(actions.includes('publish.failed' as never))
    assert.equal(actions.includes('publish.completed' as never), false)
  } finally { fake.restore() }
})

test('executor: LIVE verify READY → completed (real verification, not faked)', async () => {
  const fake = installFakeKv()
  try {
    const { executePublish } = await import('../app/lib/platform/release/publish-executor')
    const now = 14_000_000
    const approval = await seedActiveApproval(now, { id: 'supercharged', slug: 'supercharged' })
    const promote = spyPromote({ ok: true, promotedDeploymentId: 'dpl_prev9' })
    const verifyCalls: string[] = []
    const verify = async (_p: string, dep: string) => { verifyCalls.push(dep); return { ready: true } }
    const r = await executePublish({ now: now + 1, actor: 'owner', business: { id: 'supercharged', slug: 'supercharged', project: 'jkissllc' }, approval, binding: BINDING, mode: 'live', promote: promote.fn, verify })
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.publish.status, 'completed')
    assert.deepEqual(verifyCalls, ['dpl_prev9'])                // verification actually ran
  } finally { fake.restore() }
})

test('executor: LIVE verify NOT READY → failed (no fake completion)', async () => {
  const fake = installFakeKv()
  try {
    const { executePublish } = await import('../app/lib/platform/release/publish-executor')
    const now = 15_000_000
    const approval = await seedActiveApproval(now, { id: 'jkiss', slug: 'jkiss' }, { ...BINDING, businessId: 'jkiss' })
    const promote = spyPromote({ ok: true, promotedDeploymentId: 'dpl_prev9' })
    const verify = async () => ({ ready: false })
    const r = await executePublish({ now: now + 1, actor: 'owner', business: { id: 'jkiss', slug: 'jkiss', project: 'jkissllc' }, approval, binding: { ...BINDING, businessId: 'jkiss' }, mode: 'live', promote: promote.fn, verify })
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.code, 'PROMOTE_FAILED')
    assert.equal(!r.ok && r.publish?.status, 'failed')          // never faked to completed
  } finally { fake.restore() }
})

test('executor: SIMULATED mode never verifies (no verifying step claimed)', async () => {
  const fake = installFakeKv()
  try {
    const { executePublish } = await import('../app/lib/platform/release/publish-executor')
    const now = 16_000_000
    const approval = await seedActiveApproval(now, { id: 'supercharged', slug: 'supercharged' })
    const promote = spyPromote({ ok: true, promotedDeploymentId: 'dpl_prev9' })
    let verifyCalled = false
    const verify = async () => { verifyCalled = true; return { ready: true } }
    const r = await executePublish({ now: now + 1, actor: 'owner', business: { id: 'supercharged', slug: 'supercharged', project: 'jkissllc' }, approval, binding: BINDING, mode: 'simulated', promote: promote.fn, verify })
    assert.equal(r.ok && r.publish.status, 'completed')
    assert.equal(verifyCalled, false)                           // simulated never claims verification
  } finally { fake.restore() }
})

test('executor: refuses when the approval is not consumable (expired/changed)', async () => {
  const fake = installFakeKv()
  try {
    const { executePublish } = await import('../app/lib/platform/release/publish-executor')
    const now = 13_000_000
    const approval = await seedActiveApproval(now, { id: 'supercharged', slug: 'supercharged' })
    const promote = spyPromote({ ok: true })
    // Execute far in the future → approval expired → not consumable.
    const r = await executePublish({ now: now + APPROVAL_TTL_MS + 1, actor: 'owner', business: { id: 'supercharged', slug: 'supercharged', project: 'supercharged' }, approval, binding: BINDING, mode: 'simulated', promote: promote.fn })
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.code, 'APPROVAL_NOT_CONSUMABLE')
    assert.equal(promote.calls.length, 0)                       // never promoted
  } finally { fake.restore() }
})

// ── STATIC safety guards ─────────────────────────────────────────────────────
function src(rel: string) { return readFileSync(new URL(rel, import.meta.url), 'utf8') }
test('safety: publish modules never merge, dispatch, rollback, or touch secrets', () => {
  for (const f of ['../app/lib/platform/release/publish.ts', '../app/lib/platform/release/publish-store.ts', '../app/lib/platform/release/publish-executor.ts']) {
    const s = src(f)
    for (const bad of ['dispatchWorkflow', 'createBranch', 'mergePullRequest', 'createPullRequest', 'advanceRollback', 'rollback', 'saveBusiness', 'saveJob', 'VERCEL_TOKEN', 'GITHUB_APP', 'KV_REST_API']) {
      assert.equal(s.includes(bad), false, `${f} must not reference ${bad}`)
    }
  }
})
test('safety: route is owner-gated, revalidates, and promotes LIVE only in Production runtime', () => {
  const s = src('../app/api/admin/release/businesses/[id]/publish/route.ts')
  assert.match(s, /requirePlatformOwner/)
  assert.match(s, /evaluatePublishGate/)
  assert.match(s, /resolvePublishMode/)
  assert.match(s, /no-store/)
  // The real Vercel promote is reached ONLY on mode === 'live' (which requires VERCEL_ENV production + flag).
  assert.match(s, /mode === 'live'\s*\n?\s*\?\s*async[\s\S]*promoteProduction/)
  assert.match(s, /simulated — no Vercel call/)
})
test('safety: executor consumes the approval BEFORE promoting (single-use, idempotent)', () => {
  const s = src('../app/lib/platform/release/publish-executor.ts')
  assert.ok(s.indexOf('consumeApproval') < s.indexOf('i.promote('), 'approval must be consumed before promote')
  assert.match(s, /getPublishByApproval/)               // idempotency anchor
  assert.match(s, /acquirePublishLock/)                 // concurrency guard
})
