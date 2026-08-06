// Curation runtime — transport seam, cache, retry, checkpoint and the pipeline.
// The transport is injected, so every rule here is exercised without a network,
// a credential or a cent of spend, on the SAME code path the paid pilot uses.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  callRole, classifyFailure, runCandidate, memoryCache, memoryCheckpoint,
  CallFailure, type VisionCaller, type VisionRequest,
} from '../tools/vision-benchmark/curation/runtime'
import { parseClassifier, parseLabel, parseVerifier, SchemaError, PROMPTS, ALLOWED_CATEGORIES, SCHEMA_VERSION, type LabelResponse } from '../tools/vision-benchmark/curation/contract'
import { decide, truckSpaceConsistent, validateProposal, type LabelProposal } from '../tools/vision-benchmark/curation/consensus'
import { DEFAULT_ROLES, PRODUCTION_ESTIMATOR } from '../tools/vision-benchmark/curation/roles'
import type { ManifestEntry } from '../tools/vision-benchmark/schema'

const OK_CLASSIFIER = JSON.stringify({
  operational: true, lane: 'junk_removal', category: 'curbside_pile',
  privacyRisk: false, licenseRisk: false, confidence: 0.95,
})
const OK_LABEL = JSON.stringify({
  lane: 'junk_removal', category: 'couch_sectional', visibleItems: ['sofa'],
  quantityRange: { min: 1, max: 2 }, handlingFlags: [], hazardousIndicators: [],
  crewRange: { min: 2, max: 2 }, laborHoursRange: { min: 1, max: 2 },
  difficulty: 'normal', ambiguityNotes: '', fieldConfidence: { volume: 0.9 },
  evidence: { visibleEvidence: ['sofa at kerb'], missingInformation: [], ambiguityFlags: [] },
  itemBreakdown: [{ item: 'sofa', quantity: 2, lengthFt: 6, widthFt: 3, heightFt: 3 }],
})
const OK_VERIFIER = JSON.stringify({ verdict: 'approve', disagreements: [], confidence: 0.95 })

const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  id: 'e1', jobType: 'junk_removal', category: 'curbside_pile', sourcePageUrl: 'u',
  sourceImageUrl: '', sourceDomain: 'x.org', license: 'cc0', licenseVerified: true,
  downloadPermitted: true, searchQuery: '', expectedObjects: [], expectedQuantityRange: null,
  expectedVolumeRangeCubicYards: null, expectedTruckSpaceRangePercent: null,
  expectedHandlingFlags: [], lighting: null, clutter: null, imageQuality: 'high',
  containsPeople: false, reviewStatus: 'pending', notes: '', storedPath: 'a.jpg', sha256: 'h1',
  phash: '', widthPx: 1600, heightPx: 1200, bytes: 1, attribution: '', fetchedAt: '',
  split: 'development', labelStatus: 'unlabelled', expectedCrewRange: null,
  expectedLaborHoursRange: null, disposalFlags: [], accessConcerns: [],
  labelConfidence: null, difficulty: null, ...over,
} as ManifestEntry)

/** A scripted transport: one canned reply per role, plus a call log. */
function scripted(replies: Partial<Record<string, string>>, opts: { throwOn?: string; kind?: string } = {}) {
  const calls: VisionRequest[] = []
  const caller: VisionCaller = async (req) => {
    calls.push(req)
    const role = req.promptVersion.split('.')[1]
    if (opts.throwOn === role) throw new CallFailure((opts.kind ?? 'unknown') as never, `simulated ${opts.kind}`)
    const text = replies[role]
    if (text === undefined) throw new CallFailure('unknown', `no scripted reply for ${role}`)
    return { text, inputTokens: 100, outputTokens: 50, latencyMs: 10, usd: 0.01 }
  }
  return { caller, calls }
}

const proposal = (over: Partial<LabelProposal> = {}): LabelProposal => ({
  lane: 'junk_removal', category: 'couch_sectional', visibleItems: ['sofa'],
  quantityRange: { min: 1, max: 2 }, volumeCubicFeet: { min: 90, max: 150 },
  truckSpacePercent: { min: 9, max: 15 }, handlingFlags: [], hazardousIndicators: [],
  crewRange: { min: 2, max: 2 }, laborHoursRange: { min: 1, max: 2 },
  difficulty: 'normal', ambiguityNotes: '', fieldConfidence: { volume: 0.9 },
  itemBreakdown: [{ item: 'sofa', quantity: 2, lengthFt: 7, widthFt: 3, heightFt: 3, cubicFeet: 126 }],
  ...over,
})

