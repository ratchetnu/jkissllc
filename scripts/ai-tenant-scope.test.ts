// Tenant read-scope for the AI audit log (audit H-AI-2). `ai:*` is a platform-global
// key family — `ai:log`/`ai:call:*` are one shared physical set — so the isolation
// chokepoint deliberately does NOT prefix them. Tenant isolation on the READ/rollup
// path is therefore enforced in application code (scopeAiRecords), filtering on the
// `tenantId` stamped on every record.
//
// This pins the two required behaviors:
//   • TENANCY_ENABLED=false → UNCHANGED (returns all records, byte-identical to today)
//   • TENANCY_ENABLED=true  → only the current tenant's records; cross-tenant denied;
//                             no-tenant-context fails CLOSED (returns none)
import assert from 'node:assert/strict'
import test from 'node:test'

import { scopeAiRecords, type AiCallRecord, PROPOSED_TENANT_AI_KEYS } from '../app/lib/ai/telemetry'
import { computeAiAnalytics } from '../app/lib/ai/analytics'
import { runWithTenant } from '../app/lib/platform/tenancy/context'

function rec(id: string, tenantId: string): AiCallRecord {
  return {
    id, at: 1, tenantId, actor: 'owner', role: 'admin', feature: 'ops.command',
    taskId: 'ops.command', promptVersion: 1, model: 'anthropic/claude-sonnet-4-6',
    ok: true, outcome: 'success', latencyMs: 100, inputTokens: 10, outputTokens: 5,
    totalTokens: 15, estCostUsd: 0.001, requestChars: 20, responseValid: true,
  }
}

const A1 = rec('a1', 'jkiss')
const A2 = rec('a2', 'jkiss')
const B1 = rec('b1', 'supercharged')
const ALL = [A1, A2, B1]

// Toggle the flag around a body, always restoring prior state (tests share process.env).
function withFlag(value: boolean | undefined, body: () => void) {
  const prev = process.env.TENANCY_ENABLED
  if (value === undefined) delete process.env.TENANCY_ENABLED
  else process.env.TENANCY_ENABLED = value ? 'true' : 'false'
  try { body() } finally {
    if (prev === undefined) delete process.env.TENANCY_ENABLED
    else process.env.TENANCY_ENABLED = prev
  }
}

test('[off] flag disabled → scopeAiRecords returns ALL records unchanged (inert, even inside a tenant)', () => {
  withFlag(false, () => {
    assert.deepEqual(scopeAiRecords(ALL), ALL)
    // Even with a tenant context established, OFF means no filtering at all.
    const out = runWithTenant({ tenantId: 'jkiss' }, () => scopeAiRecords(ALL))
    assert.deepEqual(out, ALL)
  })
})

test('[off/default] absent flag env behaves as disabled → returns ALL', () => {
  withFlag(undefined, () => {
    assert.deepEqual(scopeAiRecords(ALL), ALL)
  })
})

test('[on] enabled + tenant=jkiss → only jkiss records; supercharged denied', () => {
  withFlag(true, () => {
    const out = runWithTenant({ tenantId: 'jkiss' }, () => scopeAiRecords(ALL))
    assert.deepEqual(out.map(r => r.id), ['a1', 'a2'])
    assert.ok(!out.some(r => r.tenantId === 'supercharged'), 'no cross-tenant record leaks')
  })
})

test('[on] enabled + tenant=supercharged → only that tenant sees only b1', () => {
  withFlag(true, () => {
    const out = runWithTenant({ tenantId: 'supercharged' }, () => scopeAiRecords(ALL))
    assert.deepEqual(out.map(r => r.id), ['b1'])
  })
})

test('[on/fail-closed] enabled + NO tenant context → returns none (no cross-tenant disclosure)', () => {
  withFlag(true, () => {
    assert.deepEqual(scopeAiRecords(ALL), [])
  })
})

test('[rollup off] computeAiAnalytics counts every tenant when flag off', async () => {
  await new Promise<void>((resolve, reject) => {
    withFlag(false, () => {
      // list dep applies scopeAiRecords, exactly like the real listAiCalls path.
      computeAiAnalytics(2000, { list: async () => scopeAiRecords(ALL), today: async () => 0, cap: () => 0, now: () => 1 })
        .then(a => { assert.equal(a.totals.calls, 3); resolve() })
        .catch(reject)
    })
  })
})

test('[rollup on] computeAiAnalytics rolls up ONLY the current tenant when flag on', async () => {
  const analytics = await runWithTenant({ tenantId: 'jkiss' }, () => {
    process.env.TENANCY_ENABLED = 'true'
    return computeAiAnalytics(2000, {
      list: async () => scopeAiRecords(ALL), today: async () => 0, cap: () => 0, now: () => 1,
    })
  })
  delete process.env.TENANCY_ENABLED
  assert.equal(analytics.totals.calls, 2, 'jkiss only — supercharged excluded from the rollup')
})

test('[proposal] per-tenant AI key builders are dark-launch shapes, distinct per tenant, not `t:`-prefixed', () => {
  assert.equal(PROPOSED_TENANT_AI_KEYS.index('jkiss'), 'ai:log:jkiss')
  assert.notEqual(PROPOSED_TENANT_AI_KEYS.index('jkiss'), PROPOSED_TENANT_AI_KEYS.index('supercharged'))
  assert.equal(PROPOSED_TENANT_AI_KEYS.record('jkiss', 'x'), 'ai:call:jkiss:x')
  // Not the reserved tenant-prefix form (those are built ONLY in keys.ts).
  assert.ok(!PROPOSED_TENANT_AI_KEYS.index('jkiss').startsWith('t:'))
})
