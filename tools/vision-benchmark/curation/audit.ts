// ─────────────────────────────────────────────────────────────────────────────
// Blind audit.
//
// Four measured iterations closed every defect a schema can close. What remains
// is two independent model families disagreeing about how many objects are in a
// photograph — quantity_understated on 10 of 13 in v3 — and no further prompt or
// contract change can adjudicate that. A person has to look.
//
// BLIND means the reviewer forms their own answer before seeing any machine
// opinion. `blindPacket()` therefore REMOVES, rather than merely omits:
//   • consensus and per-field confidence
//   • verifier verdict and disagreement codes
//   • adjudication, terminal state and tier
//   • deterministic problems and evidence prose
// What survives is the image, the proposed structured label, and the source.
// Anything that leaks a machine's degree of belief would anchor the human the
// same way a familiar total anchored the labeler.
// ─────────────────────────────────────────────────────────────────────────────

import type { ItemMeasurementLike, LabelProposal } from './consensus'
import type { CurationState } from './types'

/** One pilot outcome, as recorded by the curation route. */
export type AuditCandidate = {
  file: string
  id?: string
  group?: string
  state: CurationState
  tier?: string
  label?: LabelProposal | null
  verifier?: { verdict: string; disagreements: string[]; confidence: number } | null
  classifier?: { lane: string; category: string | null; confidence: number } | null
  confidence?: number
  adjudicated?: boolean
  reason?: string
  lane?: 'junk_removal' | 'moving'
}

export const AUDIT_TARGET = { autoVerifiedPerLane: 3, autoRejected: 3 } as const

export type AuditSample = {
  autoVerifiedJunk: AuditCandidate[]
  autoVerifiedMoving: AuditCandidate[]
  autoRejected: AuditCandidate[]
  shortfall: string[]
}

const laneOf = (c: AuditCandidate): string =>
  c.lane ?? c.label?.lane ?? c.classifier?.lane ?? 'unknown'

/**
 * Select the sample. Deterministic given the same input — a random sample that
 * cannot be reproduced makes a precision number impossible to re-check.
 * Shortfalls are REPORTED, never quietly padded from another bucket.
 */
export function buildAuditSample(candidates: AuditCandidate[]): AuditSample {
  const pick = (pred: (c: AuditCandidate) => boolean, n: number) =>
    candidates.filter(pred).sort((a, b) => a.file.localeCompare(b.file)).slice(0, n)

  const autoVerifiedJunk = pick(c => c.state === 'auto_verified' && laneOf(c) === 'junk_removal', AUDIT_TARGET.autoVerifiedPerLane)
  const autoVerifiedMoving = pick(c => c.state === 'auto_verified' && laneOf(c) === 'moving', AUDIT_TARGET.autoVerifiedPerLane)
  const autoRejected = pick(c => c.state === 'auto_rejected', AUDIT_TARGET.autoRejected)

  const shortfall: string[] = []
  const want = AUDIT_TARGET.autoVerifiedPerLane
  if (autoVerifiedJunk.length < want) shortfall.push(`auto-verified junk: ${autoVerifiedJunk.length}/${want}`)
  if (autoVerifiedMoving.length < want) shortfall.push(`auto-verified moving: ${autoVerifiedMoving.length}/${want}`)
  if (autoRejected.length < AUDIT_TARGET.autoRejected) shortfall.push(`auto-rejected: ${autoRejected.length}/${AUDIT_TARGET.autoRejected}`)
  return { autoVerifiedJunk, autoVerifiedMoving, autoRejected, shortfall }
}

/** What the reviewer is allowed to see. */
export type BlindPacket = {
  auditId: string
  file: string
  /** 'label' = a proposed label to judge; 'rejection' = a refusal to judge. */
  kind: 'label' | 'rejection'
  proposed: {
    lane?: string
    category?: string
    visibleItems?: string[]
    quantityRange?: { min: number; max: number }
    volumeCubicFeet?: { min: number; max: number }
    itemBreakdown?: ItemMeasurementLike[]
  } | null
  source: { license?: string; sourceUrl?: string }
}

/**
 * Redact to the blind view. Implemented as an ALLOWLIST: a denylist silently
 * leaks whatever field gets added next, and the whole value of this packet is
 * that the reviewer has not seen a machine's confidence.
 */
export function blindPacket(c: AuditCandidate, source: BlindPacket['source'] = {}): BlindPacket {
  const l = c.label
  return {
    auditId: c.id ?? c.file,
    file: c.file,
    kind: c.state === 'auto_rejected' ? 'rejection' : 'label',
    proposed: l
      ? {
          lane: l.lane,
          category: l.category,
          visibleItems: l.visibleItems,
          quantityRange: l.quantityRange,
          volumeCubicFeet: l.volumeCubicFeet,
          itemBreakdown: l.itemBreakdown,
        }
      : null,
    source,
  }
}

/** True when a packet carries anything the reviewer must not see. */
export function packetLeaks(p: BlindPacket): string[] {
  const banned = [
    'confidence', 'verdict', 'disagreement', 'adjudicat', 'reason',
    'state', 'tier', 'evidence', 'ambiguityNotes', 'fieldConfidence', 'deterministicProblems',
  ]
  const text = JSON.stringify(p).toLowerCase()
  return banned.filter(b => text.includes(b))
}