const ctx = (caller: VisionCaller, cache = memoryCache()) => ({ caller, cache })
const opts = { imageRoot: '/tmp', now: '2026-08-05T00:00:00Z' }

// ── contract ────────────────────────────────────────────────────────────────

test('strict parsing rejects malformed responses instead of coercing them', () => {
  assert.throws(() => parseClassifier('not json'), SchemaError)
  assert.throws(() => parseClassifier('{"lane":"banana","operational":true,"privacyRisk":false,"licenseRisk":false,"confidence":0.9}'), SchemaError)
  assert.throws(() => parseVerifier('{"verdict":"approve","disagreements":["made_up_code"],"confidence":0.9}'), /unknown disagreement codes/)
  assert.throws(() => parseVerifier('{"verdict":"approve","disagreements":[],"confidence":5}'), /outside 0\.\.1/)
  assert.doesNotThrow(() => parseLabel(OK_LABEL))
})

test('a label carrying freeform reasoning is refused by contract', () => {
  const withProse = JSON.stringify({ ...JSON.parse(OK_LABEL), reasoning: 'I think because...' })
  assert.throws(() => parseLabel(withProse), /forbids it/)
})

// ── retry rules ─────────────────────────────────────────────────────────────

test('only transient failures retry; auth, credit and licence never do', () => {
  assert.equal(classifyFailure('Request timed out'), 'timeout')
  assert.equal(classifyFailure('429 too many requests'), 'rate_limit')
  assert.equal(classifyFailure('401 unauthorized'), 'auth')
  assert.equal(classifyFailure('insufficient funds / billing'), 'credit_exhausted')
  assert.equal(classifyFailure('licence not permitted'), 'license')
  assert.equal(classifyFailure('something odd'), 'unknown', 'unknown must NOT be retried')
})

test('a transient failure retries and a credit failure aborts on the first attempt', async () => {
  let attempts = 0
  const flaky: VisionCaller = async () => {
    attempts++
    if (attempts < 3) throw new CallFailure('rate_limit', '429')
    return { text: OK_VERIFIER, inputTokens: 1, outputTokens: 1, latencyMs: 1, usd: 0.01 }
  }
  const r = await callRole(ctx(flaky), { model: 'm', promptVersion: 'curation.verifier.v1', system: 's', user: 'u', imagePath: 'p' }, 'h1')
  assert.equal(attempts, 3)
  assert.equal(r.cached, false)

  let creditAttempts = 0
  const broke: VisionCaller = async () => { creditAttempts++; throw new CallFailure('credit_exhausted', 'billing') }
  await assert.rejects(
    () => callRole(ctx(broke), { model: 'm', promptVersion: 'curation.verifier.v1', system: 's', user: 'u', imagePath: 'p' }, 'h2'),
    /billing/,
  )
  assert.equal(creditAttempts, 1, 'a credit failure must not be retried')
})

// ── cache ───────────────────────────────────────────────────────────────────

test('a cache hit never repeats the paid call, and the key covers what matters', async () => {
  const cache = memoryCache()
  let calls = 0
  const caller: VisionCaller = async () => { calls++; return { text: OK_VERIFIER, inputTokens: 1, outputTokens: 1, latencyMs: 1, usd: 0.01 } }
  const req = { model: 'm', promptVersion: 'curation.verifier.v1' as const, system: 's', user: 'u', imagePath: 'p' }
  const a = await callRole(ctx(caller, cache), req, 'hashA')
  const b = await callRole(ctx(caller, cache), req, 'hashA')
  assert.equal(calls, 1)
  assert.equal(b.cached, true)
  assert.equal(b.usd, 0, 'a cached call costs nothing')

  await callRole(ctx(caller, cache), req, 'hashB')          // different image
  await callRole(ctx(caller, cache), { ...req, model: 'other' }, 'hashA')  // different model
  assert.equal(calls, 3)
})

// ── checkpoint ──────────────────────────────────────────────────────────────

test('checkpoint marks completion so a resumed run skips finished candidates', () => {
  const cp = memoryCheckpoint(['done-1'])
  assert.equal(cp.done('done-1'), true)
  assert.equal(cp.done('fresh'), false)
  cp.record('fresh', 'auto_verified')
  assert.equal(cp.done('fresh'), true)
})

// ── pipeline ────────────────────────────────────────────────────────────────

