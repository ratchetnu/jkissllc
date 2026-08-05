// Autonomous dataset curation — the guarantees that make the automation safe to
// trust. Pure: no network, no clock, no model calls.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  independenceViolations, appendRevision, tierSupportsClaim, TERMINAL_STATES,
  type LabelProvenance, type RoleAssignment,
} from '../tools/vision-benchmark/curation/types'
import {
  preScreen, validateProposal, decide, rangeOverlap, THRESHOLDS,
  type LabelProposal, type ConsensusInput,
} from '../tools/vision-benchmark/curation/consensus'
import {
  tierOf, tierReport, assertClaimSupported, estimateCost, cacheKey, isRetryable,
} from '../tools/vision-benchmark/curation/tiers'
import type { ManifestEntry } from '../tools/vision-benchmark/schema'

const PROD = 'anthropic/claude-sonnet-4-6'

const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  id: 'e1', jobType: 'junk_removal', category: 'curbside_pile', sourcePageUrl: '',
  sourceImageUrl: '', sourceDomain: 'x.org', license: 'cc0', licenseVerified: true,
  downloadPermitted: true, searchQuery: '', expectedObjects: [], expectedQuantityRange: null,
  expectedVolumeRangeCubicYards: null, expectedTruckSpaceRangePercent: null,
  expectedHandlingFlags: [], lighting: null, clutter: null, imageQuality: 'high',
  containsPeople: false, reviewStatus: 'pending', notes: '', storedPath: '', sha256: 'h1',
  phash: '', widthPx: 1600, heightPx: 1200, bytes: 1, attribution: '', fetchedAt: '',
  split: 'development', labelStatus: 'unlabelled', expectedCrewRange: null,
  expectedLaborHoursRange: null, disposalFlags: [], accessConcerns: [],
  labelConfidence: null, difficulty: null, ...over,
} as ManifestEntry)

const proposal = (over: Partial<LabelProposal> = {}): LabelProposal => ({
  lane: 'junk_removal', category: 'curbside_pile', visibleItems: ['sofa', 'boxes'],
  quantityRange: { min: 3, max: 6 }, volumeCubicFeet: { min: 90, max: 150 },
  truckSpacePercent: { min: 9, max: 15 }, handlingFlags: ['two_person_lift'],
  hazardousIndicators: [], crewRange: { min: 2, max: 2 }, laborHoursRange: { min: 1, max: 2 },
  difficulty: 'normal', ambiguityNotes: '', fieldConfidence: { volume: 0.8 }, ...over,
})

const input = (over: Partial<ConsensusInput> = {}): ConsensusInput => ({
  preScreen: { state: null, reasons: [] },
  classifier: { operational: true, lane: 'junk_removal', category: 'curbside_pile', privacyRisk: false, licenseRisk: false, confidence: 0.95 },
  label: proposal(),
  verifier: { verdict: 'approve', disagreements: [], confidence: 0.95 },
  ...over,
})

// ── Independence ────────────────────────────────────────────────────────────

test('the production estimator may never label, verify or adjudicate', () => {
  for (const role of ['labeler', 'verifier', 'adjudicator'] as const) {
    const roles: RoleAssignment[] = [
      { role: 'labeler', model: 'openai/gpt-4o', promptVersion: 'v1' },
      { role: 'verifier', model: 'google/gemini-2.5-flash', promptVersion: 'v1' },
    ]
    const i = roles.findIndex(r => r.role === role)
    if (i >= 0) roles[i] = { ...roles[i], model: PROD }
    else roles.push({ role, model: PROD, promptVersion: 'v1' })
    const v = independenceViolations(roles, PROD)
    assert.ok(v.some(x => /cannot grade itself/.test(x)), `${role} using the production model must be refused`)
  }
})

test('labeler and verifier must not be the same model, and same-family warns', () => {
  const same = independenceViolations([
    { role: 'labeler', model: 'openai/gpt-4o', promptVersion: 'v1' },
    { role: 'verifier', model: 'openai/gpt-4o', promptVersion: 'v1' },
  ], PROD)
  assert.ok(same.some(x => /same model/.test(x)))

  const family = independenceViolations([
    { role: 'labeler', model: 'openai/gpt-4o', promptVersion: 'v1' },
    { role: 'verifier', model: 'openai/gpt-4o-mini', promptVersion: 'v1' },
  ], PROD)
  assert.ok(family.some(x => /^WARN same model family/.test(x)))

  assert.deepEqual(independenceViolations([
    { role: 'labeler', model: 'openai/gpt-4o', promptVersion: 'v1' },
    { role: 'verifier', model: 'google/gemini-2.5-flash', promptVersion: 'v1' },
  ], PROD), [])
})

// ── Pre-screen ──────────────────────────────────────────────────────────────

