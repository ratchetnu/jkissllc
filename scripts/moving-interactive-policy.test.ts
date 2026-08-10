// The interactive latency budget applied to the MOVING lane.
//
// Why this file exists as well as interactive-policy.test.ts: the moving lane is a
// second, structurally separate estimating chain that returns from the SAME route,
// inside the SAME 60s function ceiling — but it was never given a budget. Unbudgeted
// it inherits the 30s platform default and the AI service's transient retry, and a
// timeout classifies as transient, so two attempts alone reach the ceiling with no
// margin left to answer in. That is the identical defect the junk lane was fixed for,
// on the one path the junk fix cannot reach: `buildMovingEstimate` returns before
// `buildPhotoEstimate` is ever called.
//
// The lane has ONE model call and no critic, so it takes the primary slice and
// nothing else — deliberately reusing `primary()` rather than a second budget shape,
// so both lanes are provable against one deadline calculation.
//
// No network, no Redis, no provider. Fake clock throughout.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  interactiveBudget, durableBudget, DEFAULT_INTERACTIVE_BUDGET, INTERACTIVE_ROUTE_CEILING_MS,
} from '../app/lib/ai/interactive-policy'
import { buildMovingEstimate } from '../app/lib/ai/moving-estimate'
import {
  normalizeMovingAnalysis, reviewFallbackMovingAnalysis, type NormalizeMovingCtx,
} from '../app/lib/ai/analysis-schema-moving'
import { DEFAULT_MOVING } from '../app/lib/pricing/moving-quote'
import type { AnalyzeMovingPhotosResult } from '../app/lib/ai/moving-analysis'

const T0 = 1_000_000

const ctx: NormalizeMovingCtx = {
  analysisId: 'm1', bookingId: 'draft', photoUrls: ['https://blob.example.com/room.jpg'],
  modelProvider: 'vercel-ai-gateway', modelName: 'test-model', analyzedAt: '2026-08-09T00:00:00.000Z',
}

/** A compact-contract read the moving engine can actually price. */
const READ = {
  items: [
    { label: 'sofa', qty: 1, cuft: 35, heavy: true, disassembly: false, conf: 0.9 },
    { label: 'dining table', qty: 1, cuft: 25, heavy: false, disassembly: true, conf: 0.85 },
  ],
  job: {
    totalCuft: { min: 55, likely: 60, max: 70 },
    crew: 3,
    hours: { min: 4, likely: 5, max: 6 },
    access: { stairs: false, elevator: false, longCarry: false, narrowAccess: false },
    conf: 0.88,
    questions: [],
    warnings: [],
    reviewRequired: false,
    reviewReasons: [],
  },
}

type AnalyzeCall = { timeoutMs?: number; attempts?: number }

function harness(opts: { analyzed?: Partial<AnalyzeMovingPhotosResult> } = {}) {
  const analyzeCalls: AnalyzeCall[] = []
  const deps = {
    analyze: async (i: { timeoutMs?: number; attempts?: number }) => {
      analyzeCalls.push({ timeoutMs: i.timeoutMs, attempts: i.attempts })
      return {
        analysis: normalizeMovingAnalysis(READ, ctx), ok: true, outcome: 'ok',
        model: 'test-model', latencyMs: 120, ...opts.analyzed,
      } as AnalyzeMovingPhotosResult
    },
    loadSettings: async () => DEFAULT_MOVING,
  }
  return { deps, analyzeCalls }
}

const input = {
  analysisId: 'm1', bookingId: 'draft', photoUrls: ctx.photoUrls,
  serviceType: 'moving' as const,
}

// ── The slice the moving call actually receives ──────────────────────────────

test('interactive: the moving call receives an explicit slice and ONE attempt', async () => {
  const h = harness()
  await buildMovingEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(h.analyzeCalls.length, 1)
  assert.equal(h.analyzeCalls[0].attempts, 1, 'a customer request is never retried into the ceiling')
  assert.equal(h.analyzeCalls[0].timeoutMs, DEFAULT_INTERACTIVE_BUDGET.primaryMaxMs)
})

test('the moving lane cannot outlive the route ceiling', () => {
  const b = interactiveBudget(T0)
  const slice = b.primary(T0)
  // One attempt, capped, plus the reserved response margin — with no critic on this
  // lane that IS the whole worst case. It must clear the wall with room to spare.
  const worstCase = slice.timeoutMs * slice.attempts + DEFAULT_INTERACTIVE_BUDGET.responseMarginMs
  assert.ok(
    worstCase < INTERACTIVE_ROUTE_CEILING_MS,
    `moving worst case ${worstCase}ms must stay under the ${INTERACTIVE_ROUTE_CEILING_MS}ms ceiling`,
  )
})

test('the moving slice shrinks as earlier work eats the budget', async () => {
  const h = harness()
  const late = T0 + 40_000                     // 40s already gone
  await buildMovingEstimate({ ...input, budget: interactiveBudget(T0), now: () => late }, h.deps)
  const deadline = INTERACTIVE_ROUTE_CEILING_MS - DEFAULT_INTERACTIVE_BUDGET.responseMarginMs
  assert.equal(h.analyzeCalls[0].timeoutMs, deadline - 40_000, 'the slice is what is left, not the cap')
})

test('a moving request with no budget left starts no model call slice at all', async () => {
  const h = harness({ analyzed: { ok: false, outcome: 'provider_error', errorClass: 'network' } })
  const spent = T0 + INTERACTIVE_ROUTE_CEILING_MS      // past the deadline entirely
  const res = await buildMovingEstimate({ ...input, budget: interactiveBudget(T0), now: () => spent }, h.deps)
  assert.equal(h.analyzeCalls[0].timeoutMs, 0, '0 ⇒ nothing left to spend')
  assert.ok(res.degraded, 'an exhausted budget is always recorded as a degrade')
})

