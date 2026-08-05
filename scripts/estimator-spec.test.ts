// ── Estimator specification enforcement ──────────────────────────────────────
// docs/opspilot-os/vision-estimation/05-estimator-specification.md is the authority
// on what the estimator must do. It is never sent to the model — it explains and
// justifies, the runtime states. These tests are the link between the two: if the
// runtime stops saying something the specification requires, this file fails.
//
// The failure being prevented is the one that already happened: estimator rules
// lived in five places, said the same thing differently, and a fix applied to one
// lane silently left the others behind.
//
// Run: npx tsx --test scripts/estimator-spec.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import {
  ESTIMATOR_CORE, JUNK_ESTIMATOR_MODULE, MOVING_ESTIMATOR_MODULE, composeEstimatorPrompt,
} from '../app/lib/ai/estimator-core'
import { getPrompt } from '../app/lib/ai/prompts'

const SPEC_PATH = new URL('../docs/opspilot-os/vision-estimation/05-estimator-specification.md', import.meta.url)
const spec = readFileSync(SPEC_PATH, 'utf8')

const junk = () => getPrompt('ops.junkAnalysis').build({})
const moving = () => getPrompt('ops.movingAnalysis').build({})

// ── the shared core carries the shared rules ─────────────────────────────────

test('[core] the photo set is analyzed as ONE job, with duplicate views reconciled', () => {
  assert.match(ESTIMATOR_CORE, /COMPLETE photo set as ONE job/i)
  assert.match(ESTIMATOR_CORE, /count each physical object ONCE/i)
  assert.match(ESTIMATOR_CORE, /attribute every item to the photo it was seen in/i,
    'reconciliation must be checkable, not merely asserted')
  // Both lanes inherit it — the rule that used to appear in only two of four prompts.
  for (const [name, built] of [['junk', junk()], ['moving', moving()]] as const) {
    assert.match(built.system, /ONE job/i, `${name} must carry the one-job rule`)
  }
})

test('[core] confidence is 0.0-1.0 and must not default to 1.0', () => {
  assert.match(ESTIMATOR_CORE, /DECIMAL from 0\.0 to 1\.0/)
  assert.match(ESTIMATOR_CORE, /never a percentage, never a string/)
  assert.match(ESTIMATOR_CORE, /DO NOT default to 1\.0/)
  assert.match(ESTIMATOR_CORE, /0\.0 = no reliable evidence/)
  assert.match(ESTIMATOR_CORE, /1\.0 = exceptionally clear/)
  assert.match(ESTIMATOR_CORE, /Perfect confidence is rare/i)
  for (const [name, built] of [['junk', junk()], ['moving', moving()]] as const) {
    assert.match(built.system, /DO NOT default to 1\.0/, `${name} must inherit the no-default rule`)
  }
})

test('[core] prose and chain-of-thought are forbidden, in both lanes', () => {
  assert.match(ESTIMATOR_CORE, /no prose/i)
  assert.match(ESTIMATOR_CORE, /no reasoning/i)
  assert.match(ESTIMATOR_CORE, /minified JSON ONLY/i)
  for (const [name, built] of [['junk', junk()], ['moving', moving()]] as const) {
    assert.match(built.system, /no prose/i, `${name} must forbid prose`)
    assert.match(built.system, /no reasoning/i, `${name} must forbid chain-of-thought`)
  }
})

test('[core] the model never sets a price, in either lane', () => {
  assert.match(ESTIMATOR_CORE, /You NEVER set a price/i)
  for (const [name, built] of [['junk', junk()], ['moving', moving()]] as const) {
    assert.match(built.system, /NEVER set a price/i, `${name} must forbid pricing`)
  }
})

test('[core] conservative ranges, and no invented objects', () => {
  assert.match(ESTIMATOR_CORE, /conservative ranges/i)
  assert.match(ESTIMATOR_CORE, /never invent objects you cannot see/i)
  assert.match(ESTIMATOR_CORE, /out of frame is a risk to report, not an item to list/i)
})

// ── lane purity, in both directions ──────────────────────────────────────────

test('[moving] carries no junk or disposal concepts except to forbid them', () => {
  const { system } = moving()
  for (const word of ['landfill', 'dump', 'disposal', 'debris', 'junk', 'discard']) {
    for (const m of system.matchAll(new RegExp(word, 'gi'))) {
      const around = system.slice(Math.max(0, (m.index ?? 0) - 70), (m.index ?? 0) + word.length + 25)
      assert.match(around, /\b(not|never|no|none)\b/i,
        `"${word}" appears in the moving prompt outside a negation: …${around.trim()}…`)
    }
  }
  assert.match(system, /relocated/i, 'the moving lane must frame the job as a move')
  assert.ok(!system.includes('estimatedTruckLoadFraction'), 'the junk field name must not leak into moving')
})

