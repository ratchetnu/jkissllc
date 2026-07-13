// AI worker governance — every safety gate from Part 3.
import assert from 'node:assert/strict'
import test from 'node:test'

import { AI_WORKER_REGISTRY, getWorker, allWorkers } from '../app/lib/platform/ai-workers/registry'
import { authorizeWorkerAction } from '../app/lib/platform/ai-workers/governance'

const JKISS = { id: 'jkiss' }
const admin = { sub: 'owner', role: 'admin' as const, tenantId: 'jkiss' }
const crew = { sub: 'c1', role: 'crew' as const, tenantId: 'jkiss' }

// Base allow request: admin invoking AI COO for a read-only insight.
function allowReq(over: Record<string, unknown> = {}) {
  return {
    worker: getWorker('ai-coo'), actor: admin, tenant: JKISS,
    autonomyLevel: 1 as const, capability: 'reporting' as const, tool: 'ops.insights',
    workforceEnabled: true, ...over,
  }
}

test('all nine workers are registered', () => {
  assert.equal(allWorkers().length, 9)
  assert.ok(AI_WORKER_REGISTRY['ai-coo'])
})

test('baseline authorized invocation is allowed and audited', () => {
  const d = authorizeWorkerAction(allowReq())
  assert.equal(d.allowed, true)
  assert.equal(d.requiresApproval, false)
  assert.equal(d.audit.decision, 'allow')
  assert.equal(d.audit.workerId, 'ai-coo')
})

test('a worker cannot use an UNDECLARED capability', () => {
  const d = authorizeWorkerAction(allowReq({ capability: 'payments' }))
  assert.equal(d.allowed, false)
  assert.match(d.reason, /capability/)
})

test('a worker cannot use an UNDECLARED tool', () => {
  const d = authorizeWorkerAction(allowReq({ tool: 'delete.everything' }))
  assert.equal(d.allowed, false)
  assert.match(d.reason, /tool/)
})

test('a user without the required permission cannot invoke the worker', () => {
  const d = authorizeWorkerAction(allowReq({ actor: crew }))
  assert.equal(d.allowed, false)
  assert.match(d.reason, /permission/)
})

test('a tenant-disabled worker cannot run', () => {
  const disabled = { ...getWorker('ai-coo'), enabledForTenants: ['other-tenant'] as string[] }
  const d = authorizeWorkerAction(allowReq({ worker: disabled }))
  assert.equal(d.allowed, false)
  assert.match(d.reason, /tenant/)
})

test('AI workforce disabled (flag off, no override) denies', () => {
  const d = authorizeWorkerAction(allowReq({ workforceEnabled: undefined }))
  assert.equal(d.allowed, false)
  assert.match(d.reason, /workforce/i)
})

test('approval-required (Level 3) cannot auto-execute — it needs approval', () => {
  const d = authorizeWorkerAction(allowReq({ autonomyLevel: 3 }))
  assert.equal(d.allowed, true)
  assert.equal(d.requiresApproval, true)
  assert.equal(d.mayAutoExecute, false)
})

test('Level 5 / prohibited actions can never execute', () => {
  const byLevel = authorizeWorkerAction(allowReq({ autonomyLevel: 5 }))
  assert.equal(byLevel.allowed, false)
  assert.equal(byLevel.prohibited, true)
  const byAction = authorizeWorkerAction(allowReq({ action: 'record.delete' }))
  assert.equal(byAction.prohibited, true)
  assert.equal(byAction.mayAutoExecute, false)
})

test('kill switch overrides ALL worker permissions', () => {
  const global = authorizeWorkerAction(allowReq({ killSwitch: { global: true } }))
  assert.equal(global.allowed, false)
  assert.match(global.reason, /kill switch/i)
  const perTenant = authorizeWorkerAction(allowReq({ killSwitch: { tenants: ['jkiss'] } }))
  assert.equal(perTenant.allowed, false)
})

test('audit metadata is generated for EVERY invocation (allow and deny)', () => {
  const allow = authorizeWorkerAction(allowReq())
  const deny = authorizeWorkerAction(allowReq({ killSwitch: { global: true } }))
  for (const d of [allow, deny]) {
    assert.ok(d.audit)
    assert.equal(d.audit.tenantId, 'jkiss')
    assert.ok(['allow', 'deny'].includes(d.audit.decision))
    assert.equal(typeof d.audit.reason, 'string')
  }
})
