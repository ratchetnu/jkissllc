// Approval assessment logic + approvals-store persistence/filtering. Hermetic.
import assert from 'node:assert/strict'
import test from 'node:test'

import { assessQuoteApproval } from '../app/lib/intake-workflow'
import { makeApprovals } from '../app/lib/approvals-store'
import type { StoredAiEstimate } from '../app/lib/ai/estimate-store'
import type { ApprovalRequest } from '../app/lib/platform/approvals/types'

const est = (over: Record<string, unknown> = {}): StoredAiEstimate => ({
  decision: 'instant_quote',
  pricing: { recommendedUsd: 300, lowUsd: 250, highUsd: 400, breakdown: {} },
  analysis: { confidence: { overall: 0.9 } },
  reviewReasons: [],
  ...over,
} as unknown as StoredAiEstimate)

test('assessQuoteApproval: a confident low-value instant quote needs no approval', () => {
  const a = assessQuoteApproval(est())
  assert.equal(a.needsApproval, false)
  assert.equal(a.risk, 'low')
})

test('assessQuoteApproval: manual_review requires approval at medium risk', () => {
  const a = assessQuoteApproval(est({ decision: 'manual_review' }))
  assert.equal(a.needsApproval, true)
  assert.equal(a.risk, 'medium')
  assert.match(a.reasons.join(' '), /manual review/i)
})

test('assessQuoteApproval: an independent-reviewer downgrade requires approval', () => {
  const a = assessQuoteApproval(est({ critic: { recommend: 'review' } }))
  assert.equal(a.needsApproval, true)
  assert.match(a.reasons.join(' '), /independent reviewer/i)
})

test('assessQuoteApproval: a high-value quote is high risk and needs approval', () => {
  const a = assessQuoteApproval(est({ pricing: { recommendedUsd: 2500, lowUsd: 2000, highUsd: 3000, breakdown: {} } }))
  assert.equal(a.needsApproval, true)
  assert.equal(a.risk, 'high')
})

function fakeApprovalKV() {
  const s = new Map<string, string>()
  const z = new Map<string, Array<[number, string]>>()
  return {
    async get(k: string) { return s.get(k) ?? null },
    async set(k: string, v: string) { s.set(k, v) },
    async zadd(k: string, score: number, m: string) { const a = (z.get(k) ?? []).filter(([, mm]) => mm !== m); a.push([score, m]); z.set(k, a) },
    async zrevrange(k: string, start: number, stop: number) {
      const a = (z.get(k) ?? []).slice().sort((x, y) => y[0] - x[0]); return a.slice(start, stop + 1).map((m) => m[1])
    },
  }
}

const appr = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'appr_1', tenantId: 'jkiss', requestedAction: 'quote.send', requestingWorkerId: 'ai-sales',
  approverRole: 'admin', riskClass: 'medium', actionPreview: 'x', explanation: 'y', evidence: [],
  confidence: 0.5, expectedImpact: 'z', expiresAt: 9e12, status: 'pending', createdAt: 1000, ...over,
})

test('approvals-store round-trips and filters by status/tenant', async () => {
  const store = makeApprovals(fakeApprovalKV())
  await store.saveApproval(appr({ id: 'appr_1', status: 'pending', createdAt: 1000 }))
  await store.saveApproval(appr({ id: 'appr_2', status: 'approved', createdAt: 2000 }))
  assert.equal((await store.getApproval('appr_1'))?.status, 'pending')
  const pending = await store.listApprovals('jkiss', { status: 'pending' })
  assert.deepEqual(pending.map((a) => a.id), ['appr_1'])
  const all = await store.listApprovals('jkiss')
  assert.deepEqual(all.map((a) => a.id), ['appr_2', 'appr_1']) // newest-first
  assert.equal((await store.listApprovals('other')).length, 0)
})