// ── Retry exhaustion + timeout behaviour ─────────────────────────────────────

test('interactive: a budget timeout is a structured outcome, not a dead request', async () => {
  const h = harness({
    analyzed: {
      analysis: reviewFallbackMovingAnalysis(ctx, ['Automated analysis was unavailable.']),
      ok: false, outcome: 'provider_error', errorClass: 'network',
    },
  })
  const res = await buildMovingEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)

  assert.equal(res.degraded, 'primary_timeout')
  assert.equal(res.stored.latency?.degraded, 'primary_timeout')
  assert.equal(res.stored.latency?.mode, 'interactive')
  assert.equal(res.stored.status, 'failed')
  // The lane's contract holds: the customer still gets a real record routed to a human.
  assert.equal(res.stored.decision, 'manual_review')
  assert.equal(res.stored.pricing.priced, false, 'a failed read is never silently priced')
})

test('interactive: a PROVIDER rejection is not reported as our timeout', async () => {
  const h = harness({
    analyzed: {
      analysis: reviewFallbackMovingAnalysis(ctx, ['no credits']),
      ok: false, outcome: 'provider_error', errorClass: 'billing',
    },
  })
  const res = await buildMovingEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.degraded, undefined, 'a billing refusal is theirs, not our deadline')
  assert.equal(res.stored.latency?.degraded, undefined)
  assert.equal(res.stored.latency?.mode, 'interactive', 'the run is still accounted for')
})

test('retry exhaustion: the single shot is the ONLY shot', async () => {
  // The lane asks for attempts:1, so the AI service's retry loop cannot fire a
  // second call. If this ever regresses to 2, the ceiling arithmetic above breaks.
  const h = harness({ analyzed: { ok: false, outcome: 'provider_error', errorClass: 'network' } })
  await buildMovingEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(h.analyzeCalls.length, 1, 'exactly one analysis call per interactive request')
  assert.equal(h.analyzeCalls[0].attempts, 1)
})

test('no duplicate AI execution: one request drives exactly one moving analysis', async () => {
  const h = harness()
  const res = await buildMovingEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(h.analyzeCalls.length, 1, 'the moving lane has no critic and no second pass')
  assert.ok(res.stored.analysis, 'and it produced a read from that one call')
})

// ── The durable / non-interactive path is untouched ──────────────────────────

test('durable: no timeout or attempt override — today’s behaviour, byte for byte', async () => {
  const h = harness()
  const res = await buildMovingEstimate({ ...input }, h.deps)     // no budget ⇒ durable
  assert.equal(h.analyzeCalls[0].timeoutMs, 0, '0 ⇒ no override, platform default applies')
  assert.equal(h.analyzeCalls[0].attempts, 0, '0 ⇒ no override, the service retry applies')
  assert.equal(res.degraded, undefined)
  assert.equal(res.stored.latency, undefined, 'durable runs record no interactive latency accounting')
})

test('durableBudget() is explicitly not a moving deadline', async () => {
  const h = harness()
  const res = await buildMovingEstimate({ ...input, budget: durableBudget() }, h.deps)
  assert.equal(h.analyzeCalls[0].timeoutMs, 0)
  assert.equal(res.stored.latency, undefined)
})

// ── Existing moving behaviour unchanged under the budget ─────────────────────

test('a successful budgeted read prices exactly as an unbudgeted one', async () => {
  const withBudget = await buildMovingEstimate(
    { ...input, budget: interactiveBudget(T0), now: () => T0 }, harness().deps,
  )
  const without = await buildMovingEstimate({ ...input }, harness().deps)

  assert.equal(withBudget.stored.decision, without.stored.decision)
  assert.equal(withBudget.stored.pricing.recommendedUsd, without.stored.pricing.recommendedUsd)
  assert.equal(withBudget.stored.pricing.priced, without.stored.pricing.priced)
  assert.deepEqual(withBudget.stored.reviewReasons, without.stored.reviewReasons)
  assert.equal(withBudget.stored.lane, 'moving', 'still the moving lane, never the disposal engine')
})

// ── The wiring itself ────────────────────────────────────────────────────────
// `budget` is optional on buildMovingEstimate by design (the durable path must keep
// today's behaviour), so the type system cannot prove the ROUTE passes one. Losing
// that one argument silently restores the exact defect this work removes, and every
// unit test above would still pass. Asserted at the source, like the route's own
// maxDuration/ceiling agreement check.

test('the route hands the moving lane a budget — the argument that must never be dropped', () => {
  const src = readFileSync(new URL('../app/api/quote/analyze/route.ts', import.meta.url), 'utf8')
  const branch = src.slice(src.indexOf("serviceFamily(serviceType) === 'moving'"))
  const call = branch.slice(0, branch.indexOf('})'))

  assert.ok(/interactiveBudget\(/.test(call), 'the moving branch must construct an interactive budget')
  assert.ok(/budget:/.test(call), 'and must actually pass it to buildMovingEstimate')
  assert.ok(
    /degraded/.test(branch.slice(0, branch.indexOf('return NextResponse'))),
    'a moving degrade must be recorded, not silently swallowed',
  )
})

test('the interactive latency record is the ONLY added field', async () => {
  const withBudget = await buildMovingEstimate(
    { ...input, budget: interactiveBudget(T0), now: () => T0 }, harness().deps,
  )
  const without = await buildMovingEstimate({ ...input }, harness().deps)
  const added = Object.keys(withBudget.stored).filter(k => !(k in without.stored))
  assert.deepEqual(added, ['latency'], 'a budgeted run adds accounting and nothing else')
})
