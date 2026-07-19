// Increment 3B.6 — Release History & Details tests (pure projection + store list/index).
// Hermetic: pure builders + an in-memory Upstash-REST fake with sorted-set support. No live
// KV, no network, no execution.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildReleaseHistory, filterReleaseHistory, buildReleaseDetails, publishToHistoryEntry, rollbackToHistoryEntry,
  type ReleaseRollback,
} from '../app/lib/platform/release/release-history'
import type { ReleasePublish } from '../app/lib/platform/release/publish-store'
import type { ReleaseApproval } from '../app/lib/platform/release/approval'
import type { PlatformAuditEvent } from '../app/lib/platform/updates/audit'

// ── Fixtures ──────────────────────────────────────────────────────────────────
const pub = (over: Partial<ReleasePublish> = {}): ReleasePublish => ({
  recordVersion: 1, id: 'PUB-1001', businessId: 'supercharged', businessSlug: 'supercharged', approvalId: 'APRV-1001',
  releaseId: 'abc1234', sourceDeploymentId: 'dpl_prev', targetEnvironment: 'production', mode: 'simulated',
  status: 'completed', promotedDeploymentId: 'dpl_prev', startedAt: 1000, updatedAt: 2000, completedAt: 2000, startedBy: 'owner', ...over,
})
const appr = (over: Partial<ReleaseApproval> = {}): ReleaseApproval => ({
  recordVersion: 1, id: 'APRV-1001', businessId: 'supercharged', businessSlug: 'supercharged', releaseId: 'abc1234',
  sourceDeploymentId: 'dpl_prev', targetEnvironment: 'production', bindingFingerprint: 'fp', approvedBy: 'owner',
  approvedAt: 900, expiresAt: 999999, phraseVerified: true, status: 'consumed', createdSource: 'test', ...over,
})
const rbk = (over: Partial<ReleaseRollback> = {}): ReleaseRollback => ({
  recordVersion: 1, id: 'RBK-1001', businessId: 'supercharged', businessSlug: 'supercharged',
  targetDeploymentId: 'dpl_old', targetCommit: 'oldsha', fromDeploymentId: 'dpl_prev', rolledBackPublishId: 'PUB-1001',
  targetEnvironment: 'production', mode: 'simulated', status: 'completed', approvedBy: 'owner', approvedAt: 3000,
  startedAt: 3100, updatedAt: 3200, completedAt: 3200, startedBy: 'owner', ...over,
})

// ── Mapping ───────────────────────────────────────────────────────────────────
test('publishToHistoryEntry maps a publish + approval into a release entry', () => {
  const e = publishToHistoryEntry(pub(), appr(), 'RBK-1001')
  assert.equal(e.kind, 'publish')
  assert.equal(e.commit, 'abc1234')
  assert.equal(e.deploymentId, 'dpl_prev')
  assert.equal(e.status, 'published')
  assert.equal(e.approvingOwner, 'owner')
  assert.equal(e.approvalAt, 900)
  assert.equal(e.publishAt, 2000)
  assert.equal(e.rolledBackByRollbackId, 'RBK-1001')  // this release was later rolled back
})
test('publish status maps to calm release status', () => {
  assert.equal(publishToHistoryEntry(pub({ status: 'promoting' })).status, 'publishing')
  assert.equal(publishToHistoryEntry(pub({ status: 'verifying' })).status, 'verifying')
  assert.equal(publishToHistoryEntry(pub({ status: 'failed', failureReason: 'x' })).status, 'publish_failed')
})
test('rollbackToHistoryEntry maps a rollback into a release entry', () => {
  const e = rollbackToHistoryEntry(rbk())
  assert.equal(e.kind, 'rollback')
  assert.equal(e.status, 'rolled_back')
  assert.equal(e.deploymentId, 'dpl_old')          // restored deployment
  assert.equal(e.rollbackOfPublishId, 'PUB-1001')
})

// ── History build (merge + sort + relationship) ──────────────────────────────
test('buildReleaseHistory merges publishes + rollbacks newest-first and links the reversal', () => {
  const publishes = [pub({ id: 'PUB-1001', startedAt: 1000 }), pub({ id: 'PUB-1002', startedAt: 5000, releaseId: 'def5678' })]
  const rollbacks = [rbk({ id: 'RBK-1001', rolledBackPublishId: 'PUB-1001', startedAt: 3100 })]
  const approvalsById = new Map([['APRV-1001', appr()]])
  const h = buildReleaseHistory({ publishes, approvalsById, rollbacks })
  assert.deepEqual(h.map((e) => e.id), ['PUB-1002', 'RBK-1001', 'PUB-1001'])  // newest first
  assert.equal(h.find((e) => e.id === 'PUB-1001')?.rolledBackByRollbackId, 'RBK-1001')
  assert.equal(h.find((e) => e.id === 'PUB-1002')?.rolledBackByRollbackId, undefined)
})

