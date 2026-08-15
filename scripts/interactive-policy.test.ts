// Interactive analysis policy — the latency budget that keeps a customer-facing
// photo estimate inside its function ceiling.
//
// The failure this prevents: before the policy, the primary vision call used the
// 30s platform default and the AI service retried it once on a transient failure
// (a timeout IS transient), so two attempts alone could consume the route's whole
// 60s ceiling — and the critic wanted a second vision pass on top. The platform
// then killed the function and the customer got a dead request with no estimate
// and no recorded reason.
//
// No network, no Redis, no provider. Fake clock throughout.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  interactiveBudget, durableBudget, resolveInteractiveBudget, isSkipped,
  DEFAULT_INTERACTIVE_BUDGET, INTERACTIVE_ROUTE_CEILING_MS,
} from '../app/lib/ai/interactive-policy'
import { buildPhotoEstimate } from '../app/lib/ai/photo-estimate'
import { reviewFallbackAnalysis, normalizeAnalysis, type NormalizeCtx } from '../app/lib/ai/analysis-schema'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'
import type { AnalyzeJunkPhotosResult } from '../app/lib/ai/junk-analysis'
import type { CriticVerdict } from '../app/lib/ai/junk-critic'

const T0 = 1_000_000

// ── The budget arithmetic ────────────────────────────────────────────────────

test('the whole budget fits inside the route ceiling with margin to spare', () => {
  const d = DEFAULT_INTERACTIVE_BUDGET
  const worstCase = d.primaryMaxMs + d.criticMaxMs + d.responseMarginMs
  assert.ok(
    worstCase < d.routeCeilingMs,
    `worst case ${worstCase}ms must beat the ${d.routeCeilingMs}ms ceiling — the platform must never be the thing that stops us`,
  )
  assert.equal(d.routeCeilingMs, INTERACTIVE_ROUTE_CEILING_MS)
})

test('the deadline reserves the response margin', () => {
  const b = interactiveBudget(T0)
  assert.equal(b.deadlineAt, T0 + b.config.routeCeilingMs - b.config.responseMarginMs)
  assert.equal(b.remainingMs(T0), b.config.routeCeilingMs - b.config.responseMarginMs)
  assert.equal(b.remainingMs(b.deadlineAt + 5_000), 0, 'remaining never goes negative')
})

test('the primary read is single-shot — a retry could not fit', () => {
  const b = interactiveBudget(T0)
  assert.equal(b.primary(T0).attempts, 1)
  assert.equal(b.critic(T0).attempts, 1)
})

test('the primary slice is capped, and shrinks as earlier work eats the budget', () => {
  const b = interactiveBudget(T0)
  assert.equal(b.primary(T0).timeoutMs, b.config.primaryMaxMs)
  // 40s of slow preprocessing already gone: only what is left may be spent.
  const late = b.primary(T0 + 40_000)
  assert.equal(late.timeoutMs, b.remainingMs(T0 + 40_000))
  assert.ok(late.timeoutMs < b.config.primaryMaxMs)
})

test('the critic gets what survives the primary call, capped', () => {
  const b = interactiveBudget(T0)
  assert.equal(b.critic(T0).timeoutMs, b.config.criticMaxMs)
  // 45s in: 54s deadline − 45s = 9s left, which is above criticMinMs (8s).
  assert.equal(b.critic(T0 + 45_000).timeoutMs, 9_000)
})

test('a critic that cannot finish is skipped, not started and abandoned', () => {
  const b = interactiveBudget(T0)
  // 47s in: 7s left, below the 8s floor.
  const thin = b.critic(T0 + 47_000)
  assert.equal(thin.timeoutMs, 0)
  assert.ok(isSkipped(thin, 'interactive'))
  // Past the deadline entirely.
  assert.equal(b.critic(T0 + 90_000).timeoutMs, 0)
})

test('budget numbers are env-overridable without a deploy', () => {
  const cfg = resolveInteractiveBudget({
    QUOTE_ANALYZE_PRIMARY_MAX_MS: '20000',
    QUOTE_ANALYZE_CRITIC_MAX_MS: '9000',
    QUOTE_ANALYZE_RESPONSE_MARGIN_MS: '4000',
  })
  assert.equal(cfg.primaryMaxMs, 20_000)
  assert.equal(cfg.criticMaxMs, 9_000)
  assert.equal(cfg.responseMarginMs, 4_000)
  assert.equal(cfg.routeCeilingMs, DEFAULT_INTERACTIVE_BUDGET.routeCeilingMs, 'unset keys keep their default')
  // Garbage never produces a nonsense budget.
  assert.equal(resolveInteractiveBudget({ QUOTE_ANALYZE_PRIMARY_MAX_MS: 'soon' }).primaryMaxMs, DEFAULT_INTERACTIVE_BUDGET.primaryMaxMs)
  assert.equal(resolveInteractiveBudget({ QUOTE_ANALYZE_PRIMARY_MAX_MS: '-5' }).primaryMaxMs, DEFAULT_INTERACTIVE_BUDGET.primaryMaxMs)
})

