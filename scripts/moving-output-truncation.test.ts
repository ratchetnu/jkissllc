// ── Moving structured-output truncation ──────────────────────────────────────
// Three of four paid moving calls came back with zero items. They were not empty
// reads: the model hit maxOutputTokens=1600 mid-object, the JSON never closed, and
// normalization discarded the whole answer. The two failures are indistinguishable
// from outside — zero items either way — but they mean opposite things, and only
// one of them is fixed by changing a number.
//
// Fixtures are sized from the real measurement: ~74 output tokens per item in the
// verbose contract, ~19 in the compact one.
// Run: npx tsx --test scripts/moving-output-truncation.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeMovingAnalysis, MISSING_CODES, type NormalizeMovingCtx,
} from '../app/lib/ai/analysis-schema-moving'
import { MOVING_MAX_OUTPUT_TOKENS } from '../app/lib/ai/moving-analysis'
import { getPrompt } from '../app/lib/ai/prompts'
import { decideMovingQuote } from '../app/lib/pricing/moving-decision'
import { DEFAULT_MOVING } from '../app/lib/pricing/moving-quote'

const ctx = (photos = 3): NormalizeMovingCtx => ({
  analysisId: 'mv-trunc-0001', bookingId: 'draft',
  photoUrls: Array.from({ length: photos }, (_, i) => `https://x/${i}.jpg`),
  modelProvider: 'vercel-ai-gateway', modelName: 'test-model', analyzedAt: '2026-08-05T00:00:00Z',
})

/** ~4 chars per token for minified JSON — the same basis as the measurement. */
const tokens = (s: string) => Math.round(s.length / 4)

/** A compact-contract response with n items, as the prompt now specifies. */
function compactPayload(n: number): string {
  const items = Array.from({ length: n }, (_, i) =>
    `{"cat":"furn","l":"item ${i}","q":1,"s":"m","v":25,"fl":["b"],"c":0.8,"p":${i % 3}}`).join(',')
  return `{"items":[${items}],"photos":[{"p":0,"iq":"good"},{"p":1,"iq":"good"},{"p":2,"iq":"limited"}],`
    + `"box":[10,14,18],"vol":[150,200,260],"truck":[0.15,0.2,0.3],"crew":[2,2,3],`
    + `"load":[1.5,2,3],"unload":[1,1.5,2],"acc":["stairs"],"miss":["dest","dist"],`
    + `"conf":{"o":0.8,"i":0.8,"v":0.75,"a":0.6,"l":0.7},"rev":false}`
}

/** The old verbose contract, for the size comparison that motivated the change. */
function verbosePayload(n: number): string {
  const items = Array.from({ length: n }, (_, i) =>
    `{"category":"furniture","label":"item ${i}","quantity":{"minimum":1,"likely":1,"maximum":1},`
    + `"sizeClass":"medium","estimatedVolumeCubicFeet":25,"bulky":true,"fragile":false,`
    + `"requiresDisassembly":false,"isAppliance":false,"confidence":0.8,`
    + `"evidence":"visible against the far wall of the room"}`).join(',')
  return `{"normalizedItems":[${items}]}`
}

// ── the original failure, reproduced ─────────────────────────────────────────

test('the verbose contract truncates a three-bedroom inventory at the old 1600 cap', () => {
  // 25 items is a representative three-bedroom read — the case that failed live.
  const full = verbosePayload(25)
  assert.ok(tokens(full) > 1600,
    `the verbose contract needs ~${tokens(full)} tokens for 25 items — over the old 1600 cap`)

  // Cut it where the cap would: the JSON never closes.
  const cut = full.slice(0, 1600 * 4)
  assert.throws(() => JSON.parse(cut), 'a truncated response is not parseable')

  const a = normalizeMovingAnalysis(cut, ctx())
  assert.equal(a.normalizedItems.length, 0, 'the whole read is discarded — this is the live failure')
  assert.equal(a.reviewRequired, true, 'and it must route to a human, not to an empty quote')
})

test('the compact contract fits studio, two-bedroom and three-bedroom inventories', () => {
  for (const [name, n] of [['studio', 8], ['two-bedroom', 18], ['three-bedroom', 30]] as const) {
    const payload = compactPayload(n)
    const used = tokens(payload)
    assert.ok(used < MOVING_MAX_OUTPUT_TOKENS,
      `${name} (${n} items) needs ~${used} tokens, cap is ${MOVING_MAX_OUTPUT_TOKENS}`)
    const a = normalizeMovingAnalysis(payload, ctx())
    assert.equal(a.normalizedItems.length, n, `${name} must normalize every item`)
  }
})

test('compaction is what buys the headroom, not the bigger cap', () => {
  const n = 25
  const before = tokens(verbosePayload(n)), after = tokens(compactPayload(n))
  assert.ok(after * 2 < before,
    `compact must more than halve the output (${before} → ${after} tokens for ${n} items)`)
  // Raising the cap alone would not have been enough headroom for a large job.
  assert.ok(tokens(verbosePayload(60)) > 3000, 'the verbose contract would blow even a 3000 cap')
})

// ── the cap ──────────────────────────────────────────────────────────────────

test('the moving cap is 2400 and the junk cap is untouched', async () => {
  assert.equal(MOVING_MAX_OUTPUT_TOKENS, 2400)
  const junk = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../app/lib/ai/junk-analysis.ts', import.meta.url), 'utf8'))
  assert.match(junk, /maxOutputTokens: 1600/, 'the junk lane keeps its own cap — this PR must not move it')
})