test('a clean candidate runs classifier→labeler→verifier and auto-verifies as Silver', async () => {
  const s = scripted({ classifier: OK_CLASSIFIER, labeler: OK_LABEL, verifier: OK_VERIFIER })
  const out = await runCandidate(entry(), ctx(s.caller), opts, new Map())
  assert.equal(out.decision.state, 'auto_verified')
  assert.equal(out.decision.tier, 'silver')
  assert.equal(out.adjudicated, false, 'no disagreement means no adjudicator call')
  assert.equal(s.calls.length, 3)
  assert.deepEqual(s.calls.map(c => c.promptVersion),
    ['curation.classifier.v1', 'curation.labeler.v1', 'curation.verifier.v1'])
})

test('the verifier never receives the labeler reasoning or evidence block', async () => {
  const s = scripted({ classifier: OK_CLASSIFIER, labeler: OK_LABEL, verifier: OK_VERIFIER })
  await runCandidate(entry(), ctx(s.caller), opts, new Map())
  const verifierCall = s.calls.find(c => c.promptVersion === 'curation.verifier.v1')!
  assert.ok(verifierCall.user.includes('proposed label'))
  assert.equal(verifierCall.user.includes('visibleEvidence'), false, 'evidence must be stripped')
  assert.equal(verifierCall.user.includes('sofa at kerb'), false)
  assert.ok(verifierCall.system.includes('no access to the labeller'))
})

test('the adjudicator runs ONLY on disagreement', async () => {
  const disagree = JSON.stringify({ verdict: 'revise', disagreements: ['quantity_overstated'], confidence: 0.7 })
  const s = scripted({
    classifier: OK_CLASSIFIER, labeler: OK_LABEL, verifier: disagree,
    adjudicator: JSON.stringify({ verdict: 'reject', disagreements: ['quantity_overstated'], confidence: 0.8 }),
  })
  const out = await runCandidate(entry(), ctx(s.caller), opts, new Map())
  assert.equal(out.adjudicated, true)
  assert.equal(s.calls.length, 4)
  assert.equal(out.decision.state, 'needs_human_review', 'a resolved disagreement still goes to a human')
})

test('deterministic pre-screen blocks before any paid call is made', async () => {
  const s = scripted({})
  for (const [e, expected] of [
    [entry({ reviewStatus: 'rejected' }), 'auto_rejected'],
    [entry({ containsPeople: true }), 'privacy_blocked'],
    [entry({ downloadPermitted: false }), 'license_blocked'],
  ] as const) {
    const out = await runCandidate(e, ctx(s.caller), opts, new Map())
    assert.equal(out.decision.state, expected)
  }
  assert.equal(s.calls.length, 0, 'an unusable image must never reach a paid call')
  assert.equal(await (async () => (await runCandidate(entry({ sha256: 'dup' }), ctx(s.caller), opts,
    new Map([['dup', 'other']]))).decision.state)(), 'duplicate')
})

test('a schema failure is terminal for the candidate and never auto-verifies', async () => {
  const s = scripted({ classifier: OK_CLASSIFIER, labeler: '{"lane":"banana"}' })
  const out = await runCandidate(entry(), ctx(s.caller), opts, new Map())
  assert.equal(out.decision.state, 'needs_human_review')
  assert.equal(out.failure?.kind, 'schema')
  assert.notEqual(out.decision.tier, 'gold')
})

test('a missing model fails closed rather than falling back to the estimator', async () => {
  const s = scripted({ classifier: OK_CLASSIFIER })
  await assert.rejects(
    () => runCandidate(entry(), ctx(s.caller), { ...opts, roles: [] }, new Map()),
    /refusing to run|no model assigned/,
  )
})

test('a role assigned to the production estimator aborts the run', async () => {
  const poisoned = DEFAULT_ROLES.map(r => r.role === 'labeler' ? { ...r, model: PRODUCTION_ESTIMATOR } : r)
  const s = scripted({ classifier: OK_CLASSIFIER })
  await assert.rejects(
    () => runCandidate(entry(), ctx(s.caller), { ...opts, roles: poisoned }, new Map()),
    /refusing to run/,
  )
  assert.equal(s.calls.length, 0, 'independence is asserted before the first call')
})

test('no pipeline path can emit a Gold label', async () => {
  const variants = [
    { classifier: OK_CLASSIFIER, labeler: OK_LABEL, verifier: OK_VERIFIER },
    { classifier: OK_CLASSIFIER, labeler: OK_LABEL, verifier: JSON.stringify({ verdict: 'approve', disagreements: [], confidence: 0.99 }) },
  ]
  for (const v of variants) {
    const out = await runCandidate(entry(), ctx(scripted(v).caller), opts, new Map())
    assert.notEqual(out.decision.tier, 'gold')
  }
})