test('the durable worker is explicitly NOT on this budget', () => {
  const d = durableBudget()
  assert.equal(d.mode, 'durable')
  assert.equal(d.remainingMs(T0), Number.POSITIVE_INFINITY)
  // timeoutMs 0 is still "no override" — the analyzer's own photo-count-scaled
  // allowance applies and the worker keeps its 150s deadline.
  //
  // attempts is NOT a passthrough any more. It is pinned to 1 because the retry lives on
  // the booking (MAX_ATTEMPTS, 1m/5m/15m/1h backoff), so a second attempt inside the call
  // added no resilience and consumed the deadline: at ~102s per attempt for an 8-photo
  // set, two attempts came to ~204s against a 150s deadline, and the retry meant to
  // rescue a blip was what guaranteed the job failed.
  assert.deepEqual(d.primary(T0), { timeoutMs: 0, attempts: 1 })
  assert.deepEqual(d.critic(T0), { timeoutMs: 0, attempts: 1 })
  assert.equal(isSkipped(d.critic(T0), 'durable'), false, 'a durable critic is never budget-skipped')
})

// ── The wiring: buildPhotoEstimate under each budget ─────────────────────────

const ctx: NormalizeCtx = {
  analysisId: 'a1', bookingId: 'draft', photoUrls: ['https://blob.example.com/p.jpg'],
  modelProvider: 'vercel-ai-gateway', modelName: 'test-model', analyzedAt: '2026-08-03T00:00:00.000Z',
}

/** A confident read that would auto-quote — the only path that reaches the critic. */
const CONFIDENT = {
  normalizedItems: [
    { category: 'furniture', label: 'couch', estimatedQuantity: 1, estimatedVolumeCubicYards: 3, heavy: false, requiresDisassembly: false, confidence: 0.9 },
  ],
  photoObservations: [{ photoUrl: ctx.photoUrls[0], imageQuality: 'good' }],
  totalEstimatedVolumeCubicYards: { minimum: 2.5, likely: 3, maximum: 3.5 },
  totalEstimatedWeightPounds: { minimum: 300, likely: 400, maximum: 500 },
  estimatedTruckLoadFraction: { minimum: 0.06, likely: 0.07, maximum: 0.09 },
  estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
  laborEstimate: { crewSize: 2, likelyMinutes: 60 },
  detectedConditions: {
    stairs: false, elevator: false, longCarry: false, narrowAccess: false,
    indoorRemoval: false, outdoorRemoval: true, disassemblyRequired: false, heavyItemsPresent: false,
    hazardousMaterialPossible: false, refrigerantAppliancePossible: false, concreteOrSoilPossible: false,
    tiresPossible: false, paintOrChemicalPossible: false,
  },
  confidence: { overall: 0.92, volume: 0.9 },
  additionalQuestions: [], warnings: [], reviewRequired: false, reviewReasons: [],
}

type AnalyzeCall = { timeoutMs?: number; attempts?: number }
type ReviewCall = { timeoutMs?: number; attempts?: number; mode?: string }

function harness(opts: { analyzed?: Partial<AnalyzeJunkPhotosResult>; verdict?: CriticVerdict | null } = {}) {
  const analyzeCalls: AnalyzeCall[] = []
  const reviewCalls: ReviewCall[] = []
  const deps = {
    analyze: async (i: { timeoutMs?: number; attempts?: number }) => {
      analyzeCalls.push({ timeoutMs: i.timeoutMs, attempts: i.attempts })
      return {
        analysis: normalizeAnalysis(CONFIDENT, ctx), ok: true, outcome: 'success',
        model: 'test-model', latencyMs: 100, ...opts.analyzed,
      } as AnalyzeJunkPhotosResult
    },
    review: async (i: { timeoutMs?: number; attempts?: number; mode?: string }) => {
      reviewCalls.push({ timeoutMs: i.timeoutMs, attempts: i.attempts, mode: i.mode })
      return opts.verdict ?? null
    },
    loadSettings: async () => DEFAULT_DISPOSAL,
    loadCalibration: async () => ({ fillBias: {}, samples: {}, updatedAt: '' }),
  }
  return { deps, analyzeCalls, reviewCalls }
}

const input = {
  analysisId: 'a1', bookingId: 'draft', photoUrls: ctx.photoUrls,
  serviceType: 'junk-removal' as const,
}

test('interactive: the primary call receives an explicit slice and ONE attempt', async () => {
  const h = harness()
  await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(h.analyzeCalls.length, 1)
  assert.equal(h.analyzeCalls[0].attempts, 1, 'a customer request is never retried into the ceiling')
  assert.equal(h.analyzeCalls[0].timeoutMs, DEFAULT_INTERACTIVE_BUDGET.primaryMaxMs)
})

