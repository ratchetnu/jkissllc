// analyzePhotosV2 — multi-pass junk-removal vision orchestrator contract tests.
//
// The AI + quality gate are DEPENDENCY-INJECTED, so these run with NO live provider
// call. They pin: a well-formed model response normalizes into a V2 analysis with
// per-image + unified inventory; overlapping-photo dedup keeps sourceImageIds on a
// merged object; a malformed response triggers ONE repair retry and, if still bad,
// falls back to a manual-review shell (never 'completed'); 0 usable photos → fallback;
// the prompt version is stamped; a provider error fails soft. Run:
//   tsx scripts/analysis-v2.test.ts
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  analyzePhotosV2,
  type AnalyzePhotosV2Deps,
} from '../app/lib/ai/analysis-v2'
import { ANALYSIS_V2_PROMPT_VERSION, buildAnalysisV2Prompt } from '../app/lib/ai/analysis-v2-prompt'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const blob = (name: string) => `https://store.public.blob.vercel-storage.com/${name}`

// A gate result marking the first `usable` photos usable and the rest unusable.
function gateFor(ids: string[], usable = ids.length) {
  return {
    classification: 'sufficient' as const,
    score: 90,
    perPhoto: ids.map((id, i) => ({ id, usableForEstimate: i < usable, warnings: [] as string[] })),
    submissionWarnings: [],
    missingCoverage: [],
    clarificationRecommendations: [],
    manualReviewReasons: [],
    thresholdsVersion: 1,
  }
}

// A successful runAiTask result carrying arbitrary model text.
function aiOk(text: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true as const,
    data: {},
    text,
    callId: 'call_1',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    latencyMs: 42,
    model: 'anthropic/claude-sonnet-4-6',
    promptVersion: 1,
    qualityScore: 0.9,
    ...over,
  }
}

// A well-formed V2 model JSON (two images, one deduplicated object).
const WELL_FORMED = JSON.stringify({
  perImageObservations: [
    {
      imageId: 'img_1', sceneDescription: 'garage with a couch', locationType: 'garage',
      items: [{ name: 'sofa', quantity: 1, material: 'upholstered', disposalCategory: 'landfill', bulky: true, heavy: true, confidence: 'high' }],
      imageQuality: 'good', confidence: 'high',
    },
    {
      imageId: 'img_2', sceneDescription: 'same couch, other angle', locationType: 'garage',
      items: [{ name: 'sofa', quantity: 1, material: 'upholstered', disposalCategory: 'landfill', bulky: true, heavy: true, confidence: 'high' }],
      imageQuality: 'good', confidence: 'high',
    },
  ],
  unifiedInventory: [
    {
      objectId: 'object_001', category: 'furniture', description: 'three-seat sofa',
      quantity: 1, minQuantity: 1, maxQuantity: 1,
      sourceImageIds: ['img_1', 'img_2'],
      duplicateReasoning: 'Same sofa visible in both photos from different angles.',
      weightClass: 'heavy', disposalClass: 'landfill', specialHandling: ['2-person lift'], confidence: 'high',
    },
  ],
  sceneSummary: 'One sofa in a garage.',
  laborAssessment: { estimatedCrewSize: 2 },
  confidence: 'high', confidenceScore: 0.8,
  customerSafeSummary: 'We can see a sofa to remove.',
  internalOwnerSummary: 'Single sofa, deduped across two garage photos.',
})

// ── Tests ────────────────────────────────────────────────────────────────────

test('well-formed model response normalizes into a V2 analysis (per-image + unified)', async () => {
  const ids = ['img_1', 'img_2']
  const deps: AnalyzePhotosV2Deps = {
    evaluateQuality: () => gateFor(ids) as any,
    runAi: (async () => aiOk(WELL_FORMED)) as any,
  }
  const r = await analyzePhotosV2(
    { bookingId: 'b1', photoUrls: [blob('a.jpg'), blob('b.jpg')], nowIso: '2026-07-15T00:00:00Z' },
    deps,
  )
  assert.equal(r.ok, true)
  assert.equal(r.outcome, 'completed')
  assert.equal(r.analysis.manualReviewRequired, false)
  assert.equal(r.analysis.perImageObservations.length, 2)
  assert.equal(r.analysis.unifiedInventory.length, 1)
  assert.equal(r.analysis.imageCountReceived, 2)
  assert.equal(r.analysis.imageCountUsable, 2)
  // No price anywhere in the contract — model never sets money.
  assert.equal((r.analysis as any).price, undefined)
})

test('overlapping-photo response keeps sourceImageIds on the merged object', async () => {
  const ids = ['img_1', 'img_2']
  const deps: AnalyzePhotosV2Deps = {
    evaluateQuality: () => gateFor(ids) as any,
    runAi: (async () => aiOk(WELL_FORMED)) as any,
  }
  const r = await analyzePhotosV2(
    { bookingId: 'b1', photoUrls: [blob('a.jpg'), blob('b.jpg')], nowIso: '2026-07-15T00:00:00Z' },
    deps,
  )
  const obj = r.analysis.unifiedInventory[0]
  assert.deepEqual(obj.sourceImageIds, ['img_1', 'img_2'])
  assert.equal(obj.quantity, 1) // not double-counted across the two photos
  assert.ok(obj.duplicateReasoning && obj.duplicateReasoning.length > 0)
})