// ── Filters ───────────────────────────────────────────────────────────────────
test('filterReleaseHistory: business / environment / status / kind / date', () => {
  const entries = buildReleaseHistory({
    publishes: [pub({ id: 'PUB-1', businessId: 'supercharged', startedAt: 1000 }), pub({ id: 'PUB-2', businessId: 'jkiss', businessSlug: 'jkiss', status: 'failed', startedAt: 8000 })],
    approvalsById: new Map(), rollbacks: [rbk({ id: 'RBK-1', startedAt: 5000 })],
  })
  assert.deepEqual(filterReleaseHistory(entries, { businessId: 'jkiss' }).map((e) => e.id), ['PUB-2'])
  assert.deepEqual(filterReleaseHistory(entries, { status: 'publish_failed' }).map((e) => e.id), ['PUB-2'])
  assert.deepEqual(filterReleaseHistory(entries, { kind: 'rollback' }).map((e) => e.id), ['RBK-1'])
  assert.deepEqual(filterReleaseHistory(entries, { from: 2000, to: 6000 }).map((e) => e.id), ['RBK-1'])
  assert.equal(filterReleaseHistory(entries, { environment: 'production' }).length, 3)
})

// ── Details (audit trail) ────────────────────────────────────────────────────
test('buildReleaseDetails filters audit to the release business+commit and sorts oldest-first', () => {
  const entry = publishToHistoryEntry(pub())
  const audit: PlatformAuditEvent[] = [
    { id: 'PAUD-3', at: 2000, actor: 'owner', actorType: 'owner', source: 's', action: 'publish.completed', businessId: 'supercharged', commit: 'abc1234', summary: 'done' },
    { id: 'PAUD-1', at: 900, actor: 'owner', actorType: 'owner', source: 's', action: 'approval.created', businessId: 'supercharged', commit: 'abc1234', summary: 'approved' },
    { id: 'PAUD-X', at: 1500, actor: 'owner', actorType: 'owner', source: 's', action: 'approval.created', businessId: 'jkiss', commit: 'zzz', summary: 'other biz' },
  ]
  const d = buildReleaseDetails(entry, audit)
  assert.deepEqual(d.auditTrail.map((l) => l.id), ['PAUD-1', 'PAUD-3'])  // this biz+commit only, oldest first
})

// ── Store list/index via in-memory KV fake (sorted sets) ─────────────────────
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
    else if (c === 'ZADD') { const arr = (z.get(a[1]) ?? []).filter((x) => x.m !== a[3]); arr.push({ s: Number(a[2]), m: a[3] }); z.set(a[1], arr); result = 1 }
    else if (c === 'ZREVRANGE') { const arr = (z.get(a[1]) ?? []).slice().sort((x, y) => y.s - x.s).map((x) => x.m); result = arr.slice(Number(a[2]), a[3] === '-1' ? undefined : Number(a[3]) + 1) }
    else if (c === 'PEXPIRE') result = 1
    return { json: async () => ({ result }) }
  }) as never
  return { restore() { globalThis.fetch = prev.fetch; if (prev.url === undefined) delete process.env.KV_REST_API_URL; else process.env.KV_REST_API_URL = prev.url; if (prev.tok === undefined) delete process.env.KV_REST_API_TOKEN; else process.env.KV_REST_API_TOKEN = prev.tok } }
}

test('publish-store index: listPublishes returns saved records newest-first', async () => {
  const fake = installFakeKv()
  try {
    const store = await import('../app/lib/platform/release/publish-store')
    await store.savePublish(pub({ id: 'PUB-1001', startedAt: 1000 }))
    await store.savePublish(pub({ id: 'PUB-1002', startedAt: 3000 }))
    const list = await store.listPublishes(10)
    assert.deepEqual(list.map((p) => p.id), ['PUB-1002', 'PUB-1001'])
  } finally { fake.restore() }
})
test('rollback-store: startRollback → index + target pointer; listRollbacks newest-first', async () => {
  const fake = installFakeKv()
  try {
    const store = await import('../app/lib/platform/release/rollback-store')
    const r1 = await store.startRollback({ now: 1000, businessId: 'supercharged', businessSlug: 'supercharged', targetDeploymentId: 'dpl_old', mode: 'simulated', startedBy: 'owner' })
    await store.completeRollback(r1.id, 1200)
    const byTarget = await store.getRollbackByTarget('supercharged', 'dpl_old')
    assert.equal(byTarget?.id, r1.id)
    assert.equal(byTarget?.status, 'completed')
    const list = await store.listRollbacks(10)
    assert.equal(list[0].id, r1.id)
  } finally { fake.restore() }
})