test('provenance records the decision and never carries model reasoning', async () => {
  const s = scripted({ classifier: OK_CLASSIFIER, labeler: OK_LABEL, verifier: OK_VERIFIER })
  const out = await runCandidate(entry(), ctx(s.caller), opts, new Map())
  const p = out.provenance[0]
  assert.equal(p.revision, 1)
  assert.equal(p.humanReviewed, false)
  // v2 = controlled category enum + structural itemBreakdown derivation.
  assert.equal(p.schemaVersion, SCHEMA_VERSION)
  assert.equal(SCHEMA_VERSION, 3)
  assert.equal(p.tier, 'silver')
  assert.ok(p.roles.length >= 2)
  assert.equal(JSON.stringify(p).includes('reasoning'), false)
})

// ── RC2 calibration fixes (13-image diagnostic, 2026-08-05) ─────────────────
// The diagnostic measured the labeler's volume→truck-space arithmetic exact on
// 13/13 while the verifier called it inconsistent on 10/13, because only the
// labeler prompt carried the 1,000 cu ft constant.

test('the truck rule is stated to the verifier and the adjudicator, not just the labeler', () => {
  for (const v of ['curation.labeler.v1', 'curation.verifier.v1', 'curation.adjudicator.v1'] as const) {
    assert.match(PROMPTS[v], /1,000 cubic feet/, `${v} must carry the truck constant`)
  }
  assert.match(PROMPTS['curation.verifier.v1'], /never merely because you would have estimated a different volume/)
})

test('truck-space arithmetic is verified in code, across the documented examples', () => {
  const at = (cuft: number, pct: number) => proposal({
    volumeCubicFeet: { min: cuft, max: cuft }, truckSpacePercent: { min: pct, max: pct },
  })
  for (const [cuft, pct] of [[100, 10], [500, 50], [900, 90]] as const) {
    assert.equal(truckSpaceConsistent(at(cuft, pct)), true, `${cuft} cu ft = ${pct}%`)
  }
  assert.equal(truckSpaceConsistent(at(100, 45)), false, 'a genuine mismatch must still fail')
  assert.equal(truckSpaceConsistent(at(80, 9)), true, 'small rounding stays within tolerance')
  // Saturated ranges cannot express a multi-load job, so they are not "inconsistent".
  assert.equal(truckSpaceConsistent(proposal({
    volumeCubicFeet: { min: 7000, max: 8000 }, truckSpacePercent: { min: 100, max: 100 },
  })), true)
})

test('a false truck_space_inconsistent no longer blocks auto-verification', () => {
  // 90-110 cu ft ⇒ ~10%: exact. The verifier raises the code anyway, as it did
  // on 10 of 13 real images.
  const label = proposal({
    volumeCubicFeet: { min: 90, max: 110 }, truckSpacePercent: { min: 9, max: 11 },
  })
  const d = decide({
    preScreen: { state: null, reasons: [] },
    classifier: { operational: true, lane: 'junk_removal', category: 'curbside_pile', privacyRisk: false, licenseRisk: false, confidence: 0.95 },
    label,
    verifier: { verdict: 'approve', disagreements: ['truck_space_inconsistent'], confidence: 0.95 },
  })
  assert.equal(d.state, 'auto_verified')
  assert.equal(d.tier, 'silver')
  assert.equal(d.criticalDisagreements.includes('truck_space_inconsistent'), false)
})

test('a REAL truck-space mismatch is still caught', () => {
  const d = decide({
    preScreen: { state: null, reasons: [] },
    classifier: { operational: true, lane: 'junk_removal', category: 'c', privacyRisk: false, licenseRisk: false, confidence: 0.95 },
    // 100 cu ft claimed as 45% — arithmetic genuinely wrong.
    label: proposal({ volumeCubicFeet: { min: 100, max: 100 }, truckSpacePercent: { min: 45, max: 45 } }),
    verifier: { verdict: 'approve', disagreements: ['truck_space_inconsistent'], confidence: 0.95 },
  })
  assert.equal(d.state, 'needs_human_review')
  assert.ok(d.criticalDisagreements.includes('truck_space_inconsistent'))
})

test('suppressing the false code does not swallow the verifier other disagreements', () => {
  const d = decide({
    preScreen: { state: null, reasons: [] },
    classifier: { operational: true, lane: 'junk_removal', category: 'c', privacyRisk: false, licenseRisk: false, confidence: 0.95 },
    label: proposal({ volumeCubicFeet: { min: 90, max: 110 }, truckSpacePercent: { min: 9, max: 11 } }),
    verifier: { verdict: 'approve', disagreements: ['truck_space_inconsistent', 'volume_implausible'], confidence: 0.95 },
  })
  assert.equal(d.state, 'needs_human_review')
  assert.ok(d.criticalDisagreements.includes('volume_implausible'))
})

