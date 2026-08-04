// Vision benchmark tooling — unit tests for the PURE logic.
//
// The parts worth pinning are the ones that decide what enters the dataset and
// how it is split, because a mistake there produces a benchmark that reports
// confident numbers about nothing:
//   • the licence gate (fetching NC-licensed images for a commercial product)
//   • the split rules (a near-duplicate leaking across the holdout wall)
//   • ground-truth handling (never inferred, never invented)
// No network, no filesystem writes.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  licenseDecision, piiRisk, validateEntry, hasGroundTruth,
  AUTO_ACCEPT_LICENSES, type ManifestEntry,
} from '../tools/vision-benchmark/schema'
import {
  dHashFromGray, hammingHex, findDuplicates,
  planSplits, splitLeakage, stableFraction, coverage, distributions,
  NEAR_DUPLICATE_MAX_DISTANCE,
} from '../tools/vision-benchmark/dataset'
import { generateQueries, ALL_CATEGORIES, JUNK_CATEGORIES, MOVING_CATEGORIES } from '../tools/vision-benchmark/queries'
import { buildJobs, assertPreviewTarget, serviceFor } from '../tools/vision-benchmark/run-benchmark'
import { proposeGroups } from '../tools/vision-benchmark/organize'

const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  id: 'jr_x_0000000001', jobType: 'junk_removal', category: 'mattress',
  sourcePageUrl: 'https://example.org/p', sourceImageUrl: 'https://example.org/i.jpg',
  sourceDomain: 'example.org', license: 'cc0', licenseVerified: false, downloadPermitted: true,
  searchQuery: 'discarded mattress',
  expectedObjects: [], expectedQuantityRange: null, expectedVolumeRangeCubicYards: null,
  expectedTruckSpaceRangePercent: null, expectedHandlingFlags: [],
  lighting: null, clutter: null, imageQuality: null, containsPeople: null,
  reviewStatus: 'pending', notes: '',
  storedPath: 'junk_removal/mattress/a.jpg', sha256: 'a'.repeat(64), phash: '0000000000000000',
  widthPx: 1200, heightPx: 900, bytes: 100_000, attribution: 'x / flickr / cc0',
  fetchedAt: '2026-08-03T00:00:00.000Z', split: 'unassigned',
  ...over,
})

// ── Licence gate ─────────────────────────────────────────────────────────────

test('only commercial-use + modification licences are auto-accepted', () => {
  for (const ok of [...AUTO_ACCEPT_LICENSES]) {
    assert.equal(licenseDecision(ok).permitted, true, `${ok} should be accepted`)
  }
})

test('every NonCommercial and NoDerivatives variant is refused with a reason', () => {
  for (const bad of ['by-nc', 'by-nc-sa', 'by-nc-nd', 'by-nd', 'sampling+']) {
    const d = licenseDecision(bad)
    assert.equal(d.permitted, false, `${bad} must not be auto-fetched`)
    assert.ok(!d.permitted && d.reason.length > 0, `${bad} must record why`)
  }
})

test('an unknown or missing licence is refused, never assumed permissive', () => {
  assert.equal(licenseDecision(undefined).permitted, false)
  assert.equal(licenseDecision('').permitted, false)
  const d = licenseDecision('some-new-licence-2.0')
  assert.equal(d.permitted, false)
  assert.match((d as { reason: string }).reason, /human review/)
})

test('licence matching is case- and whitespace-insensitive', () => {
  assert.equal(licenseDecision('  CC0 ').permitted, true)
  assert.equal(licenseDecision('BY-SA').permitted, true)
})

// ── Personal-information screen ──────────────────────────────────────────────

test('the PII screen flags people/document terms and stays quiet otherwise', () => {
  assert.equal(piiRisk('Family portrait with children').risky, true)
  assert.equal(piiRisk('car with license plate visible').risky, true)
  assert.equal(piiRisk('old mattress on the kerb').risky, false)
})

test('the PII screen only demotes — it never certifies an image as clean', () => {
  // A clean-sounding title must NOT be treated as evidence there is no person in
  // the photo; approval is gated on a human in label.ts, not on this function.
  const r = piiRisk('pile of construction debris')
  assert.equal(r.risky, false)
  assert.deepEqual(r.matched, [])
})

// ── Validation / ground truth ────────────────────────────────────────────────

test('a fresh entry is structurally valid and carries NO ground truth', () => {
  const e = entry()
  assert.deepEqual(validateEntry(e), [])
  assert.equal(hasGroundTruth(e), false, 'nothing is labelled at acquisition time')
})

test('an entry cannot be approved without a verified licence', () => {
  const problems = validateEntry(entry({ reviewStatus: 'approved', licenseVerified: false }))
  assert.ok(problems.some(p => /licenceVerified/.test(p)))
})

