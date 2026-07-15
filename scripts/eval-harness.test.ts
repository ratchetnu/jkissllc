// Tests for the offline evaluation harness (Phase 14) + fixtures (Phase 13) of the
// V2 photo estimator. Pure + deterministic — NO live AI calls, NO real customer
// data; every fixture is a hand-authored, anonymized JunkPhotoAnalysisV2. Run via tsx.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  runEval,
  EVAL_THRESHOLDS,
  type Fixture,
} from '../app/lib/estimation/eval-harness'
import { FIXTURES, CLEAN_MINIMAL_FIXTURES } from '../app/lib/estimation/fixtures'

// ── Fixtures load ─────────────────────────────────────────────────────────────
test('the representative fixture set loads and is well-formed', () => {
  assert.ok(Array.isArray(FIXTURES))
  assert.ok(FIXTURES.length >= 18, `expected ~18 fixtures, got ${FIXTURES.length}`)
  const ids = new Set(FIXTURES.map((f) => f.id))
  assert.equal(ids.size, FIXTURES.length, 'fixture ids are unique')
  for (const f of FIXTURES) {
    assert.equal(f.analysis.schemaVersion, 2, `${f.id}: V2 schema`)
    assert.ok(f.groundTruth, `${f.id}: has groundTruth`)
    assert.ok(Array.isArray(f.groundTruth.expectedCategories), `${f.id}: categories`)
    assert.ok(Array.isArray(f.groundTruth.expectedVolumeCuYd) && f.groundTruth.expectedVolumeCuYd.length === 2, `${f.id}: volume range`)
  }
  // The Phase 13 coverage list is present.
  for (const id of ['single-couch', 'overlapping-same-item', 'different-rooms-similar', 'hazard-paint-chemicals', 'specialty-piano', 'no-usable-images', 'more-than-one-load', 'poor-lighting-blurry']) {
    assert.ok(ids.has(id), `missing coverage fixture: ${id}`)
  }
})

// ── runEval produces metrics ──────────────────────────────────────────────────
test('runEval produces the full metrics block over all fixtures', () => {
  const r = runEval(FIXTURES)
  assert.equal(r.totals.cases, FIXTURES.length)
  const m = r.metrics
  for (const k of [
    'inventoryPrecision', 'inventoryRecall', 'countAccuracy', 'duplicateErrorRate',
    'volumeCoverageRate', 'loadTierExactAccuracy', 'loadTierWithinOneAccuracy',
    'quoteRangePresenceRate', 'manualReviewRecall', 'hazardRecall', 'specialtyRecall',
    'clarificationRecall',
  ] as const) {
    assert.equal(typeof m[k], 'number', `metric ${k} is a number`)
  }
  // Every case gets a range priced (quote-range presence is total).
  assert.equal(m.quoteRangePresenceRate, 1)
})

// ── The full representative set meets every regression threshold ──────────────
test('the representative fixture set PASSES all EVAL_THRESHOLDS', () => {
  const r = runEval(FIXTURES)
  assert.equal(r.pass, true, `breaches: ${r.breaches.join('; ')}`)
  assert.equal(r.breaches.length, 0)
  assert.equal(r.totals.passed, r.totals.cases, 'every per-case check passes on the baseline')
})

// ── Determinism / reproducibility ─────────────────────────────────────────────
test('runEval is deterministic — identical output across runs', () => {
  const a = runEval(FIXTURES)
  const b = runEval(FIXTURES)
  assert.deepEqual(a.metrics, b.metrics)
  assert.deepEqual(a.perCase.map((c) => [c.id, c.pass]), b.perCase.map((c) => [c.id, c.pass]))
})

// ── Dedup: overlapping photos collapse to count 1 (error 0) ──────────────────
test('overlapping-photos fixture yields duplicate-object error 0 (dedup worked)', () => {
  const dedupFixtures = FIXTURES.filter((f) => f.groundTruth.dedupCheck)
  assert.ok(dedupFixtures.length >= 2, 'has dedup fixtures')
  const r = runEval(dedupFixtures)
  assert.equal(r.metrics.duplicateErrorRate, 0, 'no duplicate error on correctly-deduped fixtures')
  const overlap = r.perCase.find((c) => c.id === 'overlapping-same-item')
  assert.ok(overlap)
  assert.equal(overlap!.predictedItemCount, 1, 'same couch across 2 images → count 1')
  assert.equal(overlap!.checks.countOk, true)
})