test('a prior human rejection is never revisited by automation', () => {
  const r = preScreen(entry({ reviewStatus: 'rejected' }), new Map())
  assert.equal(r.state, 'auto_rejected')
  assert.match(r.reasons[0], /never overrides/)
})

test('privacy, licence and duplicates are deterministic blockers', () => {
  assert.equal(preScreen(entry({ containsPeople: true }), new Map()).state, 'privacy_blocked')
  assert.equal(preScreen(entry({ downloadPermitted: false }), new Map()).state, 'license_blocked')
  const seen = new Map([['h1', 'other-id']])
  assert.equal(preScreen(entry({ sha256: 'h1' }), seen).state, 'duplicate')
})

// ── Deterministic validation ────────────────────────────────────────────────

test('inverted ranges, out-of-band confidence and empty inventory are caught', () => {
  assert.ok(validateProposal(proposal({ quantityRange: { min: 9, max: 2 } })).some(p => /min > max/.test(p)))
  assert.ok(validateProposal(proposal({ truckSpacePercent: { min: 0, max: 140 } })).some(p => /above 100/.test(p)))
  assert.ok(validateProposal(proposal({ fieldConfidence: { volume: 1.4 } })).some(p => /outside 0\.\.1/.test(p)))
  assert.ok(validateProposal(proposal({ visibleItems: [] })).some(p => /no visible items/.test(p)))
})

test('a cubic-yard figure in the cubic-foot field is caught by the truck cross-check', () => {
  // 5 cu yd entered as "5 cu ft" against a truck-space of 13% — a 27x unit error.
  const bad = validateProposal(proposal({ volumeCubicFeet: { min: 4, max: 6 }, truckSpacePercent: { min: 12, max: 14 } }))
  assert.ok(bad.some(p => /volume and truck space disagree/.test(p)))
  assert.deepEqual(validateProposal(proposal()), [])
})

test('lane hygiene and pricing leakage are refused', () => {
  assert.ok(validateProposal(proposal({ lane: 'moving', ambiguityNotes: 'needs a landfill trip' }))
    .some(p => /disposal\/landfill/.test(p)))
  assert.ok(validateProposal(proposal({ ambiguityNotes: 'about $450 total' }))
    .some(p => /customer pricing/.test(p)))
})

// ── Consensus gate ──────────────────────────────────────────────────────────

test('a clean high-agreement case auto-verifies as SILVER, never Gold', () => {
  const d = decide(input())
  assert.equal(d.state, 'auto_verified')
  assert.equal(d.tier, 'silver', 'machine consensus can never mint Gold')
})

test('any critical disagreement sends the case to a human', () => {
  for (const code of ['wrong_lane', 'volume_implausible', 'confidence_too_high'] as const) {
    const d = decide(input({ verifier: { verdict: 'approve', disagreements: [code], confidence: 0.98 } }))
    assert.equal(d.state, 'needs_human_review', code)
  }
})

test('privacy and licence risk are never traded against confidence', () => {
  assert.equal(decide(input({
    classifier: { operational: true, lane: 'junk_removal', category: 'c', privacyRisk: true, licenseRisk: false, confidence: 0.99 },
  })).state, 'privacy_blocked')
  assert.equal(decide(input({
    verifier: { verdict: 'approve', disagreements: ['license_risk'], confidence: 0.99 },
  })).state, 'license_blocked')
})

test('confidence below the auto-verify threshold cannot auto-verify', () => {
  const d = decide(input({
    classifier: { operational: true, lane: 'junk_removal', category: 'c', privacyRisk: false, licenseRisk: false, confidence: 0.85 },
  }))
  assert.equal(d.state, 'needs_human_review')
  assert.ok(d.confidence < THRESHOLDS.autoVerifyConfidence)
})

test('deterministic failure outranks model agreement', () => {
  const d = decide(input({ label: proposal({ truckSpacePercent: { min: 0, max: 300 } }) }))
  assert.equal(d.state, 'needs_human_review')
  assert.ok(d.deterministicProblems.length > 0)
})

test('materially disjoint verifier ranges block auto-verification', () => {
  const d = decide(input({ verifierLabel: proposal({ volumeCubicFeet: { min: 600, max: 900 } }) }))
  assert.equal(d.state, 'needs_human_review')
  assert.match(d.reason, /overlap/)
  assert.equal(rangeOverlap({ min: 0, max: 10 }, { min: 20, max: 30 }), 0)
  assert.equal(rangeOverlap({ min: 0, max: 10 }, { min: 0, max: 10 }), 1)
})

test('every decision lands on a declared terminal state', () => {
  const cases = [input(), input({ preScreen: { state: 'duplicate', reasons: ['dup'] } })]
  for (const c of cases) assert.ok(TERMINAL_STATES.includes(decide(c).state))
})

// ── Gold / Silver ───────────────────────────────────────────────────────────

