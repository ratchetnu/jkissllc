// Increment 3B.6 — Controlled Rollback tests. Pure gate + rollback-target read + executor/store
// (idempotency, single restore, promote-failure, audit) against a hermetic in-memory KV, with an
// INJECTED promote (no real Vercel call). Plus static safety guards. No live KV, no network, no execution.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  rollbackPhrase, matchesRollbackPhrase, resolveRollbackMode, evaluateRollbackGate, rollbackUxState,
  type RollbackGateInput,
} from '../app/lib/platform/release/rollback'
import { readRollbackTarget } from '../app/lib/platform/release/production-deployment'
import { productionProjectFor } from '../app/lib/platform/production-project'

test('production target: explicit Production id, then legacy deployProject, never Preview', () => {
  assert.equal(productionProjectFor({ productionProjectId: 'prod-explicit', deployProject: 'prod-legacy' }), 'prod-explicit')
  assert.equal(productionProjectFor({ productionProjectId: undefined, deployProject: 'prod-legacy' }), 'prod-legacy')
  assert.equal(productionProjectFor({ productionProjectId: undefined, deployProject: undefined }), undefined)
})

// ── PURE: phrase + mode + ux ──────────────────────────────────────────────────
test('rollback phrase: ROLLBACK <SLUG> FROM PRODUCTION, distinct + non-generic', () => {
  assert.equal(rollbackPhrase('supercharged'), 'ROLLBACK SUPERCHARGED FROM PRODUCTION')
  assert.equal(matchesRollbackPhrase('rollback supercharged from production', 'supercharged'), true)
  assert.equal(matchesRollbackPhrase('PUBLISH SUPERCHARGED TO PRODUCTION', 'supercharged'), false)
  assert.equal(matchesRollbackPhrase('CONFIRM', 'supercharged'), false)
})
test('rollback mode: live only in Production runtime + flag; else simulated', () => {
  assert.equal(resolveRollbackMode({ VERCEL_ENV: 'production', OPERION_PRODUCTION_PROMOTION_ENABLED: 'true' }), 'live')
  assert.equal(resolveRollbackMode({ VERCEL_ENV: 'preview', OPERION_PRODUCTION_PROMOTION_ENABLED: 'true' }), 'simulated')
  assert.equal(resolveRollbackMode({ VERCEL_ENV: 'production' }), 'simulated')
})
test('rollback ux mapping', () => {
  assert.equal(rollbackUxState('rolling_back'), 'rolling_back')
  assert.equal(rollbackUxState('completed'), 'rolled_back')
  assert.equal(rollbackUxState('failed'), 'failed')
  assert.equal(rollbackUxState(undefined), 'idle')
})

// ── PURE: the rollback gate ───────────────────────────────────────────────────
const gate = (over: Partial<RollbackGateInput> = {}): RollbackGateInput => ({
  isOwner: true, gateEnabled: true, rollbackEnabled: true,
  business: { id: 'supercharged', slug: 'supercharged' }, testOnly: false,
  targetDeploymentId: 'dpl_prior', currentDeploymentId: 'dpl_current', concurrentRollback: false,
  claimedTargetDeploymentId: 'dpl_prior', phraseInput: 'ROLLBACK SUPERCHARGED FROM PRODUCTION', ...over,
})
const fail = (i: RollbackGateInput) => { const r = evaluateRollbackGate(i); return r.allowed ? true : r.code }