// ── the human's answer ──────────────────────────────────────────────────────

export type HumanAudit = {
  auditId: string
  reviewerId: string
  visibleItems: string[]
  quantity: { min: number; max: number }
  itemBreakdown?: ItemMeasurementLike[]
  volumeCubicFeet: { min: number; max: number }
  category: string
  /** approve = the proposal is sound; reject = it is not; unsure = cannot tell. */
  decision: 'approve' | 'reject' | 'unsure'
  notes?: string
}

export type Comparison = {
  auditId: string
  machineState: CurationState
  humanDecision: HumanAudit['decision']
  /** Did the human's volume range overlap the labeler's at all? */
  volumeOverlap: number
  categoryAgrees: boolean
  quantityOverlap: number
  /** The machine auto-verified something the human rejects. */
  falseApproval: boolean
  /** The machine auto-rejected something the human would approve. */
  falseRejection: boolean
  verifierWasRight: boolean | null
}

const overlap = (a: { min: number; max: number }, b: { min: number; max: number }): number => {
  const lo = Math.max(a.min, b.min), hi = Math.min(a.max, b.max)
  const widest = Math.max(a.max - a.min, b.max - b.min)
  if (widest === 0) return a.min === b.min ? 1 : 0
  return Math.max(0, hi - lo) / widest
}

export function compare(c: AuditCandidate, h: HumanAudit): Comparison {
  const l = c.label
  const volumeOverlap = l ? overlap(l.volumeCubicFeet, h.volumeCubicFeet) : 0
  const quantityOverlap = l ? overlap(l.quantityRange, h.quantity) : 0
  const verifierDisagreed = (c.verifier?.disagreements?.length ?? 0) > 0
  return {
    auditId: c.id ?? c.file,
    machineState: c.state,
    humanDecision: h.decision,
    volumeOverlap,
    categoryAgrees: !!l && l.category === h.category,
    quantityOverlap,
    falseApproval: c.state === 'auto_verified' && h.decision === 'reject',
    falseRejection: c.state === 'auto_rejected' && h.decision === 'approve',
    // Who was right when the two models disagreed: the verifier objected and the
    // human also rejects → the verifier was right to object.
    verifierWasRight: verifierDisagreed ? h.decision === 'reject' : null,
  }
}

export type PrecisionReport = {
  audited: number
  autoVerifiedAudited: number
  autoRejectedAudited: number
  /** auto-verified that the human approved / auto-verified audited. */
  labelerPrecision: number | null
  /** auto-rejected the human agrees with / auto-rejected audited. */
  rejectionPrecision: number | null
  /** of the cases where the verifier objected, how often the human agreed. */
  verifierPrecision: number | null
  falseApprovals: number
  falseRejections: number
  unsure: number
  disagreementCauses: Record<string, number>
  /** Empty only when every acceptance gate is met. */
  blockers: string[]
}

/**
 * Precision, with an explicit refusal to compute a rate from too small a sample.
 * A precision figure over two audited cases reads exactly like one over fifty.
 */
export function precisionReport(rows: Comparison[], sample: AuditSample, minPerBucket = 3): PrecisionReport {
  const av = rows.filter(r => r.machineState === 'auto_verified')
  const ar = rows.filter(r => r.machineState === 'auto_rejected')
  const rate = (n: number, d: number) => (d === 0 ? null : n / d)

  const verifierJudged = rows.filter(r => r.verifierWasRight !== null)
  const causes: Record<string, number> = {}
  for (const r of rows) {
    if (r.volumeOverlap < 0.5) causes.volume_disagreement = (causes.volume_disagreement ?? 0) + 1
    if (r.quantityOverlap < 0.5) causes.quantity_disagreement = (causes.quantity_disagreement ?? 0) + 1
    if (!r.categoryAgrees) causes.category_disagreement = (causes.category_disagreement ?? 0) + 1
  }

  const blockers: string[] = [...sample.shortfall]
  if (av.length < minPerBucket) blockers.push(`auto-verified precision needs ≥${minPerBucket} audited (have ${av.length})`)
  if (ar.length < minPerBucket) blockers.push(`auto-rejected precision needs ≥${minPerBucket} audited (have ${ar.length})`)

  return {
    audited: rows.length,
    autoVerifiedAudited: av.length,
    autoRejectedAudited: ar.length,
    labelerPrecision: av.length >= minPerBucket ? rate(av.filter(r => r.humanDecision === 'approve').length, av.length) : null,
    rejectionPrecision: ar.length >= minPerBucket ? rate(ar.filter(r => r.humanDecision === 'reject').length, ar.length) : null,
    verifierPrecision: verifierJudged.length >= minPerBucket
      ? rate(verifierJudged.filter(r => r.verifierWasRight).length, verifierJudged.length) : null,
    falseApprovals: rows.filter(r => r.falseApproval).length,
    falseRejections: rows.filter(r => r.falseRejection).length,
    unsure: rows.filter(r => r.humanDecision === 'unsure').length,
    disagreementCauses: causes,
    blockers,
  }
}

/** Gold promotion requires a completed audit with no blockers. Never automatic. */
export function auditClearsPromotion(report: PrecisionReport): boolean {
  return report.blockers.length === 0 && report.falseApprovals === 0
}