test('Gold requires a human; machine consensus stays Silver', () => {
  assert.equal(tierOf(entry({ labelStatus: 'verified', reviewStatus: 'approved' })), 'gold')
  assert.equal(tierOf({ ...entry(), curationTier: 'silver' } as never), 'silver')
  assert.equal(tierOf(entry()), 'candidate')
})

test('Silver cannot support a volume or calibration claim', () => {
  assert.equal(tierSupportsClaim('silver', 'coverage'), true)
  assert.equal(tierSupportsClaim('silver', 'volume accuracy'), false)
  assert.throws(() => assertClaimSupported('silver', 'catalog-disagreement calibration'), /correlated bias/)
  assert.doesNotThrow(() => assertClaimSupported('gold', 'volume accuracy'))
})

test('the tier report separates Gold and Silver and offers no combined total', () => {
  const rows = [
    entry({ id: 'g1', labelStatus: 'verified', reviewStatus: 'approved', split: 'development' }),
    entry({ id: 'g2', labelStatus: 'verified', reviewStatus: 'approved', split: 'holdout' }),
    { ...entry({ id: 's1' }), curationTier: 'silver' },
  ] as never
  const r = tierReport(rows, 'junk_removal')
  assert.equal(r.goldDevelopment.count, 1)
  assert.equal(r.goldHoldout.count, 1)
  assert.equal(r.silverDevelopment.count, 1)
  assert.equal((r as Record<string, unknown>).combined, undefined, 'no combined field may exist')
  assert.match(r.note, /never be summed/)
})

// ── Cost control ────────────────────────────────────────────────────────────

test('cost is two calls per candidate, with the adjudicator only on disagreement', () => {
  const base = estimateCost({
    candidates: 20, labelerModel: 'openai/gpt-4o', verifierModel: 'google/gemini-2.5-flash',
    usdPerCall: { 'openai/gpt-4o': 0.02, 'google/gemini-2.5-flash': 0.005, 'anthropic/claude-opus-4-8': 0.1 },
    ceilingUsd: 5,
  })
  assert.equal(base.calls, 40)
  assert.equal(base.withinCeiling, true)

  const withAdj = estimateCost({
    candidates: 20, labelerModel: 'openai/gpt-4o', verifierModel: 'google/gemini-2.5-flash',
    adjudicatorModel: 'anthropic/claude-opus-4-8', expectedDisagreementRate: 0.25,
    usdPerCall: { 'openai/gpt-4o': 0.02, 'google/gemini-2.5-flash': 0.005, 'anthropic/claude-opus-4-8': 0.1 },
    ceilingUsd: 5,
  })
  assert.equal(withAdj.calls, 45, 'adjudicator runs on 25% of cases, not all of them')

  const overCeiling = estimateCost({
    candidates: 1000, labelerModel: 'openai/gpt-4o', verifierModel: 'google/gemini-2.5-flash',
    usdPerCall: { 'openai/gpt-4o': 0.02, 'google/gemini-2.5-flash': 0.005 }, ceilingUsd: 5,
  })
  assert.equal(overCeiling.withinCeiling, false)
})

test('cache key changes with image, model, prompt or schema — and retries are bounded', () => {
  const k = { imageSha256: 'a', model: 'm', promptVersion: 'p1', schemaVersion: 1 }
  assert.notEqual(cacheKey(k), cacheKey({ ...k, promptVersion: 'p2' }))
  assert.notEqual(cacheKey(k), cacheKey({ ...k, schemaVersion: 2 }))
  assert.equal(cacheKey(k), cacheKey({ ...k }))
  assert.equal(isRetryable('rate_limit'), true)
  for (const fatal of ['credit_exhausted', 'auth', 'license']) assert.equal(isRetryable(fatal), false, fatal)
})

// ── Provenance ──────────────────────────────────────────────────────────────

test('provenance is append-only and never edits an earlier revision', () => {
  const base: Omit<LabelProvenance, 'revision'> = {
    sourceImageId: 'e1', sourceUrl: 'u', license: 'cc0',
    roles: [{ role: 'labeler', model: 'openai/gpt-4o', promptVersion: 'v1' }],
    schemaVersion: 1, catalogVersion: 1, createdAt: '2026-08-05T00:00:00Z',
    confidence: { overall: 0.9 }, disagreements: [], deterministicProblems: [],
    state: 'auto_verified', decisionReason: 'consensus', tier: 'silver', humanReviewed: false,
  }
  const h1 = appendRevision([], base)
  const h2 = appendRevision(h1, { ...base, state: 'needs_human_review', humanReviewed: true, humanReviewerId: 'owner' })
  assert.deepEqual(h1.map(r => r.revision), [1])
  assert.deepEqual(h2.map(r => r.revision), [1, 2])
  assert.equal(h2[0].state, 'auto_verified', 'revision 1 is unchanged')
  assert.equal(h1.length, 1, 'the input array was not mutated')
})