// ── compact parsing ──────────────────────────────────────────────────────────

test('compact codes expand to the operational shape', () => {
  const a = normalizeMovingAnalysis(compactPayload(3), ctx())
  assert.equal(a.normalizedItems[0].category, 'furniture')
  assert.equal(a.normalizedItems[0].sizeClass, 'medium')
  assert.equal(a.normalizedItems[0].bulky, true, 'fl:["b"] sets bulky')
  assert.equal(a.normalizedItems[0].photoIndex, 0, 'items keep their source photo')
  assert.deepEqual(a.estimatedTruckSpaceFraction, { minimum: 0.15, likely: 0.2, maximum: 0.3 })
  assert.deepEqual(a.recommendedCrewSize, { minimum: 2, likely: 2, maximum: 3 })
  assert.equal(a.access.stairsVisible, true, 'acc codes set only what was seen')
  assert.equal(a.access.elevatorVisible, false, 'an absent code stays false')
  // Codes expand to the SAME wording missingRequiredFacts() produces from booking data.
  assert.deepEqual(a.missingInformation, [MISSING_CODES.dest, MISSING_CODES.dist])
})

test('an exact count and an uncertain range both parse', () => {
  const a = normalizeMovingAnalysis(
    '{"items":[{"cat":"box","l":"boxes","q":[8,12],"s":"s","v":3,"c":0.7,"p":0},'
    + '{"cat":"appl","l":"washer","q":1,"s":"l","v":30,"c":0.9,"p":0}],"truck":[0.1,0.1,0.2]}', ctx(1))
  assert.deepEqual(a.normalizedItems[0].quantity, { minimum: 8, likely: 10, maximum: 12 })
  assert.deepEqual(a.normalizedItems[1].quantity, { minimum: 1, likely: 1, maximum: 1 })
  assert.equal(a.normalizedItems[1].isAppliance, true, 'cat:appl implies the appliance flag')
})

test('omitted flags mean false, never unknown', () => {
  const a = normalizeMovingAnalysis('{"items":[{"cat":"unk","l":"thing","q":1,"s":"s","v":1,"c":0.5,"p":0}]}', ctx(1))
  const i = a.normalizedItems[0]
  assert.equal(i.fragile, false)
  assert.equal(i.requiresDisassembly, false)
  assert.equal(i.isAppliance, false)
})

test('the legacy verbose shape still normalizes', () => {
  const a = normalizeMovingAnalysis(verbosePayload(2), ctx(1))
  assert.equal(a.normalizedItems.length, 2, 'a stored or replayed legacy response must not break')
})

// ── safe failure ─────────────────────────────────────────────────────────────

test('a truncated read can never become an empty confident quote', () => {
  const a = normalizeMovingAnalysis(compactPayload(20).slice(0, 400), ctx())
  assert.equal(a.normalizedItems.length, 0)
  const d = decideMovingQuote({
    analysis: a, settings: DEFAULT_MOVING,
    facts: { travelMiles: 10, originStairsFlights: 0, destinationStairsFlights: 0, destinationKnown: true },
  })
  assert.equal(d.decision, 'manual_review', 'zero inventory must route to a human')
  assert.equal(d.priced, false, 'and must carry no price at all')
  assert.equal(d.recommendedUsd, 0)
  assert.deepEqual(d.rangeUsd, { low: 0, high: 0 })
})

test('no disposal vocabulary survives anywhere in the moving contract', () => {
  const { system } = getPrompt('ops.movingAnalysis').build({})
  for (const word of ['landfill', 'dump', 'disposal', 'debris', 'junk', 'discard']) {
    for (const m of system.matchAll(new RegExp(word, 'gi'))) {
      const around = system.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + word.length + 20)
      assert.match(around, /\b(not|never|no)\b/i, `"${word}" appears outside a negation`)
    }
  }
  const a = normalizeMovingAnalysis(compactPayload(5), ctx())
  const blob = JSON.stringify(a).toLowerCase()
  for (const banned of ['landfill', 'dumptrip', 'disposalcents', 'debris']) {
    assert.ok(!blob.includes(banned), `a moving analysis must never contain "${banned}"`)
  }
})

test('the compact prompt forbids prose and states the enums', () => {
  const { system } = getPrompt('ops.movingAnalysis').build({})
  assert.ok(getPrompt('ops.movingAnalysis').version >= 2, 'the compact contract is v2 or later')
  // Compactness is now stated once, in the shared estimator core.
  assert.match(system, /every sentence you write is inventory that gets cut off/i)
  assert.match(system, /no prose/i)
  assert.match(system, /no code fences/i)
  assert.match(system, /furn\|appl\|elec/, 'category codes must be stated or the model invents them')
  // The old verbose field names must be gone, or the model answers in both shapes.
  // Check the FIELD names in the output contract, not the words: the prompt still
  // says "evidence" in the rule that forbids writing any.
  for (const gone of ['"estimatedTruckSpaceFraction"', '"recommendedCrewSize"', '"normalizedItems"', '"evidence"']) {
    assert.ok(!system.includes(gone), `the compact prompt must not still ask for ${gone}`)
  }
  // Evidence prose is forbidden once, in the shared core, rather than per lane.
  assert.match(system, /no explanations/i, 'and it must forbid explanatory prose')
})
