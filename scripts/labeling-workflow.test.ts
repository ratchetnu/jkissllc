// Labelling workflow — queues, flags, progress and the calibration gate.
// No network, no clock, no dataset on disk: every case builds its own entries.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildQueues, laneProgress, batch, weakFlags, CALIBRATION_TARGET, PRIORITY_CATEGORIES,
} from '../tools/vision-benchmark/label-queues'
import { assessCalibration, CALIBRATION_GATES, multiPhotoReady } from '../tools/vision-benchmark/readiness'
import type { ManifestEntry } from '../tools/vision-benchmark/schema'

const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  id: over.id ?? 'x1', jobType: 'junk_removal', category: 'curbside_pile',
  sourcePageUrl: '', sourceImageUrl: '', sourceDomain: 'example.org',
  license: 'cc0', licenseVerified: true, downloadPermitted: true, searchQuery: '',
  expectedObjects: [], expectedQuantityRange: null, expectedVolumeRangeCubicYards: null,
  expectedTruckSpaceRangePercent: null, expectedHandlingFlags: [], lighting: null,
  clutter: null, imageQuality: 'high', containsPeople: false, reviewStatus: 'pending',
  notes: '', storedPath: '', sha256: '', phash: '', widthPx: 1600, heightPx: 1200, bytes: 1,
  attribution: '', fetchedAt: '', split: 'development', labelStatus: 'unlabelled',
  expectedCrewRange: null, expectedLaborHoursRange: null, disposalFlags: [],
  accessConcerns: [], labelConfidence: null, difficulty: null,
  ...over,
} as ManifestEntry)

test('a prior human rejection never re-enters any work queue', () => {
  const q = buildQueues([
    entry({ id: 'keep', reviewStatus: 'pending' }),
    entry({ id: 'rejected-forever', reviewStatus: 'rejected' }),
  ])
  const everywhere = Object.values(q).flat().map(c => c.id)
  assert.ok(everywhere.includes('keep'))
  assert.equal(everywhere.includes('rejected-forever'), false)
})

test('lanes never mix and holdout candidates come only from the holdout split', () => {
  const q = buildQueues([
    entry({ id: 'j-dev', jobType: 'junk_removal', split: 'development' }),
    entry({ id: 'm-dev', jobType: 'moving', split: 'development', category: 'studio_inventory' }),
    entry({ id: 'j-hold', jobType: 'junk_removal', split: 'holdout' }),
    entry({ id: 'm-hold', jobType: 'moving', split: 'holdout', category: 'studio_inventory' }),
  ])
  assert.deepEqual(q.junk_development.map(c => c.id), ['j-dev'])
  assert.deepEqual(q.moving_development.map(c => c.id), ['m-dev'])
  assert.deepEqual(q.junk_holdout.map(c => c.id), ['j-hold'])
  assert.deepEqual(q.moving_holdout.map(c => c.id), ['m-hold'])
})

test('an already-verified entry is not queued for labelling again', () => {
  const q = buildQueues([entry({ id: 'done', labelStatus: 'verified' })])
  assert.equal(Object.values(q).flat().length, 0)
})

test('an unrepresented priority category outranks a well-covered one', () => {
  const rows = [
    entry({ id: 'covered', category: 'mattress', labelStatus: 'verified', reviewStatus: 'approved' }),
    entry({ id: 'covered2', category: 'mattress', labelStatus: 'verified', reviewStatus: 'approved' }),
    entry({ id: 'more-mattress', category: 'mattress' }),
    entry({ id: 'fresh', category: 'curbside_pile' }),
  ]
  const top = batch(rows, 'junk_removal', 5)[0]
  assert.equal(top.id, 'fresh')
  assert.ok(top.reasons.some(r => /not yet represented/.test(r)))
})

