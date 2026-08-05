// ── Truck anchor ─────────────────────────────────────────────────────────────
// `estimatedTruckLoadFraction` is the fraction of THE TRUCK, and it is the single
// value the deterministic pricing engine consumes. If a prompt names the wrong
// truck — or names no truck at all — every quote downstream is wrong by that ratio
// and nothing in the response looks broken. These tests guard that anchor.
//
// Run: npx tsx --test scripts/truck-anchor.test.ts

import test from 'node:test'
import assert from 'node:assert/strict'
import { getPrompt, truckPromptVars, TRUCK_PROMPT_DEFAULTS } from '../app/lib/ai/prompts'

/** Every prompt that asks the model to judge how full the truck is. */
const FILL_PROMPTS = ['ops.photoEstimate', 'ops.junkAnalysis', 'ops.junkAnalysisReview']

test('truckPromptVars derives cubic yards and formats capacity', () => {
  assert.deepEqual(truckPromptVars({ truckCapacityCuFt: 1000, truckLengthFt: 24 }),
    { truckCuFt: '1,000', truckCuYd: 37, truckLengthFt: 24 })
  // The 26 ft box is NOT the 24 ft scaled by length — it is measured, and larger
  // than proportional scaling would suggest (1,400, not ~1,083).
  assert.deepEqual(truckPromptVars({ truckCapacityCuFt: 1400, truckLengthFt: 26 }),
    { truckCuFt: '1,400', truckCuYd: 52, truckLengthFt: 26 })
})

test('an unusable capacity falls back to the house truck, never to zero or blank', () => {
  for (const bad of [0, -50, NaN, undefined as unknown as number]) {
    assert.deepEqual(truckPromptVars({ truckCapacityCuFt: bad }), TRUCK_PROMPT_DEFAULTS,
      `capacity ${String(bad)} must fall back, not render as itself`)
  }
  // A capacity without a length is still usable — length is only a label.
  assert.equal(truckPromptVars({ truckCapacityCuFt: 1400 }).truckLengthFt, 24)
})

test('a fill prompt NEVER renders a blank truck, even with no vars at all', () => {
  for (const id of FILL_PROMPTS) {
    const { system } = getPrompt(id).build({})
    assert.ok(/1,000 cu(bic)? f/.test(system) || /about 1,000 cubic feet/.test(system),
      `${id} lost its default capacity`)
    // The failure this guards: "holding about  cubic feet" — an empty tag reads as
    // fluent English and invites the model to invent a truck. So every mention of a
    // unit must be immediately preceded by a number.
    for (const m of system.matchAll(/(.{0,8})cu(bic)? f(t|eet)/g)) {
      assert.match(m[1], /\d[\d,]*\s?$/, `${id} states a capacity unit with no number: "${m[0]}"`)
    }
    assert.ok(!system.includes('{{'), `${id} leaked an unrendered template tag`)
  }
})

test('the tenant setting reaches the rendered prompt', () => {
  const vars = truckPromptVars({ truckCapacityCuFt: 1400, truckLengthFt: 26 })
  for (const id of FILL_PROMPTS) {
    const { system } = getPrompt(id).build(vars)
    assert.ok(system.includes('1,400'), `${id} ignored the configured capacity`)
    assert.ok(system.includes('26 ft'), `${id} ignored the configured length`)
    assert.ok(!system.includes('1,000'), `${id} kept the default alongside the override`)
  }
})

test('no fill prompt still carries the retired 1,200 cu ft / 44 cu yd anchor', () => {
  for (const id of FILL_PROMPTS) {
    const { system } = getPrompt(id).build(truckPromptVars({ truckCapacityCuFt: 1000, truckLengthFt: 24 }))
    assert.ok(!/1,200|44 cubic yards|44 cu yd/.test(system),
      `${id} still anchors to the 1,200 cu ft truck that does not exist`)
  }
})

test('prompt versions were bumped with the text change', () => {
  // The registry contract: "built-in version (bumped on any code change)". A changed
  // prompt running under its old version number makes the audit log lie about what ran.
  for (const id of FILL_PROMPTS) assert.ok(getPrompt(id).version >= 2, `${id} version not bumped`)
})
