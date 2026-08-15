// JK-B-1022 regression — a response we could not read must never become an analysis.
//
// WHAT HAPPENED. Six photos of a cleanout (sofa, dresser, weight bench, several boxes)
// were analyzed successfully by the model. The reply was cut off at the 1600-token cap
// mid-object. `JSON.parse` threw, a bare `catch` set `raw = undefined`, and
// `normalizeAnalysis({})` then produced a COMPLETE-LOOKING analysis entirely out of
// defaults. Downstream that is indistinguishable from "the AI looked and found nothing":
// the booking went to manual review, `runAiTask` recorded outcome=success, quality
// scored 75, and no dashboard showed anything wrong. The read was discarded in silence.
//
//   T1  the fabricated-default shape is EXACTLY what production stored (the evidence)
//   T2  truncation is detected from the provider's own stop reason
//   T3  a truncated response is rejected even when it happens to parse
//   T4  an unreadable response is a named failure, not an empty analysis
//   T5  a genuinely empty read stays `no_items` — the two must not be conflated
//   T6  the token budget scales with photo count and clears the value that failed
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

import { analysisOutputTokenBudget, readAnalysisResponse } from '../app/lib/ai/junk-analysis'
import { normalizeAnalysis, type NormalizeCtx } from '../app/lib/ai/analysis-schema'

const CTX: NormalizeCtx = {
  analysisId: 'a1',
  bookingId: 'b1',
  photoUrls: Array.from({ length: 6 }, (_, i) => `https://blob.example/p${i}.jpg`),
  modelProvider: 'anthropic',
  modelName: 'anthropic/claude-sonnet-4-6',
  analyzedAt: '2026-08-15T02:12:17.000Z',
}

// ── T1 — the evidence ────────────────────────────────────────────────────────

test('T1: normalizeAnalysis(undefined) fabricates the exact analysis production stored', () => {
  // Every one of these values was read back off JK-B-1022 after the failure. None of
  // them came from the model. This test exists so that anyone who later wonders "why not
  // just let the normalizer handle a bad parse?" can see what that actually produces.
  const a = normalizeAnalysis(undefined, CTX)

  assert.deepEqual(a.normalizedItems, [], 'zero items — reads as "found nothing"')
  assert.equal(a.confidence.overall, 0)
  assert.equal(a.confidence.volume, 0)
  assert.equal(a.confidence.itemClassification, 0)
  assert.equal(Object.values(a.detectedConditions).every(v => v === false), true)

  // The giveaway: a tidy 0.7 / 1 / 1.4 spread, which is the range helper's default
  // fan-out around a likely of 1 — not a judgement about a truck.
  assert.equal(a.estimatedTruckLoads.minimum, 0.7)
  assert.equal(a.estimatedTruckLoads.likely, 1)
  assert.equal(a.estimatedTruckLoads.maximum, 1.4)

  // One synthesized observation per URL, each claiming the image was poor — which is
  // what made this look like a photo-quality problem rather than a parsing one.
  assert.equal(a.photoObservations.length, 6)
  assert.equal(a.photoObservations.every(o => o.imageQuality === 'limited'), true)

  // And it is structurally complete, so nothing downstream can tell it apart from a
  // real analysis by shape alone. That is the whole danger.
  assert.ok(a.estimatedTruckLoads && a.confidence && a.detectedConditions)
})

// ── T2 / T3 — truncation ─────────────────────────────────────────────────────

test('T2: truncation is taken from the provider stop reason, both spellings', () => {
  assert.equal(readAnalysisResponse('{"normalizedItems":[]}', { finishReason: 'length' }).truncated, true)
  assert.equal(readAnalysisResponse('{"normalizedItems":[]}', { outputTruncated: true }).truncated, true)
  assert.equal(readAnalysisResponse('{"normalizedItems":[]}', { finishReason: 'stop' }).truncated, false)
  assert.equal(readAnalysisResponse('{"normalizedItems":[]}', {}).truncated, false)
})

