// LLMOps Phase 2 — unit tests. Exercises the four things Phase 2 adds on top of the
// Phase 1 service, all with injectable deps (no network, no Redis):
//   1. per-feature model routing (lib/ai/routing.ts)
//   2. daily cost governance (budget check short-circuits; cost accrues on success)
//   3. the migrated features (message / insights / review-reply / photo-estimate)
//      run through runAiTask — incl. the public multimodal (messages) path with no
//      principal — and their versioned prompts build correctly
//   4. the AI Control Center aggregation (lib/ai/analytics.ts) + its ai:analytics RBAC
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TENANT_ID = 'test-tenant.example'

import { runAiTask, type AiTaskDeps } from '../app/lib/ai/service'
import { getPrompt } from '../app/lib/ai/prompts'
import { modelForFeature } from '../app/lib/ai/routing'
import { computeAiAnalytics } from '../app/lib/ai/analytics'
import { can } from '../app/lib/rbac'
import type { AiCallRecord } from '../app/lib/ai/telemetry'

// ── harness ──────────────────────────────────────────────────────────────────
type Gen = NonNullable<AiTaskDeps['generate']>
type GenArg = Parameters<Gen>[0]
function capturingHarness(text = 'ok text', usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 }) {
  const records: AiCallRecord[] = []
  const calls: GenArg[] = []
  let i = 0
  const times = [1000, 1000, 1180]
  const accrued: number[] = []
  const deps: AiTaskDeps = {
    generate: async (o) => { calls.push(o); return { ok: true, text, usage, model: o.model ?? 'anthropic/claude-sonnet-4-6' } },
    record: async (r) => { records.push(r) },
    now: () => times[Math.min(i++, times.length - 1)],
    accrueCost: async (usd) => { accrued.push(usd); return usd },
  }
  return { deps, records, calls, accrued }
}
const ADMIN = { sub: 'owner', role: 'admin' as const }

// ── 1. Per-feature model routing ─────────────────────────────────────────────
test('modelForFeature falls back to the default model when no override is set', () => {
  delete process.env.AI_MODEL_OPS_COMMAND
  assert.equal(modelForFeature('ops.command'), 'anthropic/claude-sonnet-4-6')
})

test('modelForFeature honors a per-feature env override', () => {
  process.env.AI_MODEL_OPS_PHOTOESTIMATE = 'anthropic/claude-haiku-4-5'
  assert.equal(modelForFeature('ops.photoEstimate'), 'anthropic/claude-haiku-4-5')
  delete process.env.AI_MODEL_OPS_PHOTOESTIMATE
})

test('runAiTask routes the chosen model into the generate call and records it', async () => {
  process.env.AI_MODEL_OPS_INSIGHTS = 'anthropic/claude-haiku-4-5'
  const { deps, calls, records } = capturingHarness('a briefing')
  const r = await runAiTask({
    taskId: 'ops.insights', feature: 'ops.insights', requiredPermission: 'ai:use',
    principal: ADMIN, vars: { summaryJson: '{"revenue":1}' },
  }, deps)
  assert.equal(r.ok, true)
  assert.equal(calls[0].model, 'anthropic/claude-haiku-4-5')
  assert.equal(records[0].model, 'anthropic/claude-haiku-4-5')
  delete process.env.AI_MODEL_OPS_INSIGHTS
})

// ── 2. Cost governance ───────────────────────────────────────────────────────
test('an over-budget tenant is refused (429) before any model call', async () => {
  let called = false
  const deps: AiTaskDeps = {
    generate: async (o) => { called = true; return { ok: true, text: 'x', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: o.model ?? 'm' } },
    record: async () => {}, now: () => 1,
    isOverBudget: async () => true,
  }
  const r = await runAiTask({ taskId: 'ops.message', feature: 'ops.message', requiredPermission: 'ai:use', principal: ADMIN, vars: { intentInstruction: 'x', ctxJson: '{}', extra: '' } }, deps)
  assert.equal(r.ok, false)
  assert.equal((r as { status: number }).status, 429)
  assert.equal((r as { outcome: string }).outcome, 'budget_exceeded')
  assert.equal(called, false)
})

test('a failing budget check is fail-soft — the call proceeds', async () => {
  const { deps } = capturingHarness('drafted')
  deps.isOverBudget = async () => { throw new Error('redis down') }
  const r = await runAiTask({ taskId: 'ops.message', feature: 'ops.message', requiredPermission: 'ai:use', principal: ADMIN, vars: { intentInstruction: 'x', ctxJson: '{}', extra: '' } }, deps)
  assert.equal(r.ok, true)
})

test('a successful call accrues its estimated cost toward the daily total', async () => {
  const { deps, accrued } = capturingHarness('drafted', { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 })
  const r = await runAiTask({ taskId: 'ops.reviewReply', feature: 'ops.reviewReply', requiredPermission: 'ai:use', principal: ADMIN, vars: { author: 'A', rating: '5', text: 'great' } }, deps)
  assert.equal(r.ok, true)
  assert.equal(accrued.length, 1)
  assert.equal(accrued[0], 3)   // 1M input tokens @ $3/1M (sonnet default)
})

