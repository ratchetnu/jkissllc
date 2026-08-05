// ── Benchmark lane separation ────────────────────────────────────────────────
// One property, tested from several directions: a junk case and a moving case
// never meet. Not in the job list, not in the scoring, not in the report. The
// failure this prevents is not a crash — it is a plausible percentage computed
// from the wrong answer key, which looks exactly like a real result.
//
// Fixture-driven. No dataset on disk, no network, no model.
// Run: npx tsx --test scripts/vision-benchmark-lanes.test.ts

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildJobs } from '../tools/vision-benchmark/run-benchmark'
import { JUNK_SCORING, MOVING_SCORING, scoringFor, assertLane, scorableDimensions } from '../tools/vision-benchmark/scoring'
import { READINESS_GATES, MOVING_READINESS_GATES, gatesFor, assessReadiness } from '../tools/vision-benchmark/readiness'
import type { ManifestEntry, JobType, Split } from '../tools/vision-benchmark/schema'

/** A fully verified entry — every field `hasGroundTruth` requires. */
function entry(over: Partial<ManifestEntry> & { id: string; jobType: JobType }): ManifestEntry {
  return {
    category: over.jobType === 'moving' ? 'two_bed_inventory' : 'mattress',
    sourcePageUrl: 'https://example.test/p', sourceImageUrl: 'https://example.test/i.jpg',
    sourceDomain: 'example.test', license: 'cc0', licenseVerified: true, downloadPermitted: true,
    searchQuery: 'q',
    expectedObjects: ['sofa', 'boxes'],
    expectedQuantityRange: { min: 1, max: 3 },
    expectedVolumeRangeCubicYards: { min: 2, max: 6 },
    expectedTruckSpaceRangePercent: { min: 10, max: 25 },
    expectedHandlingFlags: [],
    lighting: 'normal', clutter: 'medium', imageQuality: 'high', containsPeople: false,
    reviewStatus: 'approved', notes: 'clear enough',
    labelStatus: 'verified',
    expectedCrewRange: { min: 2, max: 3 },
    expectedLaborHoursRange: { min: 1, max: 2 },
    disposalFlags: [], accessConcerns: [], labelConfidence: 'high', difficulty: 'normal',
    flagsReviewed: true, verifiedAt: '2026-08-04T00:00:00Z',
    storedPath: 'images/x.jpg', sha256: 'a'.repeat(64), phash: '0'.repeat(16),
    widthPx: 1200, heightPx: 900, bytes: 100_000, acquiredAt: '2026-08-03T00:00:00Z',
    split: 'development' as Split,
    ...over,
  } as ManifestEntry
}

const junkVerified = [entry({ id: 'jr_a', jobType: 'junk_removal' }), entry({ id: 'jr_b', jobType: 'junk_removal' })]
const movingVerified = Array.from({ length: 10 }, (_, i) => entry({
  id: `mv_${i}`, jobType: 'moving', split: i === 9 ? 'holdout' : 'development',
}))
const excluded = [
  entry({ id: 'jr_rejected', jobType: 'junk_removal', reviewStatus: 'rejected' }),
  entry({ id: 'jr_draft', jobType: 'junk_removal', labelStatus: 'draft' }),
  entry({ id: 'jr_pending', jobType: 'junk_removal', reviewStatus: 'pending' }),
  entry({ id: 'mv_unverified', jobType: 'moving', labelStatus: 'unlabelled' }),
  // Approved and "verified" but with a required field blank — not ground truth.
  entry({ id: 'mv_partial', jobType: 'moving', expectedCrewRange: null }),
]
const ALL = [...junkVerified, ...movingVerified, ...excluded]

// ── job building ─────────────────────────────────────────────────────────────

test('[bench:junk] sees only verified junk cases', () => {
  const jobs = buildJobs(ALL, [], undefined, 'junk_removal')
  assert.equal(jobs.length, 2)
  assert.ok(jobs.every(j => j.jobType === 'junk_removal'))
  assert.deepEqual(jobs.map(j => j.imageIds[0]).sort(), ['jr_a', 'jr_b'])
})

test('[bench:moving] sees all 10 verified moving cases', () => {
  const jobs = buildJobs(ALL, [], undefined, 'moving')
  assert.equal(jobs.length, 10, 'the complete verified moving set runs')
  assert.ok(jobs.every(j => j.jobType === 'moving'))
})

test('[bench:all] runs both lanes and mixes neither', () => {
  const jobs = buildJobs(ALL, [], undefined, undefined)
  assert.equal(jobs.length, 12)
  assert.equal(jobs.filter(j => j.jobType === 'junk_removal').length, 2)
  assert.equal(jobs.filter(j => j.jobType === 'moving').length, 10)
})