test('T3: a realistically truncated response cannot be parsed at all', () => {
  // Worth stating precisely, because it is why the original bug was invisible rather
  // than loud. The regex spans the first `{` to the LAST `}`. On a cut-off response the
  // outer brace is never closed, so whatever the last `}` closes, the match always has
  // unbalanced braces and `JSON.parse` throws. The old bare `catch` turned that throw
  // into `raw = undefined` and the normalizer took it from there.
  const cut = '{"normalizedItems":[{"category":"furniture","label":"sofa","estimatedQuantity":1},{"category":"appliance"'
  const read = readAnalysisResponse(cut, { finishReason: 'length' })
  assert.equal(read.parseFailed, true)
  assert.equal(read.raw, undefined, 'and nothing survives to be mistaken for an analysis')
})

test('T3: truncation is judged INDEPENDENTLY of whether the text parsed', () => {
  // The two signals must not be collapsed. A response that parses but was cut off is
  // still untrustworthy — the items array may be a fragment of the load, and pricing a
  // job off a fragment is a confident wrong number, which is worse than a review.
  const parses = '{"normalizedItems":[{"category":"furniture","label":"sofa","estimatedQuantity":1}]}'
  const read = readAnalysisResponse(parses, { finishReason: 'length' })
  assert.equal(read.parseFailed, false, 'this one genuinely parses')
  assert.equal(read.truncated, true, 'and is still rejected on the stop reason alone')
})

test('T3: MUTATION GUARD — without the truncation flag, the two failures become one', () => {
  // Delete the `truncated` half of the guard and a token-budget problem reports as
  // `unparseable_response`, sending the next person to debug the prompt or the model
  // instead of raising the cap. The outcome name IS the fix, so it has to be right.
  const cut = '{"normalizedItems":[{"category":"furniture"'
  const truncatedRead = readAnalysisResponse(cut, { finishReason: 'length' })
  const malformedRead = readAnalysisResponse('not json at all', { finishReason: 'stop' })

  assert.equal(truncatedRead.parseFailed, malformedRead.parseFailed,
    'parseFailed alone cannot tell these apart — both are true')
  assert.notEqual(truncatedRead.truncated, malformedRead.truncated,
    'only the truncation flag distinguishes "raise the budget" from "fix the prompt"')
})

// ── T4 / T5 — unreadable vs genuinely empty ──────────────────────────────────

test('T4: an unreadable response is a named failure, not an empty analysis', () => {
  for (const text of ['', 'I could not analyze these photos.', 'null', '{oops', '[]']) {
    const read = readAnalysisResponse(text, { finishReason: 'stop' })
    assert.equal(read.parseFailed, true, `should not be readable: ${JSON.stringify(text)}`)
    assert.equal(read.raw, undefined)
  }
})

test('T5: a genuine empty read parses cleanly and stays distinguishable', () => {
  // An empty garage really can contain nothing. That must remain `no_items` — a
  // different outcome with a different fix from "we could not read the reply".
  const read = readAnalysisResponse('{"normalizedItems":[],"confidence":{"overall":0.9}}', { finishReason: 'stop' })
  assert.equal(read.parseFailed, false)
  assert.equal(read.truncated, false)
  const a = normalizeAnalysis(read.raw, CTX)
  assert.equal(a.normalizedItems.length, 0)
  assert.equal(a.confidence.overall, 0.9, 'a real empty read carries real confidence — the fabricated one is 0')
})

// ── T6 — the token budget ────────────────────────────────────────────────────

test('T6: the budget scales with photo count and clears the value that failed', () => {
  assert.ok(analysisOutputTokenBudget(6) > 1600, 'the six-photo job that truncated must now fit')
  assert.ok(analysisOutputTokenBudget(6) > analysisOutputTokenBudget(1), 'more photos, more output')
  assert.equal(analysisOutputTokenBudget(1), 2600)
  assert.equal(analysisOutputTokenBudget(6), 5600)
})

test('T6: the budget is bounded and total on junk input', () => {
  // It raises a ceiling; it does not remove one. A runaway response stays capped.
  assert.equal(analysisOutputTokenBudget(8), analysisOutputTokenBudget(999), 'clamped at the 8-photo intake limit')
  assert.ok(analysisOutputTokenBudget(999) <= 8000)
  for (const bad of [0, -3, NaN, 1.7]) {
    const v = analysisOutputTokenBudget(bad as number)
    assert.ok(Number.isFinite(v) && v >= 2600, `must stay sane for ${bad}`)
  }
})
