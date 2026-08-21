// ── The interactive photo estimate must be SATISFIABLE, and must never bluff ──
//
// Two defects, one root and one consequence.
//
// ROOT. junk-analysis derives its wall-clock allowance FROM its output-token budget
// and warns that the two "are coupled in reality and were independent in code". The
// coupling held inside `analysisTimeoutMs` — and was broken from OUTSIDE it: the
// interactive caller pinned `timeoutMs` to a 32s slice and left `maxOutputTokens` at
// the durable, photo-count-scaled value. At the measured ~107 output tok/s that ask
// needs 24s of generation for ONE photo and 64s for eight, plus ~10s of fixed
// overhead. Every interactive analysis was therefore unsatisfiable — at every photo
// count — and every one timed out.
//
// CONSEQUENCE. A timed-out read returns `reviewFallbackAnalysis`: confidence 0, no
// items, truckLoads defaulted to 1. decideQuote cannot distinguish those placeholders
// from a real one-load read, so it priced them, and the customer was shown a
// confident "$580–$815, priced: true" for photos nothing ever looked at.
//
// No network, no Redis, no provider — injected deps and a fake clock throughout.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  interactiveBudget, durableBudget, outputTokensForSlice, resolveInteractiveBudget,
  DEFAULT_INTERACTIVE_BUDGET as B,
} from '../app/lib/ai/interactive-policy'
import { analysisOutputTokenBudget, analysisTimeoutMs, type AnalyzeJunkPhotosResult } from '../app/lib/ai/junk-analysis'
import { buildPhotoEstimate } from '../app/lib/ai/photo-estimate'
import { reviewFallbackAnalysis, normalizeAnalysis, type NormalizeCtx } from '../app/lib/ai/analysis-schema'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'
import { hasValidEstimate } from '../app/lib/book-now-ai'

const T0 = 1_000_000

// ── 1. The root cause, stated as arithmetic ─────────────────────────────────

test('the OLD pairing was unsatisfiable at every photo count', () => {
  // Reconstructs the shipped behaviour: durable token budget, interactive slice.
  for (const n of [1, 2, 4, 6, 8]) {
    const askedTokens = analysisOutputTokenBudget(n)
    const generationMs = (askedTokens / B.outputTokensPerSec) * 1000
    const needMs = generationMs + B.fixedOverheadMs
    assert.ok(
      needMs > B.primaryMaxMs,
      `n=${n}: the old ask needed ~${Math.round(needMs)}ms inside a ${B.primaryMaxMs}ms slice — `
      + 'this is the bug, and it was total rather than large-job-only',
    )
  }
})

test('the derived ask now fits the slice at every photo count', () => {
  for (const n of [1, 2, 4, 6, 8]) {
    const cap = analysisOutputTokenBudget(n)
    const asked = interactiveBudget(T0).primary(T0, cap).maxOutputTokens
    assert.ok(asked > 0, `n=${n}: a workable ask exists`)
    const needMs = (asked / B.outputTokensPerSec) * 1000 + B.fixedOverheadMs
    assert.ok(needMs <= B.primaryMaxMs, `n=${n}: ~${Math.round(needMs)}ms must fit ${B.primaryMaxMs}ms`)
  }
})

test('the ask is LOWERED to fit, never raised beyond the analyzer cap', () => {
  // A one-photo job must not inherit an eight-photo allowance just because the clock
  // could afford it — the cap is still the analyzer's to set.
  const cap = analysisOutputTokenBudget(1)
  assert.equal(outputTokensForSlice(600_000, cap), cap, 'abundant time still respects the cap')
  assert.ok(outputTokensForSlice(B.primaryMaxMs, analysisOutputTokenBudget(8)) < analysisOutputTokenBudget(8))
})

test('a slice too thin for an honest answer asks for nothing rather than a truncated one', () => {
  // Truncated JSON discards the WHOLE read (the JK-B-1022 failure), so a doomed call
  // is worse than no call: it costs money and returns nothing usable.
  assert.equal(outputTokensForSlice(B.fixedOverheadMs, 8000), 0, 'no time left after overhead')
  assert.equal(outputTokensForSlice(B.fixedOverheadMs + 1_000, 8000), 0, 'below the honest-answer floor')
  assert.equal(outputTokensForSlice(0, 8000), 0)
  assert.equal(outputTokensForSlice(-5_000, 8000), 0, 'a negative slice never yields tokens')
})