// ── A deliberately-broken dedup fixture is FLAGGED (count not collapsed) ──────
test('a broken dedup fixture (same item duplicated) is flagged as a duplicate error', () => {
  const overlap = FIXTURES.find((f) => f.id === 'overlapping-same-item')!
  // Break it: split the single deduped couch into TWO separate objects (count 2)
  // while ground truth still says the dedup target is 1.
  const broken: Fixture = {
    ...overlap,
    id: 'overlapping-BROKEN',
    analysis: {
      ...overlap.analysis,
      unifiedInventory: [
        { ...overlap.analysis.unifiedInventory[0], objectId: 'dup_a', sourceImageIds: ['img_1'] },
        { ...overlap.analysis.unifiedInventory[0], objectId: 'dup_b', sourceImageIds: ['img_2'] },
      ],
    },
  }
  const r = runEval([broken])
  assert.equal(r.metrics.duplicateErrorRate, 1, 'un-collapsed duplicate → error rate 1')
  assert.equal(r.pass, false, 'duplicate-error threshold gate fails')
  assert.ok(r.breaches.some((b) => /duplicateErrorRate/.test(b)))
})

// ── Hazard fixture → manual review + hazard recall ───────────────────────────
test('hazard fixture routes to manual review and counts toward hazard recall', () => {
  const hazard = FIXTURES.find((f) => f.id === 'hazard-paint-chemicals')!
  const r = runEval([hazard])
  const c = r.perCase[0]
  assert.equal(c.predictedManualReview, true, 'hazard → manual review')
  assert.equal(c.predictedHazard, true, 'hazard flag detected')
  assert.equal(r.metrics.hazardRecall, 1)
  assert.equal(r.metrics.manualReviewRecall, 1)
  assert.equal(c.pass, true)
})

// ── Specialty fixture → specialty flag recall ────────────────────────────────
test('specialty fixture (piano) is detected and routed to manual review', () => {
  const piano = FIXTURES.find((f) => f.id === 'specialty-piano')!
  const r = runEval([piano])
  const c = r.perCase[0]
  assert.equal(c.predictedSpecialty, true)
  assert.equal(c.predictedManualReview, true)
  assert.equal(r.metrics.specialtyRecall, 1)
})

// ── Thresholds gate pass/fail: a clean set passes; a bad case fails it ────────
test('a clean minimal set passes the thresholds', () => {
  const r = runEval(CLEAN_MINIMAL_FIXTURES)
  assert.equal(r.pass, true, `breaches: ${r.breaches.join('; ')}`)
})

test('injecting a missed-review case breaks the manual-review recall gate', () => {
  // A fixture whose ground truth demands manual review, but the analysis is a clean,
  // confident single couch that the engine will NOT flag → recall drops below 1.0.
  const single = FIXTURES.find((f) => f.id === 'single-couch')!
  const badCase: Fixture = {
    ...single,
    id: 'should-review-but-wont',
    groundTruth: { ...single.groundTruth, expectManualReview: true },
  }
  const r = runEval([...CLEAN_MINIMAL_FIXTURES, badCase])
  assert.ok(r.metrics.manualReviewRecall < EVAL_THRESHOLDS.minManualReviewRecall)
  assert.equal(r.pass, false, 'the manual-review recall gate must fail')
  assert.ok(r.breaches.some((b) => /manualReviewRecall/.test(b)))
  const c = r.perCase.find((x) => x.id === 'should-review-but-wont')!
  assert.equal(c.pass, false)
  assert.ok(c.failures.some((f) => /manualReview/.test(f)))
})

// ── Custom thresholds are honored ─────────────────────────────────────────────
test('runEval honors overridden thresholds', () => {
  // Force an impossible bar to prove the gate is actually evaluated.
  const r = runEval(CLEAN_MINIMAL_FIXTURES, { thresholds: { minInventoryRecall: 1.01 } })
  assert.equal(r.pass, false)
  assert.ok(r.breaches.some((b) => /inventoryRecall/.test(b)))
})
