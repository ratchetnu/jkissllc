// Blind audit infrastructure. Pure: no network, no clock, no model calls.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAuditSample, blindPacket, packetLeaks, compare, precisionReport,
  auditClearsPromotion, AUDIT_TARGET,
  type AuditCandidate, type HumanAudit,
} from '../tools/vision-benchmark/curation/audit'

const label = (over: Record<string, unknown> = {}) => ({
  lane: 'junk_removal', category: 'couch_sectional', visibleItems: ['sofa'],
  quantityRange: { min: 1, max: 2 }, volumeCubicFeet: { min: 60, max: 90 },
  truckSpacePercent: { min: 6, max: 9 }, handlingFlags: [], hazardousIndicators: [],
  crewRange: { min: 2, max: 2 }, laborHoursRange: { min: 1, max: 2 }, difficulty: 'normal',
  ambiguityNotes: 'could not see behind the pile', fieldConfidence: { volume: 0.9 },
  itemBreakdown: [{ item: 'sofa', quantity: 1, lengthFt: 7, widthFt: 3, heightFt: 3, cubicFeet: 63 }],
  ...over,
}) as never

const cand = (over: Partial<AuditCandidate> = {}): AuditCandidate => ({
  file: 'a.jpg', state: 'auto_verified', tier: 'silver', label: label(),
  verifier: { verdict: 'approve', disagreements: [], confidence: 0.95 },
  classifier: { lane: 'junk_removal', category: 'couch_sectional', confidence: 0.95 },
  confidence: 0.95, adjudicated: false, reason: 'consensus 0.95', ...over,
})

const human = (over: Partial<HumanAudit> = {}): HumanAudit => ({
  auditId: 'a.jpg', reviewerId: 'owner', visibleItems: ['sofa'],
  quantity: { min: 1, max: 2 }, volumeCubicFeet: { min: 60, max: 90 },
  category: 'couch_sectional', decision: 'approve', ...over,
})

// ── sample ──────────────────────────────────────────────────────────────────

test('the sample takes 3 auto-verified per lane and up to 3 auto-rejected', () => {
  const rows: AuditCandidate[] = [
    ...Array.from({ length: 5 }, (_, i) => cand({ file: `j${i}.jpg` })),
    ...Array.from({ length: 4 }, (_, i) => cand({ file: `m${i}.jpg`, label: label({ lane: 'moving', category: 'boxed_goods' }) })),
    ...Array.from({ length: 4 }, (_, i) => cand({ file: `r${i}.jpg`, state: 'auto_rejected', label: null })),
  ]
  const s = buildAuditSample(rows)
  assert.equal(s.autoVerifiedJunk.length, AUDIT_TARGET.autoVerifiedPerLane)
  assert.equal(s.autoVerifiedMoving.length, AUDIT_TARGET.autoVerifiedPerLane)
  assert.equal(s.autoRejected.length, AUDIT_TARGET.autoRejected)
  assert.deepEqual(s.shortfall, [])
})

test('a shortfall is reported, never padded from another bucket', () => {
  // The real v3 situation: one auto-verified junk, no moving lane run at all.
  const s = buildAuditSample([cand({ file: 'only.jpg' })])
  assert.equal(s.autoVerifiedJunk.length, 1)
  assert.equal(s.autoVerifiedMoving.length, 0)
  assert.ok(s.shortfall.some(x => /auto-verified junk: 1\/3/.test(x)))
  assert.ok(s.shortfall.some(x => /auto-verified moving: 0\/3/.test(x)))
  // A junk candidate must never be counted toward the moving bucket.
  assert.equal(s.autoVerifiedMoving.length, 0)
})

test('selection is deterministic so a precision figure can be re-checked', () => {
  const rows = Array.from({ length: 6 }, (_, i) => cand({ file: `f${i}.jpg` }))
  assert.deepEqual(
    buildAuditSample(rows).autoVerifiedJunk.map(c => c.file),
    buildAuditSample([...rows].reverse()).autoVerifiedJunk.map(c => c.file),
  )
})

// ── blindness ───────────────────────────────────────────────────────────────

test('the blind packet carries no machine opinion whatsoever', () => {
  const p = blindPacket(cand(), { license: 'cc0', sourceUrl: 'https://x' })
  assert.deepEqual(packetLeaks(p), [], 'no confidence, verdict, disagreement, state, tier or evidence')
  const text = JSON.stringify(p)
  assert.equal(text.includes('0.95'), false, 'consensus confidence must not appear')
  assert.equal(text.includes('approve'), false, 'the verifier verdict must not appear')
  assert.equal(text.includes('could not see behind the pile'), false, 'evidence prose must not appear')
  assert.equal(text.includes('silver'), false)
})

test('the packet still shows what the reviewer must judge', () => {
  const p = blindPacket(cand())
  assert.equal(p.kind, 'label')
  assert.equal(p.proposed?.category, 'couch_sectional')
  assert.deepEqual(p.proposed?.volumeCubicFeet, { min: 60, max: 90 })
  assert.equal(p.proposed?.itemBreakdown?.length, 1)
  assert.equal(blindPacket(cand({ state: 'auto_rejected', label: null })).kind, 'rejection')
})