test('the two directions stay inverse — neither end can drift from the other', () => {
  // analysisTimeoutMs: tokens -> time. outputTokensForSlice: time -> tokens.
  for (const n of [1, 4, 8]) {
    const cap = analysisOutputTokenBudget(n)
    const timeNeeded = analysisTimeoutMs(n)
    assert.equal(outputTokensForSlice(timeNeeded, cap), cap, `n=${n}: the time it asks for buys the tokens it wants`)
  }
})

test('the coupling knobs are env-tunable without a deploy', () => {
  const cfg = resolveInteractiveBudget({ QUOTE_ANALYZE_OUTPUT_TOKENS_PER_SEC: '200', QUOTE_ANALYZE_FIXED_OVERHEAD_MS: '5000' })
  assert.equal(cfg.outputTokensPerSec, 200)
  assert.equal(cfg.fixedOverheadMs, 5_000)
  assert.equal(resolveInteractiveBudget({ QUOTE_ANALYZE_OUTPUT_TOKENS_PER_SEC: 'fast' }).outputTokensPerSec, B.outputTokensPerSec)
})

// ── 2. The wiring: what the analyzer actually receives ──────────────────────

const ctx: NormalizeCtx = {
  analysisId: 'a1', bookingId: 'draft', photoUrls: ['https://blob.example.com/p.jpg'],
  modelProvider: 'anthropic', modelName: 'test-model', analyzedAt: '2026-08-21T00:00:00.000Z',
}

const CONFIDENT = {
  normalizedItems: [{ category: 'furniture', label: 'couch', estimatedQuantity: 1, estimatedVolumeCubicYards: 3, heavy: false, requiresDisassembly: false, confidence: 0.9 }],
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

type Seen = { timeoutMs?: number; attempts?: number; maxOutputTokens?: number }

function harness(analyzed?: Partial<AnalyzeJunkPhotosResult>) {
  const seen: Seen[] = []
  const deps = {
    analyze: async (i: Seen) => {
      seen.push({ timeoutMs: i.timeoutMs, attempts: i.attempts, maxOutputTokens: i.maxOutputTokens })
      return {
        analysis: normalizeAnalysis(CONFIDENT, ctx), ok: true, outcome: 'success',
        model: 'test-model', latencyMs: 100, ...analyzed,
      } as AnalyzeJunkPhotosResult
    },
    review: async () => null,
    loadSettings: async () => DEFAULT_DISPOSAL,
    loadCalibration: async () => ({ fillBias: {}, samples: {}, updatedAt: '' }),
  }
  return { seen, deps: deps as Parameters<typeof buildPhotoEstimate>[1] }
}

const input = {
  analysisId: 'a1', bookingId: 'draft', photoUrls: ctx.photoUrls,
  serviceType: 'junk-removal' as const,
}

test('the interactive path pins a token ceiling alongside its timeout', async () => {
  const h = harness()
  await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  const call = h.seen[0]
  assert.equal(call.timeoutMs, B.primaryMaxMs)
  assert.ok(call.maxOutputTokens! > 0, 'a ceiling is pinned — leaving it unset is the bug')
  const needMs = (call.maxOutputTokens! / B.outputTokensPerSec) * 1000 + B.fixedOverheadMs
  assert.ok(needMs <= call.timeoutMs!, 'what we ask for fits what we allow')
})

test('the durable worker is untouched — full budget, no override', async () => {
  const h = harness()
  await buildPhotoEstimate({ ...input, budget: durableBudget(), now: () => T0 }, h.deps)
  assert.equal(h.seen[0].maxOutputTokens, 0, '0 = no override; the analyzer keeps its scaled budget')
  assert.equal(h.seen[0].timeoutMs, 0)
})

test('a shrunken slice shrinks the ask with it', async () => {
  const h = harness()
  // 30s of the 54s deadline already spent: only 24s remain for the primary call.
  await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 + 30_000 }, h.deps)
  const call = h.seen[0]
  assert.ok(call.timeoutMs! < B.primaryMaxMs)
  const needMs = (call.maxOutputTokens! / B.outputTokensPerSec) * 1000 + B.fixedOverheadMs
  assert.ok(needMs <= call.timeoutMs!, 'the ask tracks the slice down, it is not a constant')
})

// ── 3. A read that did not happen is never priced ───────────────────────────

const FAILED = {
  analysis: reviewFallbackAnalysis(ctx, ['Automated analysis was unavailable.']),
  ok: false, outcome: 'provider_error',
}

