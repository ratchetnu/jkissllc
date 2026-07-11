// LLMOps Phase 3 — unit tests for the enterprise AI-ops layer. Covers the pure logic
// (no Redis/network): template rendering equivalence, A/B arm selection, quality
// scoring, the eval harness, analytics extensions (percentiles, per-model, cost
// forecast, A/B stats), and the service's Phase 3 behaviors (retries, prompt-version
// via injected resolver, cost reconciliation, quality on the record).
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TENANT_ID = 'p3-tenant.example'

import { renderTemplate, getPrompt } from '../app/lib/ai/prompts'
import { pickArm } from '../app/lib/ai/prompt-store'
import { scoreResponse } from '../app/lib/ai/quality'
import { runEval } from '../app/lib/ai/eval'
import { computeAiAnalytics, computeCostForecast, computeAbAnalysis } from '../app/lib/ai/analytics'
import { runAiTask, type AiTaskDeps } from '../app/lib/ai/service'
import { featureCatalog } from '../app/lib/ai/registry'
import type { AiCallRecord } from '../app/lib/ai/telemetry'
import type { DailyCost } from '../app/lib/ai/budget'

// ── Template rendering ────────────────────────────────────────────────────────
test('[templates] Mustache-lite renders vars, sections, inverted sections, keeps literal braces', () => {
  assert.equal(renderTemplate('Hi {{name}}', { name: 'Sam' }), 'Hi Sam')
  assert.equal(renderTemplate('a{{#x}} [{{x}}]{{/x}}', { x: 'Y' }), 'a [Y]')
  assert.equal(renderTemplate('a{{#x}} [{{x}}]{{/x}}', { x: '' }), 'a')
  assert.equal(renderTemplate('{{#t}}has{{/t}}{{^t}}none{{/t}}', { t: '' }), 'none')
  assert.equal(renderTemplate('json {"k":1}', {}), 'json {"k":1}')   // literal single braces untouched
})

test('[templates] built-in build() preserves exact prior output for the conditional prompts', () => {
  // message: extra present vs absent must match the original ternary behavior
  const withExtra = getPrompt('ops.message').build({ intentInstruction: 'a reminder', ctxJson: '{"c":1}', extra: 'be brief' })
  assert.equal(withExtra.prompt, 'Write a reminder.\n\nBooking facts (JSON): {"c":1}\nOwner\'s extra instruction: be brief')
  const noExtra = getPrompt('ops.message').build({ intentInstruction: 'a reminder', ctxJson: '{"c":1}', extra: '' })
  assert.equal(noExtra.prompt, 'Write a reminder.\n\nBooking facts (JSON): {"c":1}\n')
  // review: text present vs absent
  const noText = getPrompt('ops.reviewReply').build({ author: 'Dana', rating: '5', text: '' })
  assert.match(noText.prompt, /Review text: \(no written comment\)/)
  const withText = getPrompt('ops.reviewReply').build({ author: 'Dana', rating: '5', text: 'Great!' })
  assert.match(withText.prompt, /Review text: Great!/)
})

// ── A/B arm selection ─────────────────────────────────────────────────────────
test('[ab] pickArm splits by roll, respects disabled/equal-version, labels arms', () => {
  assert.deepEqual(pickArm(1, null, 0.5), { version: 1 })
  const ab = { enabled: true, variant: 2, split: 30 }
  assert.deepEqual(pickArm(1, ab, 0.10), { version: 2, variant: 'variant' })   // roll*100=10 < 30
  assert.deepEqual(pickArm(1, ab, 0.50), { version: 1, variant: 'control' })   // 50 ≥ 30
  assert.deepEqual(pickArm(1, { ...ab, enabled: false }, 0.1), { version: 1 }) // disabled → control only
  assert.deepEqual(pickArm(2, { ...ab, variant: 2 }, 0.1), { version: 2 })     // variant == active → no split
})

// ── Quality scoring ───────────────────────────────────────────────────────────
test('[quality] scorers flag the real failure modes and reward good drafts', () => {
  assert.equal(scoreResponse('ops.message', '').score, 0)
  assert.ok(scoreResponse('ops.message', 'Hi Sam, quick reminder your pickup is tomorrow. — J Kiss LLC').score >= 85)
  assert.ok(scoreResponse('ops.message', 'Hi [NAME], see you [DATE].').flags.includes('has_placeholder'))
  assert.ok(scoreResponse('ops.insights', 'No bullets here just a long paragraph of prose about the business performance').flags.includes('no_bullets'))
  assert.equal(scoreResponse('ops.command', '{"targetId":"ops"}').score, 100)
  assert.ok(scoreResponse('ops.command', 'not json').flags.includes('not_json'))
})

// ── Eval / regression harness ─────────────────────────────────────────────────
test('[eval] the golden-fixture suite passes and covers every registered feature', () => {
  const report = runEval(1)
  for (const f of report.features) for (const c of f.cases) assert.equal(c.pass, true, `${f.taskId}/${c.name}: ${c.reason ?? ''}`)
  assert.equal(report.pass, true)
  assert.equal(report.totals.features, featureCatalog().length)   // 1:1 fixture coverage
})

// ── Analytics: percentiles + per-model + quality ──────────────────────────────
const rec = (over: Partial<AiCallRecord>): AiCallRecord => ({
  id: Math.random().toString(36).slice(2), at: 1000, tenantId: 't', actor: 'o', role: 'admin',
  feature: 'ops.command', taskId: 'ops.command', promptVersion: 1, model: 'anthropic/claude-sonnet-4-6',
  ok: true, outcome: 'success', latencyMs: 100, inputTokens: 100, outputTokens: 20, totalTokens: 120,
  estCostUsd: 0.001, requestChars: 10, responseValid: true, qualityScore: 90, costSource: 'estimated', ...over,
})