test('no category hint reaches the labeler — it must infer from the image', async () => {
  // Schema v2 supplies the ALLOWED VOCABULARY (which necessarily contains the
  // word "category"); what must never appear is this entry's own category.
  const s = scripted({ classifier: OK_CLASSIFIER, labeler: OK_LABEL, verifier: OK_VERIFIER })
  await runCandidate(entry({ category: 'eviction_cleanout' }), ctx(s.caller), opts, new Map())
  const labelCall = s.calls.find(c => c.promptVersion === 'curation.labeler.v1')!
  // The enum necessarily contains every manifest category, including this
  // entry's own, so "absence" is the wrong property. What matters is that none
  // is SINGLED OUT: the whole vocabulary is offered and nothing points at one.
  assert.equal(/category hint|likely category|expected category/i.test(labelCall.user), false)
  assert.equal(ALLOWED_CATEGORIES.junk_removal.every(c => labelCall.user.includes(c)), true,
    'the full vocabulary must be supplied, so no single category is privileged')
  assert.match(labelCall.user, /^lane: /)
  assert.match(labelCall.system, /Infer the category yourself/)
})

test('the labeler contract demands derived volume, not a category anchor', () => {
  const p = PROMPTS['curation.labeler.v1']
  assert.match(p, /length x width x height/)
  assert.match(p, /WIDEN the range/)
  assert.match(p, /never fall back to a typical value/)
  assert.match(p, /should not produce identical ranges/)
})

// ── Schema v2: controlled categories + structural volume derivation ──────────
// The RC2 control run produced ten free-text categories across thirteen images
// and still returned one volume range for multiple different scenes. Prompting
// did not fix either, so both are now enforced by the contract.

const measured = (over: Partial<LabelResponse> = {}): string => JSON.stringify({
  lane: 'junk_removal', category: 'couch_sectional', visibleItems: ['sofa'],
  quantityRange: { min: 1, max: 1 }, handlingFlags: [], hazardousIndicators: [],
  crewRange: { min: 2, max: 2 }, laborHoursRange: { min: 1, max: 2 },
  difficulty: 'normal', ambiguityNotes: '', fieldConfidence: { volume: 0.8 },
  evidence: { visibleEvidence: ['sofa 7x3x3'], missingInformation: [], ambiguityFlags: [] },
  itemBreakdown: [{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3 }],
  ...over,
})

test('a category outside the manifest enum fails validation', () => {
  for (const bad of ['mixed_junk', 'garage_clutter', 'mixed household items', 'furniture_disposal']) {
    assert.throws(() => parseLabel(measured({ category: bad } as never)), /not in the junk_removal manifest enum/, bad)
  }
  assert.doesNotThrow(() => parseLabel(measured()))
  assert.ok(ALLOWED_CATEGORIES.junk_removal.includes('couch_sectional'))
  assert.equal(ALLOWED_CATEGORIES.junk_removal.includes('mixed_junk'), false)
})

test('a moving category cannot be used on the junk lane', () => {
  const movingCat = ALLOWED_CATEGORIES.moving[0]
  assert.throws(() => parseLabel(measured({ category: movingCat } as never)), /not in the junk_removal manifest enum/)
})

test('volume without an itemBreakdown is refused', () => {
  const noBreakdown = JSON.parse(measured()); delete noBreakdown.itemBreakdown
  assert.throws(() => parseLabel(JSON.stringify(noBreakdown)), /itemBreakdown is required/)
  // …and at the validation layer, for a proposal that reached it another way.
  assert.ok(validateProposal(proposal({ itemBreakdown: undefined }))
    .some(p => /without an itemBreakdown/.test(p)))
})

test('cubic-foot math must match the stated dimensions', () => {
  const wrong = validateProposal(proposal({
    volumeCubicFeet: { min: 60, max: 90 },
    itemBreakdown: [{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3, cubicFeet: 200 }],
  }))
  assert.ok(wrong.some(p => /does not match 1x7x3x3/.test(p)))
  const right = validateProposal(proposal({
    volumeCubicFeet: { min: 60, max: 90 },
    itemBreakdown: [{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3, cubicFeet: 63 }],
  }))
  assert.deepEqual(right, [])
})

