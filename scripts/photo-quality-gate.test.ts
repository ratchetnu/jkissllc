// Photo-Quality Gate (Vision-Estimation Phase 3) — deterministic contract tests.
//
// Runs the PURE gate over synthetic upload metadata (no pixels, no I/O) and
// pins every classification rule, the guidance-relevance, duplicate detection,
// determinism, and threshold configurability. Run: `tsx scripts/photo-quality-gate.test.ts`.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluatePhotoQuality,
  DEFAULT_THRESHOLDS,
  QUALITY_GATE_VERSION,
  GUIDANCE_TEXT,
  type PhotoDescriptor,
  type QualityGateThresholds,
} from '../app/lib/ai/photo-quality-gate'

// A valid, usable photo. `bytes` is spread far apart between photos so the
// near-identical-bytes duplicate heuristic never fires by accident.
function photo(id: string, bytes: number, contentType = 'image/jpeg'): PhotoDescriptor {
  return { id, url: `https://blob.example/${id}.jpg`, contentType, bytes }
}

// A set of N usable, clearly-distinct photos (sizes 200KB, 400KB, 600KB, …).
function usableSet(n: number): PhotoDescriptor[] {
  return Array.from({ length: n }, (_, i) => photo(`p${i}`, 200_000 * (i + 1)))
}

test('too few photos → additional_photos_required', () => {
  const r = evaluatePhotoQuality(usableSet(1))
  assert.equal(r.classification, 'additional_photos_required')
  assert.ok(r.clarificationRecommendations.includes('add_more_photos'))
  assert.equal(r.thresholdsVersion, QUALITY_GATE_VERSION)
})

test('empty submission → additional_photos_required, never throws', () => {
  const r = evaluatePhotoQuality([])
  assert.equal(r.classification, 'additional_photos_required')
  assert.equal(r.score, 0)
  // Null/undefined input must also degrade gracefully.
  assert.equal(evaluatePhotoQuality(null).classification, 'additional_photos_required')
  assert.equal(evaluatePhotoQuality(undefined).classification, 'additional_photos_required')
})

test('a valid set of several usable photos → sufficient', () => {
  const r = evaluatePhotoQuality(usableSet(5))
  assert.equal(r.classification, 'sufficient')
  assert.equal(r.perPhoto.length, 5)
  assert.ok(r.perPhoto.every(p => p.usableForEstimate))
  assert.equal(r.submissionWarnings.length, 0)
  assert.equal(r.missingCoverage.length, 0)
  assert.equal(r.manualReviewReasons.length, 0)
  assert.ok(r.score >= 80)
})

test('unsupported / corrupt content type → per-photo warning + unusable', () => {
  const set = [...usableSet(4), photo('bad', 300_123, 'image/gif')]
  const r = evaluatePhotoQuality(set)
  const bad = r.perPhoto.find(p => p.id === 'bad')!
  assert.ok(bad.warnings.includes('unsupported_type'))
  assert.equal(bad.usableForEstimate, false)
  assert.ok(r.submissionWarnings.includes('unusable_photos_ignored'))
  // 4 good photos remain → still estimable (not blocked).
  assert.ok(r.classification === 'sufficient' || r.classification === 'sufficient_with_warnings')
})

test('too-small bytes flagged unusable', () => {
  const set = [...usableSet(3), photo('tiny', 500)]
  const r = evaluatePhotoQuality(set)
  const tiny = r.perPhoto.find(p => p.id === 'tiny')!
  assert.ok(tiny.warnings.includes('too_small'))
  assert.equal(tiny.usableForEstimate, false)
})

test('too-large bytes flagged unusable', () => {
  const set = [...usableSet(3), photo('huge', 20_000_000)]
  const r = evaluatePhotoQuality(set)
  const huge = r.perPhoto.find(p => p.id === 'huge')!
  assert.ok(huge.warnings.includes('too_large'))
  assert.equal(huge.usableForEstimate, false)
})

test('likely-duplicate detection via near-identical byte size', () => {
  // Two photos within 0.5% byte size → the SECOND is flagged as a duplicate.
  const set = [photo('a', 400_000), photo('b', 400_500), photo('c', 700_000), photo('d', 900_000)]
  const r = evaluatePhotoQuality(set)
  const flagged = r.perPhoto.filter(p => p.warnings.includes('likely_duplicate'))
  assert.equal(flagged.length, 1)
  assert.ok(r.submissionWarnings.includes('duplicates_present'))
  assert.ok(r.clarificationRecommendations.includes('avoid_duplicates'))
  // A duplicate is still counted as usable (fractional coverage), not dropped.
  assert.ok(flagged[0].usableForEstimate)
})