test('[junk] states no final price and keeps its own vocabulary', () => {
  const { system } = junk()
  assert.match(system, /NO final disposal price/i)
  assert.match(system, /intended for REMOVAL/i)
  // The moving-only wire keys must not appear in the junk contract.
  for (const movingKey of ['"unload"', '"miss"', 'reassembly']) {
    assert.ok(!system.includes(movingKey), `${movingKey} is a moving concept and must not appear in junk`)
  }
})

test('[modules] each service module states what its specification section requires', () => {
  for (const cue of ['cubic-volume', 'truck-space', 'compactable', 'heavy items', 'appliances and mattresses', 'special disposal', 'hazardous', 'crew and labour ranges']) {
    assert.ok(JUNK_ESTIMATOR_MODULE.toLowerCase().includes(cue.toLowerCase()), `junk module must cover "${cue}"`)
  }
  for (const cue of ['box/container inventory', 'fragile', 'disassembly', 'appliance handling', 'crew range', 'loading and unloading', 'missing information']) {
    assert.ok(MOVING_ESTIMATOR_MODULE.toLowerCase().includes(cue.toLowerCase()), `moving module must cover "${cue}"`)
  }
})

// ── the runtime is a compression of the specification, not a copy ────────────

test('the runtime prompt is materially shorter than the specification', () => {
  const runtime = ESTIMATOR_CORE.length + Math.max(JUNK_ESTIMATOR_MODULE.length, MOVING_ESTIMATOR_MODULE.length)
  assert.ok(runtime * 3 < spec.length,
    `the runtime (${runtime} chars) must be a fraction of the spec (${spec.length} chars) — `
    + 'a system prompt is paid for on every request, forever')
  // And the specification must never be shipped as a prompt.
  for (const built of [junk(), moving()]) {
    assert.ok(!built.system.includes('## 1. Scope and separation'), 'the spec is documentation, not runtime')
    assert.ok(built.system.length < 6000, 'a runtime prompt must stay compact')
  }
})

test('composeEstimatorPrompt puts the shared rules before the lane-specific ones', () => {
  const out = composeEstimatorPrompt({ role: 'ROLE.', module: 'MODULE.', contract: 'CONTRACT.' })
  assert.ok(out.indexOf('ROLE.') < out.indexOf(ESTIMATOR_CORE.slice(0, 30)))
  assert.ok(out.indexOf(ESTIMATOR_CORE.slice(0, 30)) < out.indexOf('MODULE.'),
    'general rules are established before a lane qualifies them')
  assert.ok(out.indexOf('MODULE.') < out.indexOf('CONTRACT.'))
})

// ── the specification itself stays honest ────────────────────────────────────

test('the specification documents every rule these tests enforce', () => {
  for (const rule of [
    'analyze **all submitted photos as one job**',
    'count each physical object **once**',
    'Never calculate final customer pricing',
    'Never return chain-of-thought or prose',
    'Never default confidence to 1.0',
    'Never mix the lanes',
    'Never fail open',
  ]) {
    assert.ok(spec.toLowerCase().includes(rule.toLowerCase()), `the specification must state: ${rule}`)
  }
  assert.match(spec, /is never sent to the model/i, 'the spec must say it is not a prompt')
  assert.match(spec, /moving \*\*2400\*\*, \*\*junk 1600\*\*|moving 2400.*junk 1600/i,
    'the spec must record the output ceilings it governs')
})

test('the caps and lane separation the specification claims are the ones in force', async () => {
  const fs = await import('node:fs')
  const movingSrc = fs.readFileSync(new URL('../app/lib/ai/moving-analysis.ts', import.meta.url), 'utf8')
  const junkSrc = fs.readFileSync(new URL('../app/lib/ai/junk-analysis.ts', import.meta.url), 'utf8')
  assert.match(movingSrc, /MOVING_MAX_OUTPUT_TOKENS = 2400/)
  assert.match(junkSrc, /maxOutputTokens: 1600/, 'the junk ceiling is unchanged by this work')
  // Separate schemas and normalizers — the property §1 exists to protect.
  assert.match(movingSrc, /normalizeMovingAnalysis/)
  assert.match(junkSrc, /normalizeAnalysis/)
  assert.ok(!junkSrc.includes('normalizeMovingAnalysis'), 'the lanes must not share a normalizer')
})

test('a changed prompt carries a new version', () => {
  // A changed prompt running under its old version number makes the audit log lie.
  assert.ok(getPrompt('ops.junkAnalysis').version >= 3, 'junk was recomposed → v3')
  assert.ok(getPrompt('ops.movingAnalysis').version >= 4, 'moving was recomposed → v4')
})