test('weak and sensitive candidates are FLAGGED into review queues, never rejected', () => {
  const q = buildQueues([
    entry({ id: 'stock', searchQuery: 'sofa isolated on white background' }),
    entry({ id: 'people', containsPeople: true }),
    entry({ id: 'clean' }),
  ])
  assert.deepEqual(q.weak_review.map(c => c.id), ['stock'])
  assert.deepEqual(q.sensitive_review.map(c => c.id), ['people'])
  assert.deepEqual(q.junk_development.map(c => c.id), ['clean'])
  // Flagged is not rejected: the entries still exist and are still workable.
  for (const c of [...q.weak_review, ...q.sensitive_review]) assert.ok(c.flags.length > 0)
})

test('flag vocabulary fires on the signals it claims to detect', () => {
  const cases: Array<[string, string]> = [
    ['showroom floor model', 'showroom'],
    ['scrap yard pile', 'scrapyard'],
    ['recycling centre intake', 'recycling_facility'],
    ['roll off dumpster on site', 'third_party_dumpster'],
    ['3d render of a living room', 'rendering'],
  ]
  for (const [text, flag] of cases) {
    assert.ok(weakFlags(entry({ searchQuery: text })).includes(flag as never), `${text} → ${flag}`)
  }
})

test('a duplicate perceptual hash is flagged, not silently dropped', () => {
  const q = buildQueues([
    entry({ id: 'a', phash: 'ffff' }),
    entry({ id: 'b', phash: 'ffff' }),
  ])
  assert.equal(q.weak_review.length, 1)
  assert.ok(q.weak_review[0].flags.includes('possible_duplicate'))
})

test('progress is reported per lane and never combined', () => {
  const rows = [
    entry({ id: 'j', labelStatus: 'verified', split: 'development' }),
    entry({ id: 'm1', jobType: 'moving', category: 'studio_inventory', labelStatus: 'verified', split: 'development' }),
    entry({ id: 'm2', jobType: 'moving', category: 'boxed_goods', labelStatus: 'verified', split: 'holdout' }),
  ]
  const j = laneProgress(rows, 'junk_removal')
  const m = laneProgress(rows, 'moving')
  assert.equal(j.developmentVerified, 1)
  assert.equal(j.holdoutVerified, 0)
  assert.equal(m.developmentVerified, 1)
  assert.equal(m.holdoutVerified, 1)
  assert.equal(j.developmentTarget, CALIBRATION_TARGET.development)
  assert.equal(j.holdoutTarget, CALIBRATION_TARGET.holdout)
  assert.ok(j.missingPriorityCategories.length < PRIORITY_CATEGORIES.junk_removal.length)
})

test('the calibration gate fails far below target and states the shortfall', () => {
  const rows = Array.from({ length: 3 }, (_, i) =>
    entry({ id: `v${i}`, labelStatus: 'verified', split: 'development' }))
  const c = assessCalibration(rows, 'junk_removal')
  assert.equal(c.ready, false)
  assert.equal(c.developmentVerified, 3)
  const dev = c.gates.find(g => g.name === 'development labels')!
  assert.equal(dev.pass, false)
  assert.match(dev.detail, new RegExp(`3 / ${CALIBRATION_GATES.minDevelopmentVerified}`))
})

test('the calibration gate passes only when every lane requirement is met', () => {
  const rows = [
    ...Array.from({ length: 25 }, (_, i) => entry({
      id: `d${i}`, labelStatus: 'verified', split: 'development',
      category: PRIORITY_CATEGORIES.junk_removal[i % 5],
      difficulty: (i % 2 ? 'easy' : 'hard') as never,
    })),
    ...Array.from({ length: 5 }, (_, i) => entry({
      id: `h${i}`, labelStatus: 'verified', split: 'holdout',
      category: PRIORITY_CATEGORIES.junk_removal[i % 5], difficulty: 'easy' as never,
    })),
  ]
  assert.equal(assessCalibration(rows, 'junk_removal').ready, true)
})

test('multi-photo readiness is a separate gate that stock images cannot satisfy', () => {
  assert.equal(multiPhotoReady(0, 'junk_removal').pass, false)
  assert.equal(multiPhotoReady(4, 'moving').pass, false)
  assert.equal(multiPhotoReady(5, 'moving').pass, true)
  assert.match(multiPhotoReady(1, 'moving').detail, /stock images must NOT be grouped/i)
})
