// N+1 batching regression: listApprovals was refactored from a serial await-in-loop
// (up to `limit` Redis round-trips, polled every 12s by the workflow timeline) to a
// single Promise.all fan-out. This proves the refactor preserved semantics exactly —
// newest-first order, status filtering, and skipping index entries whose record is
// gone. Uses the store's injected-client factory, so it's pure (no Redis).
import assert from 'node:assert/strict'
import test from 'node:test'

import { makeApprovals, type ApprovalClient } from '../app/lib/approvals-store'
import type { ApprovalRequest } from '../app/lib/platform/approvals/types'

function memClient() {
  const kv = new Map<string, string>()
  const zs = new Map<string, Map<string, number>>()
  const zk = (k: string) => zs.get(k) ?? zs.set(k, new Map()).get(k)!
  const client: ApprovalClient = {
    async get(k) { return kv.get(k) ?? null },
    async set(k, v) { kv.set(k, v) },
    async zadd(k, score, member) { zk(k).set(member, score) },
    async zrevrange(k, start, stop) {
      const arr = [...zk(k).entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])
      return arr.slice(start, stop === -1 ? arr.length : stop + 1)
    },
  }
  return { client, kv }
}

const appr = (o: Partial<ApprovalRequest>): ApprovalRequest => ({
  id: 'a', tenantId: 't1', createdAt: 1, status: 'pending',
  requestedAction: 'send', requestingWorkerId: 'w', approverRole: 'admin',
  riskClass: 'low', actionPreview: '', explanation: '', evidence: [], confidence: 1,
  expectedImpact: '', expiresAt: 0,
  ...o,
} as unknown as ApprovalRequest)

test('listApprovals returns newest-first (order preserved after batching)', async () => {
  const { client } = memClient()
  const store = makeApprovals(client)
  await store.saveApproval(appr({ id: 'a1', createdAt: 100 }))
  await store.saveApproval(appr({ id: 'a2', createdAt: 300 }))
  await store.saveApproval(appr({ id: 'a3', createdAt: 200 }))
  const out = await store.listApprovals('t1')
  assert.deepEqual(out.map((r) => r.id), ['a2', 'a3', 'a1'])
})

test('listApprovals still filters by status', async () => {
  const { client } = memClient()
  const store = makeApprovals(client)
  await store.saveApproval(appr({ id: 'p', createdAt: 2, status: 'pending' }))
  await store.saveApproval(appr({ id: 'd', createdAt: 1, status: 'approved' }))
  const pending = await store.listApprovals('t1', { status: 'pending' })
  assert.deepEqual(pending.map((r) => r.id), ['p'])
})

test('listApprovals skips ids whose record is missing (null-safe batch)', async () => {
  const { client, kv } = memClient()
  const store = makeApprovals(client)
  await store.saveApproval(appr({ id: 'x1', createdAt: 2 }))
  await store.saveApproval(appr({ id: 'x2', createdAt: 1 }))
  kv.delete('appr:x1') // index still references it, but the record is gone
  const out = await store.listApprovals('t1')
  assert.deepEqual(out.map((r) => r.id), ['x2'])
})

test('listApprovals honors the limit window', async () => {
  const { client } = memClient()
  const store = makeApprovals(client)
  for (let i = 0; i < 5; i++) await store.saveApproval(appr({ id: `n${i}`, createdAt: i }))
  const out = await store.listApprovals('t1', { limit: 2 })
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((r) => r.id), ['n4', 'n3'], 'newest two only')
})
