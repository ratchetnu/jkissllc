// ── Moving confidence ────────────────────────────────────────────────────────
// Every live moving case returned 1.0 on all five dimensions. That put the whole
// sample in the top calibration band with a 56% false-high rate — a confidence
// column that cannot be wrong is not a measurement.
//
// Two causes, both fixed here: the prompt never said what the numbers meant, and
// the parser clamped anything out of contract into range — so 85 became a perfect
// 1.0 and a missing field became a silent 0.5.
//
// Run: npx tsx --test scripts/moving-confidence.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeMovingAnalysis, parseConfidenceValue, normalizeConfidence,
  UNKNOWN_CONFIDENCE, CRITICAL_CONFIDENCE_DIMENSIONS,
  type MovingConfidence, type NormalizeMovingCtx,
} from '../app/lib/ai/analysis-schema-moving'
import { getPrompt } from '../app/lib/ai/prompts'

const ctx = (photos = 2): NormalizeMovingCtx => ({
  analysisId: 'mv-conf-0001', bookingId: 'draft',
  photoUrls: Array.from({ length: photos }, (_, i) => `https://x/${i}.jpg`),
  modelProvider: 'vercel-ai-gateway', modelName: 'test-model', analyzedAt: '2026-08-05T00:00:00Z',
})

/** A compact response with controllable evidence quality. */
function payload(over: {
  conf?: Record<string, unknown>; iq?: string; dup?: number
  vol?: number[]; acc?: string[]; miss?: string[]; rev?: boolean; items?: number
} = {}) {
  const n = over.items ?? 6
  const items = Array.from({ length: n }, (_, i) =>
    `{"cat":"furn","l":"item ${i}","q":1,"s":"m","v":25,"c":0.8,"p":0}`).join(',')
  const conf = JSON.stringify(over.conf ?? { o: 0.9, i: 0.9, q: 0.9, v: 0.9, a: 0.9, l: 0.9 })
  const photos = `[{"p":0,"iq":"${over.iq ?? 'good'}"${over.dup != null ? `,"dup":${over.dup}` : ''}},{"p":1,"iq":"good"}]`
  const vol = JSON.stringify(over.vol ?? [180, 200, 220])
  return `{"items":[${items}],"photos":${photos},"box":[4,5,6],"vol":${vol},`
    + `"truck":[0.15,0.2,0.25],"crew":[2,2,3],"load":[1.5,2,2.5],"unload":[1,1.5,2],`
    + `"acc":${JSON.stringify(over.acc ?? ['stairs'])},"miss":${JSON.stringify(over.miss ?? ['dest'])},`
    + `"conf":${conf},"rev":${over.rev ?? false}}`
}

const clear = { o: 0.95, i: 0.95, q: 0.95, v: 0.95, a: 0.95, l: 0.95 }

// ── value-level validation ───────────────────────────────────────────────────

test('a confidence value must be a decimal 0..1 — everything else is rejected', () => {
  assert.deepEqual(parseConfidenceValue(0.7), { value: 0.7 })
  assert.deepEqual(parseConfidenceValue(0), { value: 0 })
  assert.deepEqual(parseConfidenceValue(1), { value: 1 })
  // The exact failure that manufactured certainty: a percentage clamped to 1.0.
  assert.equal(parseConfidenceValue(85).value, null, '85 is a percentage, not a confidence')
  assert.match(parseConfidenceValue(85).problem!, /above-1/)
  assert.equal(parseConfidenceValue('0.8').value, null, 'a string is not a number')
  assert.equal(parseConfidenceValue(NaN).value, null)
  assert.equal(parseConfidenceValue(undefined).value, null)
  assert.equal(parseConfidenceValue(null).value, null)
  assert.equal(parseConfidenceValue(-0.2).value, null)
})

test('invalid confidence becomes UNKNOWN and is reported — never 1.0', () => {
  const a = normalizeMovingAnalysis(payload({ conf: { o: 100, i: 'high', q: NaN, v: 0.8, a: 0.8, l: 0.8 } }), ctx())
  assert.notEqual(a.confidence.overall, 1, 'an out-of-contract value must never become certainty')
  assert.ok(a.confidence.overall <= UNKNOWN_CONFIDENCE + 0.05)
  assert.ok(a.warnings.length >= 3, 'each invalid field is named, so a broken run looks broken')
  assert.ok(a.warnings.some(w => /overall/.test(w)) && a.warnings.some(w => /inventory/.test(w)))
})

// ── evidence-driven normalization ────────────────────────────────────────────

test('a clear, complete room keeps high confidence', () => {
  const a = normalizeMovingAnalysis(payload({ conf: clear, iq: 'excellent', acc: ['stairs'], miss: [] }), ctx())
  assert.ok(a.confidence.inventory >= 0.9, 'good evidence is not punished')
  assert.ok(a.confidence.overall >= 0.9)
})

test('incomplete coverage lowers inventory, quantity, volume and overall', () => {
  const a = normalizeMovingAnalysis(payload({ conf: clear, iq: 'limited', miss: [] }), ctx())
  for (const k of ['inventory', 'quantity', 'volume', 'overall'] as const) {
    assert.ok(a.confidence[k] < 0.95, `${k} must fall when coverage is partial (got ${a.confidence[k]})`)
  }
})

test('a low-light / unusable photo lowers confidence', () => {
  const a = normalizeMovingAnalysis(payload({ conf: clear, iq: 'unusable', miss: [] }), ctx())
  assert.ok(a.confidence.overall < 0.7)
})

