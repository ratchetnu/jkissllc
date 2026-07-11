// AI Control Center — end-to-end audit harness. Drives every AI feature through the
// REAL runAiTask service with a mocked model (no network/Redis) and asserts each
// audit dimension: logging, token counts, cost math, budget caps, per-feature model
// routing, prompt-version tracking, success/failure classification, and RBAC.
//
// It ALSO pins the two real defects the audit found, so they can't regress silently
// and so a fix flips a red assertion green:
//   - AUDIT-F1: ops.photoEstimate is called with NO schema, so a malformed model
//     response is recorded as `success` even though the route returns 422.
//   - (AUDIT-F2 — routes not returning callId — is asserted by scripts/ai-audit-routes)
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TENANT_ID = 'audit-tenant.example'

import { runAiTask, type AiTaskDeps } from '../app/lib/ai/service'
import { getPrompt } from '../app/lib/ai/prompts'
import { estimateCostUsd, type AiCallRecord } from '../app/lib/ai/telemetry'
import { computeAiAnalytics } from '../app/lib/ai/analytics'
import { COMMAND_SCHEMA, ESTIMATE_SCHEMA } from '../app/lib/ai/schema'
import { can } from '../app/lib/rbac'

type Gen = NonNullable<AiTaskDeps['generate']>
type GenArg = Parameters<Gen>[0]

function harness(genText: string, usage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 }) {
  const records: AiCallRecord[] = []
  const calls: GenArg[] = []
  const accrued: number[] = []
  let i = 0
  const times = [1000, 1000, 1350]
  const deps: AiTaskDeps = {
    generate: async (o) => { calls.push(o); return { ok: true, text: genText, usage, model: o.model ?? 'anthropic/claude-sonnet-4-6' } },
    record: async (r) => { records.push(r) },
    now: () => times[Math.min(i++, times.length - 1)],
    accrueCost: async (u) => { accrued.push(u); return u },
    isOverBudget: async () => false,
  }
  return { deps, records, calls, accrued }
}

const ADMIN = { sub: 'owner', role: 'admin' as const }

// The five AI features, with a schema-valid canned response for each.
const FEATURES = [
  { taskId: 'ops.command', feature: 'ops.command', perm: 'ai:use' as const, principal: ADMIN,
    vars: { query: 'go to claims', targetsText: 'claims — Claims', summaryJson: '{}' }, text: '{"targetId":"claims"}' },
  { taskId: 'ops.message', feature: 'ops.message', perm: 'ai:use' as const, principal: ADMIN,
    vars: { intentInstruction: 'a reminder', ctxJson: '{"customer":"Sam"}', extra: '' }, text: 'Hi Sam, quick reminder…' },
  { taskId: 'ops.insights', feature: 'ops.insights', perm: 'ai:use' as const, principal: ADMIN,
    vars: { summaryJson: '{"revenue":"$1"}' }, text: '- Revenue is up' },
  { taskId: 'ops.reviewReply', feature: 'ops.reviewReply', perm: 'ai:use' as const, principal: ADMIN,
    vars: { author: 'Dana', rating: '5', text: 'great' }, text: 'Thank you, Dana!' },
  { taskId: 'ops.photoEstimate', feature: 'ops.photoEstimate', perm: undefined, principal: undefined,
    vars: {}, text: '{"loadSize":"A few items","low":200,"high":325,"summary":"ok"}',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'estimate' }] }] },
]