test('gate: allows an owner, enabled, target-present, phrase-correct rollback', () => {
  const r = evaluateRollbackGate(gate())
  assert.equal(r.allowed, true)
  assert.equal(r.allowed && r.targetDeploymentId, 'dpl_prior')
  assert.equal(r.allowed && r.fromDeploymentId, 'dpl_current')
})
test('gate: owner / gate-flag / rollback-flag / test-only rejections', () => {
  assert.equal(fail(gate({ isOwner: false })), 'OWNER_REQUIRED')
  assert.equal(fail(gate({ gateEnabled: false })), 'GATE_DISABLED')
  assert.equal(fail(gate({ rollbackEnabled: false })), 'ROLLBACK_DISABLED')
  assert.equal(fail(gate({ testOnly: true })), 'TEST_ONLY_BUSINESS')
})
test('gate: no target / nothing-to-roll-back / concurrency / target mismatch / phrase', () => {
  assert.equal(fail(gate({ targetDeploymentId: undefined })), 'ROLLBACK_TARGET_MISSING')
  assert.equal(fail(gate({ currentDeploymentId: 'dpl_prior' })), 'NOTHING_TO_ROLL_BACK')  // target === current
  assert.equal(fail(gate({ concurrentRollback: true })), 'CONCURRENT_ROLLBACK')
  assert.equal(fail(gate({ claimedTargetDeploymentId: 'dpl_other' })), 'TARGET_MISMATCH')
  assert.equal(fail(gate({ phraseInput: 'CONFIRM' })), 'PHRASE_MISMATCH')
  // a blocker outranks a correct phrase
  assert.equal(fail(gate({ testOnly: true, phraseInput: 'ROLLBACK SUPERCHARGED FROM PRODUCTION' })), 'TEST_ONLY_BUSINESS')
})

// ── readRollbackTarget: current [0] + prior [1] from Vercel ───────────────────
function mockFetch(deployments: unknown[]) {
  return (async () => ({ status: 200, ok: true, json: async () => ({ deployments }), text: async () => '' })) as never
}
test('readRollbackTarget: derives current + prior READY production deployments', async () => {
  const fetch = mockFetch([
    { uid: 'dpl_current', readyState: 'READY', target: 'production', createdAt: 3000, meta: { githubCommitSha: 'newsha' } },
    { uid: 'dpl_prior', readyState: 'READY', target: 'production', createdAt: 2000, meta: { githubCommitSha: 'oldsha' } },
    { uid: 'dpl_older', readyState: 'READY', target: 'production', createdAt: 1000 },
  ])
  const t = await readRollbackTarget({ productionProjectId: 'supercharged' }, { VERCEL_TOKEN: 'vc' }, { fetch })
  assert.equal(t.currentDeploymentId, 'dpl_current')
  assert.equal(t.targetDeploymentId, 'dpl_prior')
  assert.equal(t.targetCommit, 'oldsha')
})
test('readRollbackTarget: empty when <2 production deployments / no project / unconfigured', async () => {
  assert.deepEqual(await readRollbackTarget({ productionProjectId: 'p' }, {}, { fetch: mockFetch([]) }), {})           // no token
  const one = await readRollbackTarget({ productionProjectId: 'p' }, { VERCEL_TOKEN: 'vc' }, { fetch: mockFetch([{ uid: 'only', readyState: 'READY', target: 'production', createdAt: 1 }]) })
  assert.equal(one.currentDeploymentId, 'only')
  assert.equal(one.targetDeploymentId, undefined)   // nothing prior to restore
})