test('redaction is an allowlist — a newly added machine field cannot leak', () => {
  const withNewField = cand()
  ;(withNewField as unknown as Record<string, unknown>).newMachineScore = 0.99
  ;(withNewField.label as unknown as Record<string, unknown>).internalRationale = 'because'
  const p = blindPacket(withNewField)
  const text = JSON.stringify(p)
  assert.equal(text.includes('newMachineScore'), false)
  assert.equal(text.includes('internalRationale'), false)
})

// ── comparison ──────────────────────────────────────────────────────────────

test('a false approval is flagged when the human rejects an auto-verified label', () => {
  const c = compare(cand(), human({ decision: 'reject' }))
  assert.equal(c.falseApproval, true)
  assert.equal(c.falseRejection, false)
})

test('a false rejection is flagged when the human approves an auto-rejected case', () => {
  const c = compare(cand({ state: 'auto_rejected' }), human({ decision: 'approve' }))
  assert.equal(c.falseRejection, true)
})

test('the human volume is compared to the labeler, not assumed to agree', () => {
  const agree = compare(cand(), human())
  assert.equal(agree.volumeOverlap, 1)
  const disagree = compare(cand(), human({ volumeCubicFeet: { min: 300, max: 400 } }))
  assert.equal(disagree.volumeOverlap, 0)
  assert.equal(disagree.categoryAgrees, true, 'category can agree while volume does not')
})

test('the verifier is scored only where it actually objected', () => {
  const objected = cand({ verifier: { verdict: 'revise', disagreements: ['quantity_understated'], confidence: 0.9 } })
  assert.equal(compare(objected, human({ decision: 'reject' })).verifierWasRight, true)
  assert.equal(compare(objected, human({ decision: 'approve' })).verifierWasRight, false)
  assert.equal(compare(cand(), human()).verifierWasRight, null, 'silent verifier is not scored')
})

// ── precision ───────────────────────────────────────────────────────────────

test('precision is REFUSED below the minimum sample and the blocker says why', () => {
  const rows = [compare(cand(), human())]
  const r = precisionReport(rows, buildAuditSample([cand()]))
  assert.equal(r.labelerPrecision, null, 'one audited case cannot yield a precision figure')
  assert.equal(r.rejectionPrecision, null)
  assert.ok(r.blockers.some(b => /auto-verified precision needs ≥3/.test(b)))
  assert.equal(auditClearsPromotion(r), false)
})

test('precision is computed once each bucket is deep enough', () => {
  const av = [
    compare(cand({ file: 'a.jpg' }), human({ decision: 'approve' })),
    compare(cand({ file: 'b.jpg' }), human({ decision: 'approve' })),
    compare(cand({ file: 'c.jpg' }), human({ decision: 'reject' })),
  ]
  const ar = ['d', 'e', 'f'].map(f =>
    compare(cand({ file: `${f}.jpg`, state: 'auto_rejected' }), human({ decision: 'reject' })))
  const sample = buildAuditSample([
    ...['a', 'b', 'c'].map(f => cand({ file: `${f}.jpg` })),
    ...['m1', 'm2', 'm3'].map(f => cand({ file: f, label: label({ lane: 'moving' }) })),
    ...['d', 'e', 'f'].map(f => cand({ file: `${f}.jpg`, state: 'auto_rejected', label: null })),
  ])
  const r = precisionReport([...av, ...ar], sample)
  assert.equal(r.labelerPrecision, 2 / 3)
  assert.equal(r.rejectionPrecision, 1)
  assert.equal(r.falseApprovals, 1)
  assert.deepEqual(r.blockers, [])
})

test('a single false approval blocks Gold promotion even at full sample', () => {
  const rows = [
    ...['a', 'b', 'c'].map(f => compare(cand({ file: f }), human({ decision: f === 'c' ? 'reject' : 'approve' }))),
    ...['d', 'e', 'f'].map(f => compare(cand({ file: f, state: 'auto_rejected' }), human({ decision: 'reject' }))),
  ]
  const sample = buildAuditSample([
    ...['a', 'b', 'c'].map(f => cand({ file: f })),
    ...['m1', 'm2', 'm3'].map(f => cand({ file: f, label: label({ lane: 'moving' }) })),
    ...['d', 'e', 'f'].map(f => cand({ file: f, state: 'auto_rejected', label: null })),
  ])
  const r = precisionReport(rows, sample)
  assert.equal(r.falseApprovals, 1)
  assert.equal(auditClearsPromotion(r), false, 'a false approval must block promotion')
})

test('disagreement causes are attributed, not just counted', () => {
  const rows = [
    compare(cand({ file: 'a' }), human({ volumeCubicFeet: { min: 500, max: 600 } })),
    compare(cand({ file: 'b' }), human({ category: 'mattress' })),
    compare(cand({ file: 'c' }), human({ quantity: { min: 20, max: 30 } })),
  ]
  const r = precisionReport(rows, buildAuditSample([]))
  assert.equal(r.disagreementCauses.volume_disagreement, 1)
  assert.equal(r.disagreementCauses.category_disagreement, 1)
  assert.equal(r.disagreementCauses.quantity_disagreement, 1)
})