// ── DIMENSION: logging + tokens + cost + version, per feature ─────────────────
for (const f of FEATURES) {
  test(`[log/token/cost/version] ${f.feature} records exactly one accurate audit row`, async () => {
    const { deps, records, accrued } = harness(f.text)
    const r = await runAiTask({ taskId: f.taskId, feature: f.feature, requiredPermission: f.perm, principal: f.principal, vars: f.vars, messages: f.messages }, deps)
    assert.equal(r.ok, true, 'call should succeed')
    assert.equal(records.length, 1, 'exactly one telemetry record')
    const rec = records[0]
    // logging
    assert.equal(rec.feature, f.feature)
    assert.equal(rec.taskId, f.taskId)
    assert.equal(rec.outcome, 'success')
    assert.equal(rec.ok, true)
    assert.equal(rec.tenantId, 'audit-tenant.example')
    // prompt-version tracking — recorded from the registry at call time
    assert.equal(rec.promptVersion, getPrompt(f.taskId).version)
    // token counts — passed straight through from the model usage
    assert.equal(rec.inputTokens, 1000)
    assert.equal(rec.outputTokens, 200)
    assert.equal(rec.totalTokens, 1200)
    // latency from the injected clock
    assert.equal(rec.latencyMs, 350)
    // cost math: 1000 in @ $3/1M + 200 out @ $15/1M = 0.003 + 0.003 = 0.006
    const expected = estimateCostUsd('anthropic/claude-sonnet-4-6', 1000, 200)
    assert.equal(rec.estCostUsd, expected)
    assert.equal(expected, 0.006)
    // cost accrued toward the daily cap exactly once
    assert.deepEqual(accrued, [expected])
    // public feature stamps public actor/role; gated features stamp the principal
    assert.equal(rec.role, f.principal ? 'admin' : 'public')
  })
}

// ── DIMENSION: per-feature model routing ─────────────────────────────────────
test('[routing] a per-feature env override changes the model actually called + recorded', async () => {
  process.env.AI_MODEL_OPS_INSIGHTS = 'anthropic/claude-haiku-4-5'
  const { deps, calls, records } = harness('- ok', { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 })
  await runAiTask({ taskId: 'ops.insights', feature: 'ops.insights', requiredPermission: 'ai:use', principal: ADMIN, vars: { summaryJson: '{}' } }, deps)
  assert.equal(calls[0].model, 'anthropic/claude-haiku-4-5')
  assert.equal(records[0].model, 'anthropic/claude-haiku-4-5')
  // cost uses the HAIKU rate ($1/1M in) not sonnet — 1M in = $1.00
  assert.equal(records[0].estCostUsd, 1)
  delete process.env.AI_MODEL_OPS_INSIGHTS
})

// ── DIMENSION: budget cap ────────────────────────────────────────────────────
test('[budget] over-cap blocks with 429 before the model runs and accrues nothing', async () => {
  let modelCalled = false
  const accrued: number[] = []
  const deps: AiTaskDeps = {
    generate: async () => { modelCalled = true; return { ok: true, text: 'x', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'm' } },
    record: async () => {}, now: () => 1,
    isOverBudget: async () => true,
    accrueCost: async (u) => { accrued.push(u); return u },
  }
  const r = await runAiTask({ taskId: 'ops.message', feature: 'ops.message', requiredPermission: 'ai:use', principal: ADMIN, vars: { intentInstruction: 'x', ctxJson: '{}', extra: '' } }, deps)
  assert.equal(r.ok, false)
  assert.equal((r as { status: number }).status, 429)
  assert.equal((r as { outcome: string }).outcome, 'budget_exceeded')
  assert.equal(modelCalled, false)
  assert.deepEqual(accrued, [])
})