// ── Executor + store (in-memory KV with zsets) ───────────────────────────────
function installFakeKv() {
  const kv = new Map<string, string>(); const z = new Map<string, { s: number; m: string }[]>()
  const prev = { url: process.env.KV_REST_API_URL, tok: process.env.KV_REST_API_TOKEN, fetch: globalThis.fetch }
  process.env.KV_REST_API_URL = 'http://fake'; process.env.KV_REST_API_TOKEN = 'fake'
  globalThis.fetch = (async (_u: string, init: { body: string }) => {
    const a = (JSON.parse(init.body) as unknown[]).map(String); const c = a[0].toUpperCase(); let result: unknown = null
    if (c === 'INCR') { const n = (parseInt(kv.get(a[1]) || '0', 10) || 0) + 1; kv.set(a[1], String(n)); result = n }
    else if (c === 'GET') result = kv.has(a[1]) ? kv.get(a[1]) : null
    else if (c === 'SET') { if (a.includes('NX') && kv.has(a[1])) result = null; else { kv.set(a[1], a[2]); result = 'OK' } }
    else if (c === 'DEL') { kv.delete(a[1]); result = 1 }
    else if (c === 'EVAL') {
      const key = a[3]; const expected = a[4]
      if (kv.get(key) === expected) { kv.delete(key); result = 1 } else result = 0
    }
    else if (c === 'ZADD') { const arr = (z.get(a[1]) ?? []).filter((x) => x.m !== a[3]); arr.push({ s: Number(a[2]), m: a[3] }); z.set(a[1], arr); result = 1 }
    else if (c === 'ZREVRANGE') { const arr = (z.get(a[1]) ?? []).slice().sort((x, y) => y.s - x.s).map((x) => x.m); result = arr.slice(Number(a[2]), a[3] === '-1' ? undefined : Number(a[3]) + 1) }
    else if (c === 'ZADD' || c === 'PEXPIRE') result = 1
    else if (c === 'PEXPIRE') result = 1
    return { json: async () => ({ result }) }
  }) as never
  return { restore() { globalThis.fetch = prev.fetch; if (prev.url === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = prev.url; if (prev.tok === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = prev.tok } }
}
const spyPromote = (result: { ok: true } | { ok: false; error: string }) => { const calls: string[] = []; return { calls, fn: async (_p: string, d: string) => { calls.push(d); return result } } }

test('executor: successful simulated rollback — one restore, audit trail', async () => {
  const fake = installFakeKv()
  try {
    const { executeRollback } = await import('../app/lib/platform/release/rollback-executor')
    const { listPlatformAuditForRef } = await import('../app/lib/platform/updates/audit')
    const p = spyPromote({ ok: true })
    const r = await executeRollback({ now: 1000, actor: 'owner', business: { id: 'supercharged', slug: 'supercharged', project: 'supercharged' }, targetDeploymentId: 'dpl_prior', targetCommit: 'oldsha', fromDeploymentId: 'dpl_current', mode: 'simulated', promote: p.fn })
    assert.equal(r.ok, true)
    assert.equal(r.ok && r.rollback.status, 'completed')
    assert.equal(p.calls.length, 1)
    const actions = (await listPlatformAuditForRef({ businessId: 'supercharged' }, 50)).map((e) => e.action)
    assert.ok(actions.includes('rollback.started' as never))
    assert.ok(actions.includes('rollback.completed' as never))
  } finally { fake.restore() }
})
test('executor: idempotent — repeat for the same target never restores twice', async () => {
  const fake = installFakeKv()
  try {
    const { executeRollback } = await import('../app/lib/platform/release/rollback-executor')
    const p = spyPromote({ ok: true })
    const biz = { id: 'jkiss', slug: 'jkiss', project: 'jkissllc' }
    const r1 = await executeRollback({ now: 1, actor: 'owner', business: biz, targetDeploymentId: 'dpl_x', mode: 'simulated', promote: p.fn })
    const r2 = await executeRollback({ now: 2, actor: 'owner', business: biz, targetDeploymentId: 'dpl_x', mode: 'simulated', promote: p.fn })
    assert.equal(r1.ok && !r1.idempotent, true)
    assert.equal(r2.ok && r2.idempotent, true)
    assert.equal(p.calls.length, 1)
  } finally { fake.restore() }
})
test('executor: promote failure → rollback.failed record + audit', async () => {
  const fake = installFakeKv()
  try {
    const { executeRollback } = await import('../app/lib/platform/release/rollback-executor')
    const p = spyPromote({ ok: false, error: 'Vercel permission denied' })
    const r = await executeRollback({ now: 1, actor: 'owner', business: { id: 'supercharged', slug: 'supercharged', project: 'supercharged' }, targetDeploymentId: 'dpl_prior', mode: 'live', promote: p.fn })
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.code, 'PROMOTE_FAILED')
    assert.equal(!r.ok && r.rollback?.status, 'failed')
    const { getRollbackByTarget } = await import('../app/lib/platform/release/rollback-store')
    assert.equal(await getRollbackByTarget('supercharged', 'dpl_prior'), null)
  } finally { fake.restore() }
})

test('executor: failed restore can retry; only the successful retry becomes idempotent', async () => {
  const fake = installFakeKv()
  try {
    const { executeRollback } = await import('../app/lib/platform/release/rollback-executor')
    const calls: string[] = []
    let attempt = 0
    const promote = async (_project: string, deployment: string) => {
      calls.push(deployment); attempt += 1
      return attempt === 1 ? { ok: false as const, error: 'temporary provider failure' } : { ok: true as const }
    }
    const input = { actor: 'owner', business: { id: 'retry-biz', slug: 'retry-biz', project: 'retry-biz' }, targetDeploymentId: 'dpl_retry', mode: 'live' as const, promote }
    const failed = await executeRollback({ ...input, now: 1 })
    const retried = await executeRollback({ ...input, now: 2 })
    const repeated = await executeRollback({ ...input, now: 3 })
    assert.equal(failed.ok, false)
    assert.equal(retried.ok && !retried.idempotent && retried.rollback.status, 'completed')
    assert.equal(repeated.ok && repeated.idempotent && repeated.rollback.status, 'completed')
    assert.equal(calls.length, 2)
    assert.notEqual(!failed.ok && failed.rollback?.id, retried.ok && retried.rollback.id)
  } finally { fake.restore() }
})

// ── Static safety ─────────────────────────────────────────────────────────────
function src(rel: string) { return readFileSync(new URL(rel, import.meta.url), 'utf8') }
test('safety: rollback modules never merge/dispatch/mutate-business/touch-secrets', () => {
  for (const f of ['../app/lib/platform/release/rollback.ts', '../app/lib/platform/release/rollback-store.ts', '../app/lib/platform/release/rollback-executor.ts']) {
    const s = src(f)
    for (const bad of ['dispatchWorkflow', 'createBranch', 'mergePullRequest', 'saveBusiness', 'saveJob', 'VERCEL_TOKEN', 'GITHUB_APP', 'KV_REST_API']) {
      assert.equal(s.includes(bad), false, `${f} must not reference ${bad}`)
    }
  }
})
test('safety: Production orchestration never falls back to previewProjectId', () => {
  const s = src('../app/lib/platform/automation/orchestrator.ts')
  assert.equal(/productionProjectId\s*\|\|\s*[^\n]*previewProjectId/.test(s), false)
  assert.match(s, /productionProjectFor\(input\.business\)/)
  assert.ok((s.match(/productionProjectFor\(business\)/g) ?? []).length >= 3)
})
test('safety: rollback route is owner-gated, flag-gated, no-store, LIVE only in prod runtime', () => {
  const s = src('../app/api/admin/release/businesses/[id]/rollback/route.ts')
  assert.match(s, /requirePlatformOwner/)
  assert.match(s, /evaluateRollbackGate/)
  assert.match(s, /resolveRollbackMode/)
  assert.match(s, /no-store/)
  assert.match(s, /mode === 'live'\s*\n?\s*\?\s*async[\s\S]*rollbackProduction/)
  assert.equal(s.includes('vercel.promoteProduction'), false)
  assert.match(s, /simulated — no Vercel call/)
  assert.match(s, /rolledBackPublishId: reversedPublish\?\.id/)
})
test('safety: automatic rollback uses rollback API while publish keeps promote API', () => {
  const orchestrator = src('../app/lib/platform/automation/orchestrator.ts')
  const publish = src('../app/api/admin/release/businesses/[id]/publish/route.ts')
  assert.match(orchestrator, /rollbackTargetDeploymentId\s*\?\s*await vercel\.rollbackProduction/)
  assert.match(publish, /vercel\.promoteProduction/)
})