test('[analytics] latency percentiles, per-model rollup, and quality aggregate', async () => {
  const recs = [10, 20, 30, 40, 100].map((ms, i) => rec({ id: `r${i}`, latencyMs: ms, qualityScore: 80 + i }))
  recs.push(rec({ id: 'haiku', model: 'anthropic/claude-haiku-4-5', latencyMs: 5, costSource: 'actual', actualCostUsd: 0.5 }))
  const a = await computeAiAnalytics(2000, { list: async () => recs, today: async () => 0, cap: () => 0, now: () => 1 })
  assert.equal(a.totals.latency.p95 >= a.totals.latency.p50, true)
  assert.equal(a.totals.avgQuality > 0, true)
  const sonnet = a.models.find(m => m.model === 'anthropic/claude-sonnet-4-6')!
  const haiku = a.models.find(m => m.model === 'anthropic/claude-haiku-4-5')!
  assert.equal(sonnet.calls, 5)
  assert.equal(haiku.costSource, 'actual')
  assert.equal(a.totals.actualCostUsd, 0.5)
})

// ── Analytics: cost forecast ──────────────────────────────────────────────────
test('[cost] forecast projects month-end from the daily series', () => {
  // 2026-07-11: 11 days in, 31-day month → 20 remaining. $2/day for last 7 days.
  const series: DailyCost[] = []
  for (let d = 1; d <= 11; d++) series.push({ day: `2026-07-${String(d).padStart(2, '0')}`, usd: 2 })
  const f = computeCostForecast(series, '2026-07-11', 0)
  assert.equal(f.mtdUsd, 22)                         // 11 × $2
  assert.equal(f.avgDailyUsd, 2)
  assert.equal(f.projectedMonthUsd, 22 + 2 * 20)     // mtd + avgDaily × remaining = 62
})

// ── Analytics: A/B statistical comparison ─────────────────────────────────────
test('[ab-stats] two-proportion z-test flags a clear winner and stays inconclusive when small', () => {
  const mk = (variant: 'control' | 'variant', ok: boolean, n: number) =>
    Array.from({ length: n }, (_, i) => rec({ id: `${variant}-${ok}-${i}`, promptVariant: variant, ok, outcome: ok ? 'success' : 'provider_error', taskId: 'ops.command' }))
  // control 60/100 ok, variant 90/100 ok → variant should win significantly
  const big = [...mk('control', true, 60), ...mk('control', false, 40), ...mk('variant', true, 90), ...mk('variant', false, 10)]
  const a = computeAbAnalysis('ops.command', big)!
  assert.equal(a.significant, true)
  assert.equal(a.winner, 'variant')
  // tiny sample → inconclusive regardless of z
  const small = [...mk('control', true, 3), ...mk('variant', true, 3)]
  assert.equal(computeAbAnalysis('ops.command', small)!.winner, 'inconclusive')
})

// ── Service: retries + version via resolver + cost reconciliation + quality ────
test('[service] retries transient failures, records attempts, and reconciles provider cost', async () => {
  let calls = 0
  const records: AiCallRecord[] = []
  const deps: AiTaskDeps = {
    generate: async () => {
      calls++
      if (calls === 1) return { ok: false, error: 'network timeout' }         // transient → retried
      return { ok: true, text: 'Hi Sam, quick reminder. — J Kiss LLC', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, model: 'anthropic/claude-sonnet-4-6', providerCostUsd: 0.0123 }
    },
    record: async (r) => { records.push(r) },
    now: () => 1000,
    isOverBudget: async () => false,
    resolve: async () => ({ system: 's', prompt: 'p', version: 7, variant: 'variant' }),
    accrueCost: async () => 0,
  }
  const r = await runAiTask({ taskId: 'ops.message', feature: 'ops.message', requiredPermission: 'ai:use', principal: { sub: 'o', role: 'admin' }, vars: {} }, deps)
  assert.equal(r.ok, true)
  assert.equal(calls, 2)                              // retried once
  const rec0 = records[0]
  assert.equal(rec0.attempts, 2)
  assert.equal(rec0.retried, true)
  assert.equal(rec0.promptVersion, 7)                 // from injected resolver
  assert.equal(rec0.promptVariant, 'variant')
  assert.equal(rec0.costSource, 'actual')             // provider cost present
  assert.equal(rec0.actualCostUsd, 0.0123)
  assert.equal(typeof rec0.qualityScore, 'number')
  assert.ok((rec0.qualityScore ?? 0) >= 80)
})

test('[service] permanent failures (billing) are NOT retried', async () => {
  let calls = 0
  const deps: AiTaskDeps = {
    generate: async () => { calls++; return { ok: false, error: 'AI Gateway needs credits enabled.' } },
    record: async () => {}, now: () => 1, isOverBudget: async () => false,
    resolve: async () => ({ system: 's', prompt: 'p', version: 1 }),
  }
  const r = await runAiTask({ taskId: 'ops.command', feature: 'ops.command', requiredPermission: 'ai:use', principal: { sub: 'o', role: 'admin' }, vars: {} }, deps)
  assert.equal(r.ok, false)
  assert.equal(calls, 1)                              // billing error → no retry
})