test('rejected, draft, pending and unverified cases enter NEITHER lane', () => {
  const ids = new Set(buildJobs(ALL, [], undefined, undefined).map(j => j.imageIds[0]))
  for (const bad of ['jr_rejected', 'jr_draft', 'jr_pending', 'mv_unverified', 'mv_partial']) {
    assert.ok(!ids.has(bad), `${bad} must never run`)
  }
})

test('holdout assignment stays frozen — a split filter never reaches it', () => {
  const dev = buildJobs(ALL, [], 'development', 'moving')
  assert.equal(dev.length, 9, 'nine development labels, holdout excluded')
  assert.ok(!dev.some(j => j.split === 'holdout'))
  const holdout = buildJobs(ALL, [], 'holdout', 'moving')
  assert.equal(holdout.length, 1, 'the holdout is reachable only by asking for it explicitly')
})

// ── scoring ──────────────────────────────────────────────────────────────────

test('each lane is scored with its OWN fields', () => {
  assert.equal(scoringFor('junk_removal').jobType, 'junk_removal')
  assert.equal(scoringFor('moving').jobType, 'moving')

  const junkKeys = JUNK_SCORING.dimensions.map(d => d.key)
  const movingKeys = MOVING_SCORING.dimensions.map(d => d.key)
  // Disposal flags are a junk question and appear in no moving spec.
  assert.ok(junkKeys.includes('disposal_flags'))
  assert.ok(!movingKeys.includes('disposal_flags'))
  // The moving lane owns the missing-information decision; junk has no such call.
  assert.ok(movingKeys.includes('missing_information'))
  assert.ok(!junkKeys.includes('missing_information'))
})

test('a moving result CANNOT silently pass through junk scoring', () => {
  const movingLabel = movingVerified[0]
  const junkLabel = junkVerified[0]
  // Right spec, right lane: fine.
  assert.doesNotThrow(() => assertLane(MOVING_SCORING, movingLabel, 'moving'))
  assert.doesNotThrow(() => assertLane(JUNK_SCORING, junkLabel, 'junk_removal'))
  // Junk spec over a moving label: refused, loudly.
  assert.throws(() => assertLane(JUNK_SCORING, movingLabel, 'moving'), /scoring spec mismatch/)
  // A moving label paired with a junk result: refused before any number exists.
  assert.throws(() => assertLane(MOVING_SCORING, movingLabel, 'junk_removal'), /lane mismatch/)
})

test('unlabelled dimensions are excluded from scoring, not counted as zero', () => {
  const blank = entry({ id: 'mv_blank', jobType: 'moving', expectedObjects: [], labelConfidence: null })
  const keys = scorableDimensions(MOVING_SCORING, blank).map(d => d.key)
  assert.ok(!keys.includes('item_detection'), 'an empty object list is not a failed detection')
  assert.ok(!keys.includes('confidence'), 'a blank confidence label cannot calibrate anything')
  assert.ok(keys.includes('crew'), 'the fields that ARE labelled still score')
})

test('genuinely unlabelled moving fields are declared, not silently dropped', () => {
  const keys = MOVING_SCORING.unavailable.map(u => u.key)
  // The labelling UI captured ONE labour range, so loading vs unloading cannot be
  // separated — and the fix is to say so, not to demand ten labels be redone.
  assert.ok(keys.includes('labor_split'))
  assert.ok(keys.includes('box_count'))
  for (const u of MOVING_SCORING.unavailable) assert.ok(u.reason.length > 20, `${u.key} needs a real reason`)
  assert.equal(JUNK_SCORING.unavailable.length, 0)
})

// ── readiness ────────────────────────────────────────────────────────────────

test('the moving gate demands all ten labels, not the junk pilot floor', () => {
  assert.equal(MOVING_READINESS_GATES.minVerified, 10)
  assert.equal(MOVING_READINESS_GATES.minDevelopmentVerified, 9)
  assert.equal(gatesFor('moving').minVerified, 10)
  assert.equal(gatesFor('junk_removal').minVerified, READINESS_GATES.minVerified)
})

test('the ten verified moving labels pass their own readiness gate', () => {
  const r = assessReadiness(ALL, 'moving')
  assert.equal(r.verified, 10)
  const blocking = r.gates.filter(g => !g.pass).map(g => g.name)
  assert.deepEqual(blocking.filter(n => n === 'verified labels' || n === 'development-split labels'), [],
    'the complete moving set must clear its count gates')
})

test('readiness never counts the other lane', () => {
  const junk = assessReadiness(ALL, 'junk_removal')
  const moving = assessReadiness(ALL, 'moving')
  assert.equal(junk.verified, 2)
  assert.equal(moving.verified, 10)
  assert.notEqual(junk.verified + moving.verified, junk.verified, 'the lanes are counted apart')
})