test('provider TIMEOUT: analysis preserved, price withheld', async () => {
  const h = harness({ ...FAILED, errorClass: 'network' })
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.degraded, 'primary_timeout')
  assert.equal(res.stored.pricing.priced, false)
  assert.equal(res.stored.pricing.recommendedUsd, 0)
  assert.equal(res.stored.decision, 'manual_review')
  assert.ok(res.stored.analysis, 'the record survives so the job is never lost')
})

test('MALFORMED / truncated JSON is not priced either', async () => {
  // The analyzer reports a parse failure the same way — ok:false with the fallback.
  const h = harness({ ...FAILED, outcome: 'parse_failed', errorClass: 'other' })
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.stored.pricing.priced, false, 'unparseable output cannot support a price')
  assert.equal(res.stored.pricing.lowUsd, 0)
})

test('SCHEMA-INVALID output is not priced either', async () => {
  const h = harness({ ...FAILED, outcome: 'schema_invalid', errorClass: 'other' })
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.stored.pricing.priced, false)
})

test('a BILLING rejection is not priced, and is not mislabelled as our timeout', async () => {
  const h = harness({ ...FAILED, errorClass: 'billing' })
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.degraded, undefined, 'a billing refusal is not a latency problem')
  assert.equal(res.stored.pricing.priced, false, 'but it still bought no read, so it still buys no price')
})

test('the DEFAULTS object can never reach the customer as a number', async () => {
  // The precise production symptom: truckLoads 1 + confidence 0 + zero items priced
  // as a real one-load job.
  const h = harness({ ...FAILED, errorClass: 'network' })
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.stored.analysis.confidence.overall, 0)
  assert.equal(res.stored.analysis.normalizedItems.length, 0)
  assert.equal(res.stored.analysis.estimatedTruckLoads.likely, 1, 'the placeholder is still 1...')
  assert.equal(res.stored.pricing.recommendedUsd, 0, '...but nothing downstream turns it into money')
  assert.equal(res.stored.pricing.priced, false)
})

test('a SUCCESSFUL read is still priced exactly as before', async () => {
  const h = harness()
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.analyzedOk, true)
  assert.equal(res.stored.pricing.priced, true, 'the guard must not suppress real quotes')
  assert.ok(res.stored.pricing.recommendedUsd > 0)
})

test('the durable worker also refuses to price a failed read', async () => {
  // The two paths share buildPhotoEstimate deliberately, so the guard is shared too —
  // a false price is not more acceptable because a worker produced it.
  const h = harness({ ...FAILED, errorClass: 'network' })
  const res = await buildPhotoEstimate({ ...input, budget: durableBudget(), now: () => T0 }, h.deps)
  assert.equal(res.stored.pricing.priced, false)
  assert.equal(res.analyzedOk, false, 'still reported retryable, so the booking ladder still retries')
})

// ── 4. The durable fallback still picks up what the interactive path dropped ──
//
// No new queueing code: /api/book already calls enqueueAiJob for every eligible
// booking (the #175 fix), and enqueueAiJob gates on needsAiJob → !hasValidEstimate.
// What matters here is that withholding the PRICE did not accidentally make a failed
// estimate look finished — if it did, the durable worker would skip the very job the
// interactive path failed to produce, and the customer would get nothing at all.

test('a timed-out estimate is still INVALID, so the durable worker will redo it', async () => {
  const h = harness({ ...FAILED, errorClass: 'network' })
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.stored.status, 'failed', 'status is what needsAiJob keys on')
  assert.equal(
    hasValidEstimate({ aiEstimate: res.stored as never, invoicePhotos: ctx.photoUrls.map(url => ({ url })) }),
    false,
    'an unpriced, failed estimate must NOT satisfy hasValidEstimate — otherwise the '
    + 'durable retry is skipped and the timeout becomes permanent',
  )
})

test('a successful estimate IS valid, so the worker does not redo paid work', async () => {
  const h = harness()
  const res = await buildPhotoEstimate({ ...input, budget: interactiveBudget(T0), now: () => T0 }, h.deps)
  assert.equal(res.stored.status, 'completed')
  assert.equal(
    hasValidEstimate({ aiEstimate: res.stored as never, invoicePhotos: ctx.photoUrls.map(url => ({ url })) }),
    true,
    'a real read must not be re-analysed — that would pay twice for the same answer',
  )
})