test('a repeated anchor unsupported by the item evidence is rejected', () => {
  // The exact failure from the control run: {80,120} asserted over one small item.
  const anchored = validateProposal(proposal({
    volumeCubicFeet: { min: 80, max: 120 },
    itemBreakdown: [{ item: 'box', quantity: 2, lengthFt: 2, widthFt: 2, heightFt: 2, cubicFeet: 16 }],
  }))
  assert.ok(anchored.some(p => /is not supported by the itemBreakdown/.test(p)))
})

test('the same item type at different quantities must produce different volume', () => {
  const one = [{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3, cubicFeet: 63 }]
  const three = [{ item: 'sofa', quantity: 3, lengthFt: 7, widthFt: 3, heightFt: 3, cubicFeet: 189 }]
  assert.deepEqual(validateProposal(proposal({ volumeCubicFeet: { min: 55, max: 75 }, itemBreakdown: one })), [])
  assert.deepEqual(validateProposal(proposal({ volumeCubicFeet: { min: 170, max: 210 }, itemBreakdown: three })), [])
  // The one-item volume can no longer be reused for three items.
  assert.ok(validateProposal(proposal({ volumeCubicFeet: { min: 55, max: 75 }, itemBreakdown: three }))
    .some(p => /not supported by the itemBreakdown/.test(p)))
})

test('RC2 truck-space validation still holds under schema v2', () => {
  assert.equal(truckSpaceConsistent(proposal({
    volumeCubicFeet: { min: 100, max: 100 }, truckSpacePercent: { min: 10, max: 10 },
  })), true)
  assert.equal(truckSpaceConsistent(proposal({
    volumeCubicFeet: { min: 100, max: 100 }, truckSpacePercent: { min: 45, max: 45 },
  })), false)
})

test('the labeler is handed the allowed vocabulary, never the manifest category', async () => {
  const s = scripted({ classifier: OK_CLASSIFIER, labeler: measured(), verifier: OK_VERIFIER })
  await runCandidate(entry({ category: 'eviction_cleanout' }), ctx(s.caller), opts, new Map())
  const call = s.calls.find(c => c.promptVersion === 'curation.labeler.v1')!
  assert.equal(/category hint|likely category/i.test(call.user), false, 'no category may be privileged')
  assert.match(call.user, /allowed categories \(choose exactly one\)/)
  assert.ok(call.user.includes('couch_sectional'), 'the enum must be supplied')
  assert.ok(call.user.includes('eviction_cleanout'), '…as the FULL enum, not a filtered hint')
})

// ── Schema v3: item-first estimation, totals derived ────────────────────────
// v2 required a breakdown but still let the model state the total, so it chose a
// familiar total and back-fitted dimensions that summed to it — internally
// consistent, therefore invisible to a consistency check. Measured: {80,120}
// returned for four visually different scenes. v3 removes the total from the
// model's vocabulary entirely.

const itemFirst = (items: Array<Partial<{item:string;quantity:number;lengthFt:number;widthFt:number;heightFt:number}>>, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    lane: 'junk_removal', category: 'couch_sectional', visibleItems: items.map(i => i.item),
    quantityRange: { min: 1, max: 1 }, handlingFlags: [], hazardousIndicators: [],
    crewRange: { min: 2, max: 2 }, laborHoursRange: { min: 1, max: 2 },
    difficulty: 'normal', ambiguityNotes: '', fieldConfidence: { volume: 1 },
    evidence: { visibleEvidence: [], missingInformation: [], ambiguityFlags: [] },
    itemBreakdown: items, ...over,
  })

test('a model-supplied total volume is REFUSED, not quietly ignored', () => {
  const withTotal = itemFirst([{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3 }],
    { volumeCubicFeet: { min: 80, max: 120 } })
  assert.throws(() => parseLabel(withTotal), /volumeCubicFeet must not be supplied/)
  const withTruck = itemFirst([{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3 }],
    { truckSpacePercent: { min: 8, max: 12 } })
  assert.throws(() => parseLabel(withTruck), /truckSpacePercent must not be supplied/)
})

test('cubic feet and the scene total are computed from dimensions, not read', () => {
  const l = parseLabel(itemFirst([
    { item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3 },   // 63
    { item: 'box', quantity: 4, lengthFt: 2, widthFt: 2, heightFt: 2 },    // 32
  ]))
  assert.equal(l.itemBreakdown[0].cubicFeet, 63)
  assert.equal(l.itemBreakdown[1].cubicFeet, 32)
  // confidence 1 ⇒ ±15% around 95
  assert.deepEqual(l.volumeCubicFeet, { min: 80.8, max: 109.2 })
  assert.deepEqual(l.truckSpacePercent, { min: 8.1, max: 10.9 })
  assert.deepEqual(validateProposal(l), [], 'a derived label is self-consistent by construction')
})