// ── 3. Migrated features + public multimodal path ────────────────────────────
test('the four migrated prompts are registered at v1 and build from their vars', () => {
  const msg = getPrompt('ops.message').build({ intentInstruction: 'a reminder', ctxJson: '{"customer":"Sam"}', extra: 'be brief' })
  assert.match(msg.prompt, /a reminder/)
  assert.match(msg.prompt, /Sam/)
  assert.match(msg.prompt, /be brief/)
  const ins = getPrompt('ops.insights').build({ summaryJson: '{"revenue":"$1"}' })
  assert.match(ins.prompt, /revenue/)
  const rev = getPrompt('ops.reviewReply').build({ author: 'Dana', rating: '2', text: 'late' })
  assert.match(rev.prompt, /Dana/)
  assert.match(rev.prompt, /2 out of 5/)
  const photo = getPrompt('ops.photoEstimate').build({})
  assert.match(photo.system, /junk-removal/)
  assert.match(photo.system, /loadSize/)
  for (const id of ['ops.message', 'ops.insights', 'ops.reviewReply', 'ops.photoEstimate']) {
    assert.equal(getPrompt(id).version, 1)
  }
})

test('the public multimodal path runs with no principal: passes messages, omits prompt, stamps role=public', async () => {
  const { deps, calls, records } = capturingHarness('{"loadSize":"A few items","low":200,"high":325,"summary":"ok"}')
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'estimate' }, { type: 'image' as const, image: 'data:image/png;base64,AAAA' }] }]
  const r = await runAiTask({ taskId: 'ops.photoEstimate', feature: 'ops.photoEstimate', vars: {}, messages, requestChars: 20 }, deps)
  assert.equal(r.ok, true)
  assert.equal(calls[0].messages, messages)     // multimodal messages forwarded
  assert.equal(calls[0].prompt, undefined)      // prompt string suppressed when messages present
  assert.equal(records[0].actor, 'public')      // no principal → public actor/role
  assert.equal(records[0].role, 'public')
  assert.equal(records[0].feature, 'ops.photoEstimate')
})

test('a public feature is NOT gated by RBAC (no requiredPermission) and still records telemetry', async () => {
  const { deps, records } = capturingHarness('text')
  const r = await runAiTask({ taskId: 'ops.photoEstimate', feature: 'ops.photoEstimate', vars: {}, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }, deps)
  assert.equal(r.ok, true)
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'success')
})

// ── 4. AI Control Center aggregation ─────────────────────────────────────────
const rec = (over: Partial<AiCallRecord>): AiCallRecord => ({
  id: 'x', at: 1000, tenantId: 't', actor: 'owner', role: 'admin', feature: 'ops.message',
  taskId: 'ops.message', promptVersion: 1, model: 'anthropic/claude-sonnet-4-6', ok: true,
  outcome: 'success', latencyMs: 100, inputTokens: 100, outputTokens: 20, totalTokens: 120,
  estCostUsd: 0.001, requestChars: 10, responseValid: true, ...over,
})

test('analytics aggregates totals, outcomes, and per-feature/per-version metrics', async () => {
  const records: AiCallRecord[] = [
    rec({ id: '1', feature: 'ops.message', promptVersion: 1, ok: true, outcome: 'success', latencyMs: 100, feedback: 'helpful' }),
    rec({ id: '2', feature: 'ops.message', promptVersion: 2, ok: true, outcome: 'success', latencyMs: 200 }),
    rec({ id: '3', feature: 'ops.message', promptVersion: 2, ok: false, outcome: 'provider_error', latencyMs: 0 }),
    rec({ id: '4', feature: 'ops.insights', promptVersion: 1, ok: false, outcome: 'forbidden', latencyMs: 0 }),  // must NOT count against success rate
  ]
  const a = await computeAiAnalytics(2000, {
    list: async () => records,
    today: async () => 0.05,
    cap: () => 1,
    now: () => 12345,
  })
  assert.equal(a.totals.calls, 4)
  assert.equal(a.totals.ok, 2)
  assert.equal(a.totals.errors, 1)             // forbidden excluded
  assert.equal(a.totals.successRate, 0.667)    // 2 ok / 3 reached (forbidden excluded)
  assert.equal(a.outcomes.success, 2)
  assert.equal(a.outcomes.provider_error, 1)
  assert.equal(a.outcomes.forbidden, 1)
  assert.equal(a.totals.helpful, 1)
  assert.equal(a.today.estCostUsd, 0.05)
  assert.equal(a.today.capUsd, 1)
  assert.equal(a.today.overBudget, false)

  const msg = a.features.find(f => f.feature === 'ops.message')!
  assert.equal(msg.calls, 3)
  assert.equal(msg.versions.length, 2)
  const v2 = msg.versions.find(v => v.promptVersion === 2)!
  assert.equal(v2.calls, 2)
  assert.equal(v2.ok, 1)
  assert.equal(v2.successRate, 0.5)            // 1 ok / 2 (both reached the model)
  assert.equal(a.registeredPrompts.some(p => p.id === 'ops.message'), true)
})

test('analytics flags an over-budget day', async () => {
  const a = await computeAiAnalytics(2000, { list: async () => [], today: async () => 5, cap: () => 5, now: () => 1 })
  assert.equal(a.today.overBudget, true)
})

// ── ai:analytics RBAC ─────────────────────────────────────────────────────────
test('ai:analytics is granted to admin + manager and denied to crew', () => {
  assert.equal(can('admin', 'ai:analytics'), true)
  assert.equal(can('manager', 'ai:analytics'), true)
  assert.equal(can('crew', 'ai:analytics'), false)
})