test('malformed response → repair retry → still bad → manual-review fallback (never completed)', async () => {
  const ids = ['img_1', 'img_2']
  let calls = 0
  const deps: AnalyzePhotosV2Deps = {
    evaluateQuality: () => gateFor(ids) as any,
    runAi: (async () => { calls++; return aiOk('sorry, I cannot produce JSON here') }) as any,
  }
  const r = await analyzePhotosV2(
    { bookingId: 'b1', photoUrls: [blob('a.jpg'), blob('b.jpg')], nowIso: '2026-07-15T00:00:00Z' },
    deps,
  )
  assert.equal(calls, 2, 'should attempt exactly one repair retry')
  assert.equal(r.ok, false)
  assert.equal(r.outcome, 'invalid_response')
  assert.equal(r.analysis.manualReviewRequired, true)
  assert.ok(r.analysis.manualReviewReasons.length > 0)
  assert.ok(typeof r.rawDebug === 'string' && r.rawDebug.length > 0)
})

test('repair retry recovers when the second response is valid', async () => {
  const ids = ['img_1', 'img_2']
  let calls = 0
  const deps: AnalyzePhotosV2Deps = {
    evaluateQuality: () => gateFor(ids) as any,
    runAi: (async () => { calls++; return calls === 1 ? aiOk('no json') : aiOk(WELL_FORMED) }) as any,
  }
  const r = await analyzePhotosV2(
    { bookingId: 'b1', photoUrls: [blob('a.jpg'), blob('b.jpg')], nowIso: '2026-07-15T00:00:00Z' },
    deps,
  )
  assert.equal(calls, 2)
  assert.equal(r.ok, true)
  assert.equal(r.outcome, 'completed')
  assert.equal(r.analysis.unifiedInventory.length, 1)
})

test('0 usable photos → manual-review fallback, no AI call', async () => {
  const ids = ['img_1', 'img_2']
  let called = false
  const deps: AnalyzePhotosV2Deps = {
    evaluateQuality: () => gateFor(ids, 0) as any, // all unusable
    runAi: (async () => { called = true; return aiOk(WELL_FORMED) }) as any,
  }
  const r = await analyzePhotosV2(
    { bookingId: 'b1', photoUrls: [blob('a.jpg'), blob('b.jpg')], nowIso: '2026-07-15T00:00:00Z' },
    deps,
  )
  assert.equal(called, false, 'must not call the model when nothing is usable')
  assert.equal(r.ok, false)
  assert.equal(r.outcome, 'no_usable_photos')
  assert.equal(r.analysis.manualReviewRequired, true)
  assert.equal(r.analysis.imageCountReceived, 2)
  assert.equal(r.analysis.imageCountUsable, 0)
})

test('prompt version const is stamped onto the analysis', async () => {
  assert.equal(ANALYSIS_V2_PROMPT_VERSION, 'v2-1')
  assert.equal(buildAnalysisV2Prompt(2).version, 'v2-1')
  const ids = ['img_1']
  const deps: AnalyzePhotosV2Deps = {
    evaluateQuality: () => gateFor(ids) as any,
    runAi: (async () => aiOk(WELL_FORMED)) as any,
  }
  const r = await analyzePhotosV2(
    { bookingId: 'b1', photoUrls: [blob('a.jpg')], nowIso: '2026-07-15T00:00:00Z' },
    deps,
  )
  assert.equal(r.analysis.promptVersion, 'v2-1')
})

test('provider error → fail-soft manual-review fallback', async () => {
  const ids = ['img_1', 'img_2']
  const deps: AnalyzePhotosV2Deps = {
    evaluateQuality: () => gateFor(ids) as any,
    runAi: (async () => ({ ok: false, error: 'boom', status: 503, callId: 'call_err', outcome: 'provider_error' })) as any,
  }
  const r = await analyzePhotosV2(
    { bookingId: 'b1', photoUrls: [blob('a.jpg'), blob('b.jpg')], nowIso: '2026-07-15T00:00:00Z' },
    deps,
  )
  assert.equal(r.ok, false)
  assert.equal(r.outcome, 'provider_error')
  assert.equal(r.analysis.manualReviewRequired, true)
  assert.equal(r.callId, 'call_err')
})

test('the customerSafeSummary and internalOwnerSummary survive normalization', async () => {
  const ids = ['img_1', 'img_2']
  const deps: AnalyzePhotosV2Deps = {
    evaluateQuality: () => gateFor(ids) as any,
    runAi: (async () => aiOk(WELL_FORMED)) as any,
  }
  const r = await analyzePhotosV2(
    { bookingId: 'b1', photoUrls: [blob('a.jpg'), blob('b.jpg')], nowIso: '2026-07-15T00:00:00Z' },
    deps,
  )
  assert.ok(r.analysis.customerSafeSummary.length > 0)
  assert.ok(r.analysis.internalOwnerSummary.length > 0)
})