test('duplicate-photo ambiguity lowers quantity and overall', () => {
  const a = normalizeMovingAnalysis(payload({ conf: clear, dup: 1, miss: [] }), ctx())
  assert.ok(a.confidence.quantity < 0.95, 'the same room possibly counted twice is a counting risk')
  assert.ok(a.confidence.overall < 0.95)
  // Volume is not directly implicated by a duplicate view.
  assert.ok(a.confidence.volume >= a.confidence.quantity)
})

test('an uncertain volume range lowers volume and overall', () => {
  const wide = normalizeMovingAnalysis(payload({ conf: clear, vol: [100, 200, 400], miss: [] }), ctx())
  const tight = normalizeMovingAnalysis(payload({ conf: clear, vol: [190, 200, 210], miss: [] }), ctx())
  assert.ok(wide.confidence.volume < tight.confidence.volume,
    'a 4x-wide range is not a confident estimate')
})

test('missing access information lowers access confidence only', () => {
  const a = normalizeMovingAnalysis(payload({ conf: clear, acc: [], miss: ['stairs'] }), ctx())
  assert.ok(a.confidence.access < 0.7, 'never seeing the access route caps that dimension')
  assert.ok(a.confidence.inventory >= 0.9, 'but it says nothing about the inventory')
})

test('uncertain quantities are reflected when the model says so', () => {
  const a = normalizeMovingAnalysis(payload({ conf: { ...clear, q: 0.4 }, miss: [] }), ctx())
  assert.equal(a.confidence.quantity, 0.4, 'a low claim is preserved, never raised')
  assert.ok(a.confidence.overall <= 0.45, 'and overall cannot outrun it')
})

test('overall can never materially exceed the weakest critical dimension', () => {
  const out = normalizeConfidence(
    { overall: 1, inventory: 0.4, quantity: 0.9, volume: 0.9, access: 0.9, labor: 0.9 } as MovingConfidence,
    { incompleteCoverage: false, duplicateUncertainty: false, uncertainVolume: false, missingAccessInfo: false },
  )
  assert.ok(out.overall <= 0.45, `overall ${out.overall} must track the weakest critical dimension (0.4)`)
  assert.deepEqual([...CRITICAL_CONFIDENCE_DIMENSIONS], ['inventory', 'quantity', 'volume', 'access'])
})

test('inadequate evidence cannot produce an all-1.0 confidence object', () => {
  const a = normalizeMovingAnalysis(
    payload({ conf: { o: 1, i: 1, q: 1, v: 1, a: 1, l: 1 }, iq: 'limited', dup: 1, vol: [50, 200, 500], acc: [], miss: ['stairs'] }),
    ctx())
  const values = Object.values(a.confidence)
  assert.ok(!values.every(v => v === 1), 'the exact live failure: every dimension at 1.0')
  assert.ok(values.some(v => v < 0.7), 'weak evidence must show up somewhere')
  assert.ok(a.confidence.overall < 0.7)
})

test('the five dimensions stay independent — they are not one number copied', () => {
  const a = normalizeMovingAnalysis(
    payload({ conf: { o: 0.8, i: 0.9, q: 0.5, v: 0.7, a: 0.3, l: 0.6 }, miss: [] }), ctx())
  const { inventory, quantity, volume, access } = a.confidence
  assert.equal(new Set([inventory, quantity, volume, access]).size, 4, 'four distinct values survive')
})

// ── contract + blast radius ──────────────────────────────────────────────────

test('the prompt states the scale, the anchors, and the do-not-default rule', () => {
  const { system } = getPrompt('ops.movingAnalysis').build({})
  assert.equal(getPrompt('ops.movingAnalysis').version, 3, 'a changed contract needs a new version')
  assert.match(system, /DECIMAL from 0\.0 to 1\.0/)
  assert.match(system, /never a percentage, never a string/)
  assert.match(system, /DO NOT default to 1\.0/)
  assert.match(system, /0\.0 = no reliable evidence/)
  assert.match(system, /0\.5 = partial, uncertain, obstructed or incomplete evidence/)
  assert.match(system, /1\.0 = exceptionally clear, complete, fully supported evidence/)
  for (const cue of ['partial room coverage', 'occluded', 'uncertain quantities', 'poor lighting', 'access route']) {
    assert.ok(system.includes(cue), `the prompt must name "${cue}" as a reason to lower confidence`)
  }
  assert.match(system, /"conf":\{"o":number,"i":number,"q":number/, 'quantity is its own dimension on the wire')
})

test('the compact schema, caps and junk behaviour are untouched', async () => {
  const fs = await import('node:fs')
  const moving = fs.readFileSync(new URL('../app/lib/ai/moving-analysis.ts', import.meta.url), 'utf8')
  const junk = fs.readFileSync(new URL('../app/lib/ai/junk-analysis.ts', import.meta.url), 'utf8')
  assert.match(moving, /MOVING_MAX_OUTPUT_TOKENS = 2400/)
  assert.match(junk, /maxOutputTokens: 1600/, 'the junk cap is not this PR to change')
  // The junk lane has its own confidence shape and must not gain moving penalties.
  assert.ok(!junk.includes('normalizeConfidence'), 'junk confidence behaviour is unchanged')
  const a = normalizeMovingAnalysis(payload(), ctx())
  assert.equal(a.normalizedItems.length, 6, 'the compact item shape still parses')
  assert.ok(!JSON.stringify(a).toLowerCase().includes('landfill'))
})