test('an NC-licensed entry can never be a valid manifest row', () => {
  assert.ok(validateEntry(entry({ license: 'by-nc' })).some(p => /not auto-acceptable/.test(p)))
})

test('an inverted ground-truth range is rejected', () => {
  assert.ok(validateEntry(entry({ expectedVolumeRangeCubicYards: { min: 9, max: 2 } })).some(p => /bad range/.test(p)))
})

test('ground truth counts only when a human approved AND labelled it', () => {
  const labelled = { expectedObjects: ['mattress'], expectedVolumeRangeCubicYards: { min: 2, max: 4 } }
  assert.equal(hasGroundTruth(entry({ ...labelled, reviewStatus: 'pending' })), false)
  assert.equal(hasGroundTruth(entry({ reviewStatus: 'approved' })), false, 'approved but unlabelled is not ground truth')
  assert.equal(hasGroundTruth(entry({ ...labelled, reviewStatus: 'approved' })), true)
})

// ── Hashing + duplicates ─────────────────────────────────────────────────────

test('dHash encodes horizontal gradient direction and is stable', () => {
  const ramp = Array.from({ length: 72 }, (_, i) => (i % 9) * 28)   // ascending each row
  const flat = Array.from({ length: 72 }, () => 128)
  assert.equal(dHashFromGray(ramp).length, 16)
  assert.equal(dHashFromGray(ramp), dHashFromGray(ramp), 'deterministic')
  assert.notEqual(dHashFromGray(ramp), dHashFromGray(flat))
})

test('hamming distance is 0 for identical hashes and -1 for incomparable ones', () => {
  assert.equal(hammingHex('ffff', 'ffff'), 0)
  assert.equal(hammingHex('0000', 'ffff'), 16)
  assert.equal(hammingHex('ffff', 'ff'), -1)
})

test('exact duplicates are clustered and the redundant copies identified', () => {
  const es = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c', sha256: 'b'.repeat(64) })]
  const d = findDuplicates(es)
  assert.equal(d.exact.length, 1)
  assert.deepEqual(d.exact[0].ids, ['a', 'b'])
  assert.deepEqual(d.redundantIds, ['b'], 'keep the first, drop the rest')
})

test('near duplicates are detected below the distance threshold', () => {
  const es = [
    entry({ id: 'a', sha256: '1'.repeat(64), phash: '0000000000000000' }),
    entry({ id: 'b', sha256: '2'.repeat(64), phash: '0000000000000001' }),  // 1 bit apart
    entry({ id: 'c', sha256: '3'.repeat(64), phash: 'ffffffffffffffff' }),  // far away
  ]
  const d = findDuplicates(es)
  assert.equal(d.near.length, 1)
  assert.ok(d.near[0].distance <= NEAR_DUPLICATE_MAX_DISTANCE)
  assert.deepEqual([d.near[0].a, d.near[0].b].sort(), ['a', 'b'])
})

// ── Splits ───────────────────────────────────────────────────────────────────

test('split assignment is deterministic for the same id', () => {
  assert.equal(stableFraction('abc'), stableFraction('abc'))
  assert.notEqual(stableFraction('abc'), stableFraction('abd'))
})

test('near-duplicates always land in the SAME split — no holdout leakage', () => {
  const es = [
    entry({ id: 'a', sha256: '1'.repeat(64), phash: '0000000000000000' }),
    entry({ id: 'b', sha256: '2'.repeat(64), phash: '0000000000000001' }),
  ]
  const plan = planSplits(es)
  const where = (id: string) =>
    plan.holdout.includes(id) ? 'holdout' : plan.edge_case.includes(id) ? 'edge' : 'development'
  assert.equal(where('a'), where('b'), 'a cropped copy must not cross the wall')
})

test('an existing split assignment is never reshuffled', () => {
  const es = [entry({ id: 'a', split: 'holdout', sha256: '1'.repeat(64), phash: 'aaaa000000000000' })]
  const plan = planSplits(es)
  assert.deepEqual(plan.holdout, ['a'], 'assignments are permanent — results cannot be moved to look better')
})

test('#edge in the notes forces the edge-case set', () => {
  const es = [entry({ id: 'a', notes: 'partly obscured #edge', sha256: '1'.repeat(64), phash: 'bbbb000000000000' })]
  assert.deepEqual(planSplits(es).edge_case, ['a'])
})

test('splitLeakage reports a near-duplicate pair straddling two splits', () => {
  const es = [
    entry({ id: 'a', split: 'development', sha256: '1'.repeat(64), phash: '0000000000000000' }),
    entry({ id: 'b', split: 'holdout', sha256: '2'.repeat(64), phash: '0000000000000001' }),
  ]
  assert.equal(splitLeakage(es).length, 1)
  assert.equal(splitLeakage([es[0]]).length, 0)
})

// ── Queries + coverage ───────────────────────────────────────────────────────