test('identical totals cannot appear across different scenes unless the items justify it', () => {
  const small = parseLabel(itemFirst([{ item: 'chair', quantity: 2, lengthFt: 2, widthFt: 2, heightFt: 3 }]))   // 24
  const large = parseLabel(itemFirst([{ item: 'sectional', quantity: 1, lengthFt: 9, widthFt: 4, heightFt: 3 }])) // 108
  assert.notDeepEqual(small.volumeCubicFeet, large.volumeCubicFeet)
  // …and two scenes whose measurements DO match legitimately produce the same total.
  const twin = parseLabel(itemFirst([{ item: 'loveseat', quantity: 2, lengthFt: 2, widthFt: 2, heightFt: 3 }]))
  assert.deepEqual(twin.volumeCubicFeet, small.volumeCubicFeet)
})

test('the same item at different quantities cannot share a total', () => {
  const one = parseLabel(itemFirst([{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3 }]))
  const three = parseLabel(itemFirst([{ item: 'sofa', quantity: 3, lengthFt: 7, widthFt: 3, heightFt: 3 }]))
  assert.equal(three.volumeCubicFeet.min > one.volumeCubicFeet.max, true)
})

test('low volume confidence widens the derived range instead of moving it', () => {
  const sure = parseLabel(itemFirst([{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3 }]))
  const unsure = parseLabel(itemFirst([{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3 }],
    { fieldConfidence: { volume: 0.2 } }))
  const mid = (r: {min:number;max:number}) => (r.min + r.max) / 2
  assert.ok(Math.abs(mid(sure.volumeCubicFeet) - mid(unsure.volumeCubicFeet)) < 0.5, 'the centre is the measurement and must not move')
  assert.ok(unsure.volumeCubicFeet.max - unsure.volumeCubicFeet.min
    > sure.volumeCubicFeet.max - sure.volumeCubicFeet.min, 'uncertainty widens the band')
})

test('a missing item breakdown cannot reach Silver', () => {
  const noItems = JSON.parse(itemFirst([{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3 }]))
  delete noItems.itemBreakdown
  assert.throws(() => parseLabel(JSON.stringify(noItems)), /itemBreakdown is required/)
  // …and at the gate, for a proposal that arrived without one another way.
  const d = decide({
    preScreen: { state: null, reasons: [] },
    classifier: { operational: true, lane: 'junk_removal', category: 'couch_sectional', privacyRisk: false, licenseRisk: false, confidence: 0.99 },
    label: proposal({ itemBreakdown: undefined }),
    verifier: { verdict: 'approve', disagreements: [], confidence: 0.99 },
  })
  assert.notEqual(d.state, 'auto_verified')
  assert.notEqual(d.tier, 'silver')
})

test('zero or negative dimensions are refused', () => {
  assert.throws(() => parseLabel(itemFirst([{ item: 'x', quantity: 1, lengthFt: 0, widthFt: 3, heightFt: 3 }])), /lengthFt must be > 0/)
  assert.throws(() => parseLabel(itemFirst([{ item: 'x', quantity: 0, lengthFt: 2, widthFt: 3, heightFt: 3 }])), /quantity must be > 0/)
})

// ── Moving-photo ingestion (v3 probe: 8/10 content refusals) ────────────────
// A generic "analyse this photograph", pointed at somebody's bedroom, read as
// scrutiny of a private space. A moving estimator looking at the same picture is
// counting furniture for a truck. The framing changes; the privacy path does not.

const movingLabel = (over: Record<string, unknown> = {}) => JSON.stringify({
  lane: 'moving', category: ALLOWED_CATEGORIES.moving[0], visibleItems: ['bed', 'dresser'],
  quantityRange: { min: 2, max: 4 }, handlingFlags: [], hazardousIndicators: [],
  crewRange: { min: 2, max: 3 }, laborHoursRange: { min: 2, max: 4 },
  difficulty: 'normal', ambiguityNotes: '', fieldConfidence: { volume: 0.8 },
  evidence: { visibleEvidence: ['queen bed', '6-drawer dresser'], missingInformation: [], ambiguityFlags: [] },
  itemBreakdown: [
    { item: 'queen bed', quantity: 1, lengthFt: 6.5, widthFt: 5, heightFt: 2 },
    { item: 'dresser', quantity: 1, lengthFt: 5, widthFt: 2, heightFt: 3.5 },
  ],
  ...over,
})

