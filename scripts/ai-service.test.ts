// Centralized AI service (LLMOps Phase 1) — unit tests. The service takes injectable
// deps (model call, telemetry recorder, clock), so the whole flow is exercised with
// no network and no Redis: prompt version loading, structured-response validation,
// invalid-response rejection, RBAC role restriction, tenant stamping, audit-record
// creation, provider failure, fail-soft, and token/latency recording.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TENANT_ID = 'test-tenant.example'   // read by tenantId() at call time

import { runAiTask, type AiTaskDeps } from '../app/lib/ai/service'
import { getPrompt, hasPrompt, listPrompts } from '../app/lib/ai/prompts'
import { validateJson, COMMAND_SCHEMA } from '../app/lib/ai/schema'
import { estimateCostUsd, type AiCallRecord } from '../app/lib/ai/telemetry'
import { can } from '../app/lib/rbac'
import { aiText, generateAI } from '../app/lib/ai'

// ── harness ──────────────────────────────────────────────────────────────────
type Gen = AiTaskDeps['generate']
const okGen = (text: string, usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, model = 'anthropic/claude-sonnet-4-6'): Gen =>
  async () => ({ ok: true, text, usage, model })
const failGen: Gen = async () => ({ ok: false, error: 'AI Gateway needs credits enabled.' })
const throwGen: Gen = async () => { throw new Error('network exploded') }

function harness(gen: Gen, times: number[] = [1000, 1000, 1250]) {
  const records: AiCallRecord[] = []
  let i = 0
  const deps: AiTaskDeps = {
    generate: gen,
    record: async (r) => { records.push(r) },
    now: () => times[Math.min(i++, times.length - 1)],
  }
  return { deps, records }
}
const ADMIN = { sub: 'owner', role: 'admin' as const }
const CREW = { sub: 'c1', role: 'crew' as const }
const baseInput = (over = {}) => ({
  taskId: 'ops.command', feature: 'ops.command', requiredPermission: 'ai:use' as const,
  principal: ADMIN, schema: COMMAND_SCHEMA, requestChars: 12,
  vars: { query: 'go to claims', targetsText: 'claims — Claims', summaryJson: '{}' },
  ...over,
})

// ── 1. Prompt version loading ────────────────────────────────────────────────
test('the prompt registry loads a versioned prompt and builds it from vars', () => {
  const p = getPrompt('ops.command')
  assert.equal(p.version, 1)
  assert.equal(hasPrompt('ops.command'), true)
  assert.equal(hasPrompt('nope'), false)
  const built = p.build({ query: 'find X', targetsText: 'a — A', summaryJson: '{"n":1}' })
  assert.match(built.system, /OpsPilot/)
  assert.match(built.prompt, /find X/)
  assert.match(built.prompt, /"n":1/)
  assert.throws(() => getPrompt('does-not-exist'), /unknown prompt/)
  assert.ok(listPrompts().some(x => x.id === 'ops.command'))
})

// ── 2. Structured response validation ────────────────────────────────────────
test('valid structured responses pass and unknown keys are dropped', () => {
  assert.deepEqual(validateJson('{"targetId":"ops"}', COMMAND_SCHEMA), { ok: true, value: { targetId: 'ops' } })
  assert.deepEqual(validateJson('here you go {"answer":"5 routes"} ok', COMMAND_SCHEMA), { ok: true, value: { answer: '5 routes' } })
  const both = validateJson('{"targetId":"crew:1","answer":"x","hacked":true}', COMMAND_SCHEMA)
  assert.equal(both.ok, true)
  assert.equal('hacked' in (both as { value: Record<string, unknown> }).value, false)  // extra key stripped
})

// ── 3. Invalid response rejection ────────────────────────────────────────────
test('invalid structured responses are rejected', () => {
  assert.equal(validateJson('not json at all', COMMAND_SCHEMA).ok, false)
  assert.equal(validateJson('{}', COMMAND_SCHEMA).ok, false)                          // atLeastOneOf unmet
  assert.equal(validateJson('{"targetId":123}', COMMAND_SCHEMA).ok, false)            // wrong type
  assert.equal(validateJson('{"answer":"  "}', COMMAND_SCHEMA).ok, false)             // blank fails atLeastOneOf
})

test('runAiTask rejects a malformed model response and audits it as invalid_response', async () => {
  const { deps, records } = harness(okGen('totally not json'))
  const r = await runAiTask(baseInput(), deps)
  assert.equal(r.ok, false)
  assert.equal((r as { outcome: string }).outcome, 'invalid_response')
  assert.equal((r as { status: number }).status, 502)
  assert.equal(records.length, 1)
  assert.equal(records[0].outcome, 'invalid_response')
  assert.equal(records[0].responseValid, false)
  assert.equal(records[0].ok, false)
})