// ── DIMENSION: success/failure classification ────────────────────────────────
test('[metrics] provider errors, invalid responses, and RBAC denials are classified distinctly', async () => {
  // provider error
  const rec: AiCallRecord[] = []
  const provDeps: AiTaskDeps = { generate: async () => ({ ok: false, error: 'gateway down' }), record: async (r) => { rec.push(r) }, now: () => 1, isOverBudget: async () => false }
  const p = await runAiTask({ taskId: 'ops.command', feature: 'ops.command', requiredPermission: 'ai:use', principal: ADMIN, schema: COMMAND_SCHEMA, vars: cmdVars() }, provDeps)
  assert.equal((p as { outcome: string }).outcome, 'provider_error')
  assert.equal((p as { status: number }).status, 503)
  assert.equal(rec[0].estCostUsd, 0)          // failed call → no cost
  assert.equal(rec[0].inputTokens, 0)

  // invalid structured response (schema present)
  const { deps: badDeps, records: badRec, accrued } = harness('this is not json')
  const iv = await runAiTask({ taskId: 'ops.command', feature: 'ops.command', requiredPermission: 'ai:use', principal: ADMIN, schema: COMMAND_SCHEMA, vars: cmdVars() }, badDeps)
  assert.equal((iv as { outcome: string }).outcome, 'invalid_response')
  assert.equal((iv as { status: number }).status, 502)
  assert.equal(badRec[0].estCostUsd > 0, true)  // tokens WERE spent → cost still recorded
  assert.equal(accrued.length, 1)

  // RBAC denial (crew)
  const denRec: AiCallRecord[] = []
  const denDeps: AiTaskDeps = { generate: async () => { throw new Error('should not run') }, record: async (r) => { denRec.push(r) }, now: () => 1, isOverBudget: async () => false }
  const d = await runAiTask({ taskId: 'ops.command', feature: 'ops.command', requiredPermission: 'ai:use', principal: { sub: 'c1', role: 'crew' }, schema: COMMAND_SCHEMA, vars: cmdVars() }, denDeps)
  assert.equal((d as { outcome: string }).outcome, 'forbidden')
  assert.equal((d as { status: number }).status, 403)

  // analytics must NOT count the RBAC denial against success rate
  const a = await computeAiAnalytics(2000, { list: async () => [rec[0], badRec[0], denRec[0]], today: async () => 0, cap: () => 0, now: () => 1 })
  assert.equal(a.totals.calls, 3)
  assert.equal(a.totals.errors, 2)             // provider_error + invalid_response
  assert.equal(a.totals.ok, 0)
  assert.equal(a.outcomes.forbidden, 1)
  assert.equal(a.totals.successRate, 0)        // 0 ok / 2 reached (forbidden excluded)
})

// ── DIMENSION: RBAC cannot be bypassed at the service layer ───────────────────
test('[rbac] ai:use and ai:analytics grants match the matrix; crew is denied both', () => {
  assert.equal(can('admin', 'ai:use'), true)
  assert.equal(can('manager', 'ai:use'), true)
  assert.equal(can('crew', 'ai:use'), false)
  assert.equal(can('admin', 'ai:analytics'), true)
  assert.equal(can('manager', 'ai:analytics'), true)
  assert.equal(can('crew', 'ai:analytics'), false)
})

// ── AUDIT-F1 (fixed): the photo route now passes ESTIMATE_SCHEMA, so malformed
// model output is rejected + recorded as invalid_response (not a phantom success). ─
test('[AUDIT-F1 fixed] ops.photoEstimate with ESTIMATE_SCHEMA rejects malformed output as invalid_response', async () => {
  const { deps, records } = harness('NOT JSON — the model rambled')
  const r = await runAiTask({ taskId: 'ops.photoEstimate', feature: 'ops.photoEstimate', vars: {}, schema: ESTIMATE_SCHEMA, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, deps)
  assert.equal(r.ok, false)
  assert.equal((r as { outcome: string }).outcome, 'invalid_response')
  assert.equal(records[0].outcome, 'invalid_response')
  // a well-formed response still passes + returns typed data
  const good = harness('{"loadSize":"A few items","low":200,"high":325,"summary":"Looks like a quick haul."}')
  const r2 = await runAiTask({ taskId: 'ops.photoEstimate', feature: 'ops.photoEstimate', vars: {}, schema: ESTIMATE_SCHEMA, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, good.deps)
  assert.equal(r2.ok, true)
  assert.deepEqual((r2 as { data: unknown }).data, { loadSize: 'A few items', low: 200, high: 325, summary: 'Looks like a quick haul.' })
})

function cmdVars() { return { query: 'go to claims', targetsText: 'claims — Claims', summaryJson: '{}' } }
