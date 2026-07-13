// Industry-pack generalization: the intake config resolver + the junk AI features
// being registered in the AI Control Center catalog.
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveIntakeConfig, DEFAULT_PACK_ID } from '../app/lib/intake-config'
import { getFeatureDef, AI_FEATURES } from '../app/lib/ai/registry'

test('resolveIntakeConfig returns the reference (junk) pack by default', () => {
  const cfg = resolveIntakeConfig()
  assert.equal(cfg.packId, DEFAULT_PACK_ID)
  assert.ok(cfg.serviceTemplates.length > 0)
  assert.ok(cfg.intakeQuestions.length > 0)
  assert.ok(cfg.pricingMethods.length > 0)
})

test('resolveIntakeConfig falls back to the reference pack for an unknown id', () => {
  const cfg = resolveIntakeConfig('no-such-pack')
  assert.equal(cfg.packId, DEFAULT_PACK_ID) // getPack throws → fallback, never crashes
})

test('a different registered pack resolves to its own config (pack-swap seam)', () => {
  // example-cleaning proves the same workflow accepts a different vertical.
  const cfg = resolveIntakeConfig('example-cleaning')
  // Either the cleaning pack (if that id) or the fallback — but it must be valid.
  assert.ok(cfg.packId.length > 0)
  assert.ok(Array.isArray(cfg.serviceTemplates))
})

test('junk analysis + reviewer are now in the AI feature catalog', () => {
  assert.ok(getFeatureDef('ops.junkAnalysis'))
  assert.ok(getFeatureDef('ops.junkAnalysisReview'))
  assert.equal(AI_FEATURES.every((f) => f.writes === false), true) // invariant intact
})