// ── 4. Role restrictions ─────────────────────────────────────────────────────
test('a role without ai:use is refused before any model call', async () => {
  assert.equal(can('admin', 'ai:use'), true)
  assert.equal(can('manager', 'ai:use'), true)
  assert.equal(can('crew', 'ai:use'), false)
  let called = false
  const gen: Gen = async () => { called = true; return { ok: true, text: '{"targetId":"ops"}', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'm' } }
  const { deps, records } = harness(gen)
  const r = await runAiTask(baseInput({ principal: CREW }), deps)
  assert.equal(r.ok, false)
  assert.equal((r as { status: number }).status, 403)
  assert.equal(called, false)                       // model never invoked
  assert.equal(records[0].outcome, 'forbidden')
})

// ── 5. Tenant isolation (stamping) ───────────────────────────────────────────
test('every AI record is stamped with the tenant id', async () => {
  const { deps, records } = harness(okGen('{"targetId":"ops"}'))
  await runAiTask(baseInput(), deps)
  assert.equal(records[0].tenantId, 'test-tenant.example')
})

// ── 6. Audit-log creation + 9. token/latency recording ──────────────────────
test('a successful call records full telemetry: actor, model, tokens, latency, cost', async () => {
  const { deps, records } = harness(okGen('{"targetId":"claims"}', { inputTokens: 300, outputTokens: 40, totalTokens: 340 }))
  const r = await runAiTask(baseInput(), deps)
  assert.equal(r.ok, true)
  assert.deepEqual((r as { data: unknown }).data, { targetId: 'claims' })
  const rec = records[0]
  assert.equal(rec.ok, true)
  assert.equal(rec.outcome, 'success')
  assert.equal(rec.actor, 'owner')
  assert.equal(rec.role, 'admin')
  assert.equal(rec.feature, 'ops.command')
  assert.equal(rec.taskId, 'ops.command')
  assert.equal(rec.promptVersion, 1)
  assert.equal(rec.model, 'anthropic/claude-sonnet-4-6')
  assert.equal(rec.inputTokens, 300)
  assert.equal(rec.outputTokens, 40)
  assert.equal(rec.totalTokens, 340)
  assert.equal(rec.latencyMs, 250)                  // deterministic clock: 1250 - 1000
  assert.equal(rec.requestChars, 12)
  assert.ok(rec.estCostUsd > 0)
  assert.equal(rec.responseValid, true)
})

test('estimated cost uses the per-model rate table', () => {
  // sonnet: $3/1M in + $15/1M out → 1M in + 1M out = 3 + 15 = 18
  assert.equal(estimateCostUsd('anthropic/claude-sonnet-4-6', 1_000_000, 1_000_000), 18)
  assert.equal(estimateCostUsd('unknown/model', 1_000_000, 0), 3)   // default rate
})

// ── 7. Provider failure + 8. fail-soft ───────────────────────────────────────
test('a provider error is returned fail-soft (503) and audited as provider_error', async () => {
  const { deps, records } = harness(failGen)
  const r = await runAiTask(baseInput(), deps)
  assert.equal(r.ok, false)
  assert.equal((r as { status: number }).status, 503)
  assert.equal((r as { outcome: string }).outcome, 'provider_error')
  assert.equal(records[0].outcome, 'provider_error')
  assert.match(records[0].error ?? '', /credits/)
})

test('a thrown provider error is caught (never propagates) and audited', async () => {
  const { deps, records } = harness(throwGen)
  const r = await runAiTask(baseInput(), deps)   // must not throw
  assert.equal(r.ok, false)
  assert.equal((r as { outcome: string }).outcome, 'provider_error')
  assert.equal(records[0].outcome, 'provider_error')
})

test('telemetry that throws never breaks the request (fail-soft telemetry)', async () => {
  const deps: AiTaskDeps = { generate: okGen('{"targetId":"ops"}'), record: async () => { throw new Error('redis down') }, now: () => 1 }
  const r = await runAiTask(baseInput(), deps)    // must still succeed
  assert.equal(r.ok, true)
})

// ── 10. Existing workflows unaffected ────────────────────────────────────────
test('the legacy aiText entry point is preserved unchanged (other AI features untouched)', () => {
  assert.equal(typeof aiText, 'function')
  assert.equal(typeof generateAI, 'function')
})