test('all-unusable set → manual_review_required', () => {
  const set = [
    photo('x1', 300_000, 'image/gif'),
    photo('x2', 400_000, 'application/pdf'),
    photo('x3', 800),  // too small
  ]
  const r = evaluatePhotoQuality(set)
  assert.equal(r.classification, 'manual_review_required')
  assert.ok(r.manualReviewReasons.includes('all_photos_unusable'))
  assert.equal(r.score, 0)
  assert.ok(r.perPhoto.every(p => !p.usableForEstimate))
})

test('guidance strings are relevant to the detected gap', () => {
  // Appliance context + few photos → should recommend appliance-state guidance,
  // and NOT recommend appliance guidance when context says nothing.
  const withAppliance = evaluatePhotoQuality(usableSet(2), { applianceLikely: true })
  assert.ok(withAppliance.missingCoverage.includes('appliance_state'))
  assert.ok(withAppliance.clarificationRecommendations.includes('show_appliance_state'))

  const noAppliance = evaluatePhotoQuality(usableSet(5))
  assert.ok(!noAppliance.clarificationRecommendations.includes('show_appliance_state'))

  // Access context → access-path guidance surfaces.
  const withAccess = evaluatePhotoQuality(usableSet(2), { accessMatters: true })
  assert.ok(withAccess.clarificationRecommendations.includes('show_access_path'))

  // Every emitted guidance code must have backing copy.
  for (const code of withAppliance.clarificationRecommendations) {
    assert.equal(typeof GUIDANCE_TEXT[code], 'string')
    assert.ok(GUIDANCE_TEXT[code].length > 0)
  }
})

test('unusable photos produce retake guidance', () => {
  const set = [...usableSet(3), photo('bad', 300_000, 'image/gif')]
  const r = evaluatePhotoQuality(set)
  assert.ok(r.clarificationRecommendations.includes('retake_unusable'))
})

test('deterministic — same input yields byte-identical output', () => {
  const set = [...usableSet(3), photo('bad', 500, 'image/gif'), photo('dupA', 350_000), photo('dupB', 350_400)]
  const a = evaluatePhotoQuality(set, { applianceLikely: true, accessMatters: true })
  const b = evaluatePhotoQuality(set, { applianceLikely: true, accessMatters: true })
  assert.deepEqual(a, b)
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

test('thresholds are configurable — override changes classification', () => {
  const two = usableSet(2)
  // Default minPhotos = 2 → 2 usable photos clear the floor.
  assert.notEqual(evaluatePhotoQuality(two).classification, 'additional_photos_required')
  // Raise the floor to 3 → the same 2 photos are now insufficient.
  const strict: Partial<QualityGateThresholds> = { minPhotos: 3 }
  assert.equal(evaluatePhotoQuality(two, {}, strict).classification, 'additional_photos_required')

  // Widen allowedTypes → a formerly-unsupported type becomes usable.
  const gifSet = [...usableSet(2), photo('g', 300_000, 'image/gif')]
  assert.equal(
    evaluatePhotoQuality(gifSet).perPhoto.find(p => p.id === 'g')!.usableForEstimate,
    false,
  )
  assert.equal(
    evaluatePhotoQuality(gifSet, {}, { allowedTypes: [...DEFAULT_THRESHOLDS.allowedTypes, 'image/gif'] })
      .perPhoto.find(p => p.id === 'g')!.usableForEstimate,
    true,
  )
})

test('optional per-photo pixel signals are used only when present', () => {
  // A photo with a high blur score is dropped; identical photo without the
  // signal survives — proving absence is never penalized.
  const blurred: PhotoDescriptor = { id: 'blur', contentType: 'image/jpeg', bytes: 300_000, blurScore: 0.95 }
  const clean: PhotoDescriptor = { id: 'clean', contentType: 'image/jpeg', bytes: 300_000 }
  const set = [...usableSet(3), blurred, clean]
  const r = evaluatePhotoQuality(set)
  assert.equal(r.perPhoto.find(p => p.id === 'blur')!.usableForEstimate, false)
  assert.equal(r.perPhoto.find(p => p.id === 'clean')!.usableForEstimate, true)
})

test('heic is accepted but advisory', () => {
  const set = [photo('h1', 300_000, 'image/heic'), photo('h2', 500_000, 'image/heif'), ...usableSet(2)]
  const r = evaluatePhotoQuality(set)
  const h1 = r.perPhoto.find(p => p.id === 'h1')!
  assert.ok(h1.warnings.includes('heic_source'))
  assert.equal(h1.usableForEstimate, true) // advisory only
})

test('thin-but-usable set → clarification_recommended, not a hard block', () => {
  // Exactly minPhotos usable, below recommended → nudge, don't block.
  const r = evaluatePhotoQuality(usableSet(2))
  assert.equal(r.classification, 'clarification_recommended')
  assert.ok(r.clarificationRecommendations.length > 0)
  // A thin-but-usable set clears the floor, so we never tell them to add more.
  assert.ok(!r.clarificationRecommendations.includes('add_more_photos'))
})