test('the taxonomy covers both job types and generates expanded queries', () => {
  assert.ok(JUNK_CATEGORIES.length >= 25)
  assert.ok(MOVING_CATEGORIES.length >= 20)
  const qs = generateQueries(ALL_CATEGORIES)
  assert.ok(qs.length > ALL_CATEGORIES.length, 'modifiers must expand the query set')
  assert.equal(new Set(qs.map(q => q.category)).size, ALL_CATEGORIES.length, 'every category is searched')
  assert.ok(qs.some(q => q.jobType === 'moving') && qs.some(q => q.jobType === 'junk_removal'))
})

test('coverage lists EVERY taxonomy category, including the empty ones', () => {
  const rows = coverage([entry({ category: 'mattress' })], ALL_CATEGORIES)
  assert.equal(rows.length, ALL_CATEGORIES.length, 'a gap must be visible, not absent')
  assert.equal(rows.find(r => r.category === 'mattress')!.total, 1)
  assert.equal(rows.find(r => r.category === 'piano_heavy')!.total, 0)
})

test('distributions surface source concentration', () => {
  const d = distributions([entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c', sourceDomain: 'other.org' })])
  assert.equal(d.topDomainShare, 2 / 3)
  assert.equal(d.licenses.cc0, 3)
})

// ── Benchmark job construction ───────────────────────────────────────────────

test('only APPROVED images become benchmark jobs', () => {
  const es = [entry({ id: 'a', reviewStatus: 'approved' }), entry({ id: 'b', reviewStatus: 'pending' })]
  const jobs = buildJobs(es, [])
  assert.equal(jobs.length, 1)
  assert.deepEqual(jobs[0].imageIds, ['a'])
})

test('a multi-photo group is ONE job, and its images are not also run alone', () => {
  const es = [
    entry({ id: 'a', reviewStatus: 'approved' }),
    entry({ id: 'b', reviewStatus: 'approved', sha256: '2'.repeat(64) }),
    entry({ id: 'c', reviewStatus: 'approved', sha256: '3'.repeat(64) }),
  ]
  const jobs = buildJobs(es, [{
    id: 'grp1', jobType: 'junk_removal', category: 'mattress',
    imageIds: ['a', 'b'], reviewStatus: 'approved', notes: '', split: 'development',
  }])
  assert.equal(jobs.length, 2, 'one grouped job + one single')
  assert.deepEqual(jobs.find(j => j.jobId === 'grp1')!.imageIds, ['a', 'b'])
  assert.deepEqual(jobs.find(j => j.jobId !== 'grp1')!.imageIds, ['c'])
})

test('a pending group does not run, and its images fall back to single jobs', () => {
  const es = [entry({ id: 'a', reviewStatus: 'approved' })]
  const jobs = buildJobs(es, [{
    id: 'grp1', jobType: 'junk_removal', category: 'mattress',
    imageIds: ['a'], reviewStatus: 'pending', notes: '', split: 'development',
  }])
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].jobId, 'single_a')
})

test('the runner refuses any target that is not a Preview host', () => {
  assert.throws(() => assertPreviewTarget('https://jkissllc.vercel.app'), /Preview-only/)
  assert.throws(() => assertPreviewTarget('https://jkissllc.com'), /Preview-only/)
  assert.throws(() => assertPreviewTarget('not-a-url'), /not a URL/)
  assert.doesNotThrow(() => assertPreviewTarget('https://jkissllc-abc123-team.vercel.app'))
})

test('moving jobs request the moving service, junk requests junk-removal', () => {
  assert.equal(serviceFor('moving', 'studio_inventory'), 'moving')
  assert.equal(serviceFor('junk_removal', 'construction_debris'), 'junk-removal')
})

// ── Group proposal ───────────────────────────────────────────────────────────

test('groups are proposed only within one category, and never auto-approved', () => {
  const es = [
    entry({ id: 'a', sha256: '1'.repeat(64), phash: '0000000000000000', category: 'mattress' }),
    entry({ id: 'b', sha256: '2'.repeat(64), phash: '0000000000000001', category: 'mattress' }),
  ]
  const groups = proposeGroups(es, [])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].imageIds.sort(), ['a', 'b'])
  assert.equal(groups[0].reviewStatus, 'pending', 'a human confirms these are one job')
})

test('visually similar images from DIFFERENT categories are never grouped', () => {
  const es = [
    entry({ id: 'a', sha256: '1'.repeat(64), phash: '0000000000000000', category: 'mattress' }),
    entry({ id: 'b', sha256: '2'.repeat(64), phash: '0000000000000001', category: 'tires' }),
  ]
  assert.equal(proposeGroups(es, []).length, 0)
})

test('a lone image is not a multi-photo job', () => {
  assert.equal(proposeGroups([entry({ id: 'a' })], []).length, 0)
})