const MOVING_CLASSIFIER = JSON.stringify({
  operational: true, lane: 'moving', category: 'bedroom_furniture',
  privacyRisk: false, licenseRisk: false, confidence: 0.92,
})

test('a normal bedroom furniture image is labelled through the moving prompt', async () => {
  const s = scripted({ classifier: MOVING_CLASSIFIER, labeler: movingLabel(), verifier: OK_VERIFIER })
  const out = await runCandidate(entry({ jobType: 'moving' }), ctx(s.caller), opts, new Map())
  const labelCall = s.calls.find(c => c.promptVersion === 'curation.labeler.moving.v1')
  assert.ok(labelCall, 'the moving lane must use the moving labeler prompt')
  assert.equal(out.decision.state, 'auto_verified')
  assert.equal(out.decision.tier, 'silver')
  assert.equal(out.label?.itemBreakdown.length, 2)
})

test('a living room furniture image runs the same path', async () => {
  const living = movingLabel({
    category: ALLOWED_CATEGORIES.moving.includes('living_room_furniture') ? 'living_room_furniture' : ALLOWED_CATEGORIES.moving[0],
    itemBreakdown: [
      { item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3 },
      { item: 'coffee table', quantity: 1, lengthFt: 4, widthFt: 2, heightFt: 1.5 },
      { item: 'armchair', quantity: 2, lengthFt: 3, widthFt: 3, heightFt: 3 },
    ],
  })
  const s = scripted({ classifier: MOVING_CLASSIFIER, labeler: living, verifier: OK_VERIFIER })
  const out = await runCandidate(entry({ jobType: 'moving' }), ctx(s.caller), opts, new Map())
  assert.equal(out.decision.state, 'auto_verified')
  assert.equal(out.label?.itemBreakdown.length, 3)
})

test('the junk lane keeps its own prompt — the framing is lane-specific', async () => {
  const s = scripted({ classifier: OK_CLASSIFIER, labeler: OK_LABEL, verifier: OK_VERIFIER })
  await runCandidate(entry(), ctx(s.caller), opts, new Map())
  assert.ok(s.calls.some(c => c.promptVersion === 'curation.labeler.v1'))
  assert.equal(s.calls.some(c => c.promptVersion === 'curation.labeler.moving.v1'), false)
})

test('the moving prompt narrows what the labeler LOOKS AT, not what the pipeline detects', () => {
  const p = PROMPTS['curation.labeler.moving.v1']
  assert.match(p, /professional moving estimator/)
  assert.match(p, /Do NOT describe people, documents, screens, photographs or personal effects/)
  assert.match(p, /another system handles that separately/)
  // The classifier still carries the whole privacy duty.
  assert.match(PROMPTS['curation.classifier.v1'], /identifiable people, readable documents, addresses or licence plates/)
})

test('a privacy signal still blocks a moving image, and a human decides', async () => {
  const privacyClassifier = JSON.stringify({
    operational: true, lane: 'moving', category: 'bedroom_furniture',
    privacyRisk: true, licenseRisk: false, confidence: 0.95,
  })
  const s = scripted({ classifier: privacyClassifier, labeler: movingLabel(), verifier: OK_VERIFIER })
  const out = await runCandidate(entry({ jobType: 'moving' }), ctx(s.caller), opts, new Map())
  assert.equal(out.decision.state, 'privacy_blocked')
  assert.notEqual(out.decision.tier, 'silver')
  assert.match(out.decision.reason, /a human decides, never automation/)
})

test('a manifest privacy mark blocks a moving image before any paid call', async () => {
  const s = scripted({ classifier: MOVING_CLASSIFIER, labeler: movingLabel(), verifier: OK_VERIFIER })
  const out = await runCandidate(entry({ jobType: 'moving', containsPeople: true }), ctx(s.caller), opts, new Map())
  assert.equal(out.decision.state, 'privacy_blocked')
  assert.equal(s.calls.length, 0, 'privacy is decided before spending')
})

test('a verifier privacy_risk still blocks, even on an otherwise clean moving label', async () => {
  const s = scripted({
    classifier: MOVING_CLASSIFIER, labeler: movingLabel(),
    verifier: JSON.stringify({ verdict: 'approve', disagreements: ['privacy_risk'], confidence: 0.99 }),
    adjudicator: JSON.stringify({ verdict: 'approve', disagreements: ['privacy_risk'], confidence: 0.99 }),
  })
  const out = await runCandidate(entry({ jobType: 'moving' }), ctx(s.caller), opts, new Map())
  assert.equal(out.decision.state, 'privacy_blocked')
})