test('durable: no timeout or attempt override — the worker keeps its own policy', async () => {
  const h = harness()
  const res = await buildPhotoEstimate({ ...input }, h.deps)   // no budget ⇒ durable
  assert.equal(h.analyzeCalls[0].timeoutMs, 0, '0 ⇒ no override, platform default applies')
  assert.equal(h.analyzeCalls[0].attempts, 1,
    'attempts is now an explicit pin, not a passthrough: the booking owns the retry ladder '
    + '(MAX_ATTEMPTS with 1m/5m/15m/1h backoff), so a second attempt inside the call only '
    + 'consumed the 150s per-job deadline and stopped large photo sets from ever finishing')
  assert.equal(res.degraded, undefined)
  assert.equal(res.stored.latency, undefined, 'durable runs record no interactive latency accounting')
})

test('interactive: a budget timeout is a structured outcome, not a dead request', async () => {
  const h = harness({
    analyzed: {
      analysis: reviewFallbackAnalysis(ctx, ['Automated analysis was unavailable.']),
      ok: false, outcome: 'provider_error', errorClass: 'network',
    },
  })
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)

  assert.equal(res.degraded, 'primary_timeout')
  assert.equal(res.stored.latency?.degraded, 'primary_timeout')
  assert.equal(res.stored.latency?.mode, 'interactive')
  // The booking-preserving contract still holds: a real, priceable record comes back.
  assert.equal(res.stored.decision, 'manual_review')
  assert.equal(res.stored.status, 'failed')
  assert.ok(res.stored.pricing.lowUsd > 0, 'the customer is still handed a real record')
})

test('interactive: a PROVIDER rejection is not reported as our timeout', async () => {
  const h = harness({
    analyzed: {
      analysis: reviewFallbackAnalysis(ctx, ['no credits']),
      ok: false, outcome: 'provider_error', errorClass: 'billing',
    },
  })
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.degraded, undefined, 'billing is not a latency problem — do not mislabel it')
  assert.equal(res.stored.latency?.degraded, undefined)
})

test('interactive: the critic runs with its own slice when the budget allows', async () => {
  const h = harness()
  await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(h.reviewCalls.length, 1)
  assert.equal(h.reviewCalls[0].attempts, 1)
  assert.equal(h.reviewCalls[0].timeoutMs, DEFAULT_INTERACTIVE_BUDGET.criticMaxMs)
})

test('interactive: a thin budget skips the critic and records why', async () => {
  const h = harness()
  // The clock is already 50s past the start: below the critic floor.
  const res = await buildPhotoEstimate(
    { ...input, budget: interactiveBudget(T0), now: () => T0 + 50_000 },
    h.deps,
  )
  assert.equal(h.reviewCalls.length, 0, 'no half-critic that will be abandoned')
  assert.equal(res.stored.latency?.criticSkipped, 'budget')
  // Skipping leaves the primary read standing — identical to today's critic-FAILURE
  // path, which also returns null and changes nothing. The difference is it is recorded.
  assert.equal(res.stored.decision, 'instant_quote')
  assert.equal(res.stored.critic, undefined)
})

test('a skipped critic and a failed critic produce the same estimate', async () => {
  const skipped = await buildPhotoEstimate(
    { ...input, budget: interactiveBudget(T0), now: () => T0 + 50_000 },
    harness().deps,
  )
  const failed = await buildPhotoEstimate(
    { ...input, budget: interactiveBudget(T0), now: () => T0 },
    harness({ verdict: null }).deps,   // critic ran, returned no verdict
  )
  assert.equal(skipped.stored.decision, failed.stored.decision)
  assert.equal(skipped.stored.pricing.recommendedUsd, failed.stored.pricing.recommendedUsd)
})

test('a critic verdict of review still forces manual review under the budget', async () => {
  const h = harness({
    verdict: { agrees: false, recommend: 'review', confidence: 0.4, concerns: ['pile extends past the frame'] },
  })
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.stored.decision, 'manual_review', 'the budget must never override a safety escalation')
  assert.ok(res.stored.reviewReasons.some(r => /pile extends past the frame/.test(r)))
})

test('interactive runs record their slices for measurement', async () => {
  const res = await buildPhotoEstimate(
    { ...input, budget: interactiveBudget(T0), now: () => T0 },
    harness().deps,
  )
  assert.equal(res.stored.latency?.mode, 'interactive')
  assert.equal(res.stored.latency?.primaryTimeoutMs, DEFAULT_INTERACTIVE_BUDGET.primaryMaxMs)
  assert.equal(res.stored.latency?.criticTimeoutMs, DEFAULT_INTERACTIVE_BUDGET.criticMaxMs)
  assert.equal(typeof res.stored.latency?.elapsedMs, 'number')
})
