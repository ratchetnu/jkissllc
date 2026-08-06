// ─────────────────────────────────────────────────────────────────────────────
// Deterministic screening, validation and the consensus gate.
//
// Everything in this file is PURE: no network, no clock, no model calls. The
// model-facing roles produce structured proposals; this module decides what may
// be trusted. Keeping the decision deterministic is what makes the automation
// auditable — a reviewer can replay any verdict without re-running inference.
//
// The gate is deliberately hard to pass. Automation rate is not a goal in
// itself; a wrong auto-verified label is worse than a case sent to a human,
// because it enters the benchmark as truth and silently biases every later
// measurement.
// ─────────────────────────────────────────────────────────────────────────────

import {
  CRITICAL_CODES, type CurationState, type DisagreementCode, type DatasetTier,
} from './types'
import type { ManifestEntry } from '../schema'

// ── Deterministic pre-screen ────────────────────────────────────────────────
// Runs BEFORE any model call, so an image that can never be used costs nothing.

export type PreScreen = { state: CurationState | null; reasons: string[] }

/**
 * Licence, duplication and prior-human-decision checks from manifest data alone.
 * A null state means "no deterministic blocker — proceed to the model roles".
 */
export function preScreen(e: ManifestEntry, seenHashes: Map<string, string>): PreScreen {
  const reasons: string[] = []

  // A prior human rejection is permanent and is never revisited by automation.
  if (e.reviewStatus === 'rejected') {
    return { state: 'auto_rejected', reasons: ['prior human rejection — automation never overrides it'] }
  }
  if (e.downloadPermitted === false) return { state: 'license_blocked', reasons: ['downloadPermitted is false'] }
  if (!e.license) return { state: 'license_blocked', reasons: ['no licence recorded'] }
  if (e.containsPeople === true) {
    return { state: 'privacy_blocked', reasons: ['manifest records identifiable people'] }
  }
  if (e.sha256) {
    const owner = seenHashes.get(e.sha256)
    if (owner && owner !== e.id) return { state: 'duplicate', reasons: [`identical sha256 to ${owner}`] }
  }
  if ((e.widthPx ?? 0) > 0 && (e.widthPx ?? 0) < 640) {
    reasons.push('narrow image — volume may not be judgeable')
  }
  return { state: null, reasons }
}

// ── Model-role proposals ────────────────────────────────────────────────────
// Shapes only. Producing them is the model layer's job; trusting them is not.

export type ClassifierResult = {
  operational: boolean
  lane: 'junk_removal' | 'moving' | 'neither' | 'ambiguous'
  category: string | null
  privacyRisk: boolean
  licenseRisk: boolean
  confidence: number
}

/** One measured item. Mirrors contract.ItemMeasurement without importing it. */
export type ItemMeasurementLike = {
  item: string; quantity: number; lengthFt: number; widthFt: number; heightFt: number; cubicFeet: number
}

export type LabelProposal = {
  lane: 'junk_removal' | 'moving'
  category: string
  visibleItems: string[]
  quantityRange: { min: number; max: number }
  volumeCubicFeet: { min: number; max: number }
  truckSpacePercent: { min: number; max: number }
  handlingFlags: string[]
  hazardousIndicators: string[]
  crewRange: { min: number; max: number }
  laborHoursRange: { min: number; max: number }
  difficulty: string
  ambiguityNotes: string
  fieldConfidence: Record<string, number>
  /** Present from schema v2 on. Volume must follow from these. */
  itemBreakdown?: ItemMeasurementLike[]
}

export type VerifierResult = {
  verdict: 'approve' | 'reject' | 'revise' | 'uncertain'
  disagreements: DisagreementCode[]
  confidence: number
}

// ── Deterministic validation ────────────────────────────────────────────────

/** 24 ft box truck = 1,000 cu ft of loadable space (owner-confirmed). */
export const TRUCK_CUBIC_FEET = 1000

/**
 * Structural and physical checks the models do not get a vote on. Returns the
 * problems; empty means the proposal is internally coherent.
 */
export function validateProposal(p: LabelProposal): string[] {
  const problems: string[] = []
  const range = (r: { min: number; max: number }, name: string, lo = 0, hi = Infinity) => {
    if (!Number.isFinite(r?.min) || !Number.isFinite(r?.max)) { problems.push(`${name}: not a range`); return }
    if (r.min > r.max) problems.push(`${name}: min > max`)
    if (r.min < lo) problems.push(`${name}: below ${lo}`)
    if (r.max > hi) problems.push(`${name}: above ${hi}`)
  }
  range(p.quantityRange, 'quantityRange', 0)
  range(p.volumeCubicFeet, 'volumeCubicFeet', 0)
  range(p.truckSpacePercent, 'truckSpacePercent', 0, 100)
  range(p.crewRange, 'crewRange', 1, 8)
  range(p.laborHoursRange, 'laborHoursRange', 0, 40)

  for (const [k, v] of Object.entries(p.fieldConfidence ?? {})) {
    if (!(v >= 0 && v <= 1)) problems.push(`confidence ${k} outside 0..1`)
  }
  if (p.visibleItems?.length === 0) problems.push('no visible items recorded')

  // Volume must be DERIVED, not asserted. Prompting the model to estimate from
  // dimensions did not stop anchoring, so the arithmetic is checked here: a
  // reported range that does not bracket the sum of quantity x l x w x h is a
  // number that came from somewhere other than the image.
  if (p.itemBreakdown && p.itemBreakdown.length > 0) {
    const derived = p.itemBreakdown.reduce((s2, i) => s2 + i.quantity * i.lengthFt * i.widthFt * i.heightFt, 0)
    for (const [n, i] of p.itemBreakdown.entries()) {
      const own = i.quantity * i.lengthFt * i.widthFt * i.heightFt
      if (own > 0 && Math.abs(own - i.cubicFeet) / own > 0.15) {
        problems.push(`itemBreakdown[${n}] cubicFeet ${i.cubicFeet} does not match ${i.quantity}x${i.lengthFt}x${i.widthFt}x${i.heightFt} = ${own.toFixed(1)}`)
      }
    }
    const lo = p.volumeCubicFeet.min, hi = p.volumeCubicFeet.max
    if (derived > 0 && (derived < lo * 0.6 || derived > hi * 1.6)) {
      problems.push(`volumeCubicFeet ${lo}-${hi} is not supported by the itemBreakdown (dimensions sum to ${derived.toFixed(1)} cu ft)`)
    }
  } else if (p.volumeCubicFeet.max > 0) {
    problems.push('volume reported without an itemBreakdown to derive it from')
  }

  // Volume and truck space must describe the same load. This is the check that
  // catches a cubic-yard figure entered into a cubic-foot field: a 27× error
  // shows up here as a gross ratio rather than passing silently.
  const volMid = (p.volumeCubicFeet.min + p.volumeCubicFeet.max) / 2
  const pctMid = (p.truckSpacePercent.min + p.truckSpacePercent.max) / 2
  if (volMid > 0 && pctMid > 0 && p.truckSpacePercent.max < 100) {
    const implied = (volMid / TRUCK_CUBIC_FEET) * 100
    const ratio = Math.max(implied / pctMid, pctMid / implied)
    if (ratio > 3) {
      problems.push(
        `volume and truck space disagree: ${volMid} cu ft implies ~${implied.toFixed(0)}% ` +
        `of a ${TRUCK_CUBIC_FEET} cu ft truck, but ${pctMid}% was proposed`,
      )
    }
  }

  // Lane hygiene — the two lanes must not borrow each other's concepts.
  const text = JSON.stringify(p).toLowerCase()
  if (p.lane === 'moving' && /landfill|dump fee|disposal fee|tipping/.test(text)) {
    problems.push('moving proposal contains disposal/landfill concepts')
  }
  if (p.lane === 'junk_removal' && /unloading|reassembl/.test(text)) {
    problems.push('junk proposal contains moving-only concepts')
  }
  if (/\bprice|\bquote|\busd|\$\d/.test(text)) problems.push('proposal contains customer pricing')
  return problems
}

/**
 * Does the proposed truck-space percentage follow from the proposed volume?
 *
 * volume / TRUCK_CUBIC_FEET * 100, with a tolerance for honest rounding. The
 * diagnostic measured 13/13 labeler conversions exact while the verifier called
 * 10/13 inconsistent, so this is checked in code rather than believed from a
 * model — a prompt can be ignored, arithmetic cannot.
 */
export function truckSpaceConsistent(p: LabelProposal, tolerancePct = 3): boolean {
  const vol = (p.volumeCubicFeet.min + p.volumeCubicFeet.max) / 2
  const pct = (p.truckSpacePercent.min + p.truckSpacePercent.max) / 2
  if (!(vol > 0) || !(pct > 0)) return false
  if (p.truckSpacePercent.max >= 100) return true   // saturated: multi-load, cannot be expressed
  return Math.abs((vol / TRUCK_CUBIC_FEET) * 100 - pct) <= tolerancePct
}

// ── Consensus gate ──────────────────────────────────────────────────────────

export const THRESHOLDS = {
  autoVerifyConfidence: 0.90,
  autoRejectConfidence: 0.95,
  humanReviewFloor: 0.60,
  /** Ranges must overlap by at least this fraction of the wider range. */
  minRangeOverlap: 0.5,
}

/** Fractional overlap of two ranges, relative to the wider one. 1 = identical. */
export function rangeOverlap(a: { min: number; max: number }, b: { min: number; max: number }): number {
  const lo = Math.max(a.min, b.min)
  const hi = Math.min(a.max, b.max)
  const inter = Math.max(0, hi - lo)
  const widest = Math.max(a.max - a.min, b.max - b.min)
  if (widest === 0) return a.min === b.min ? 1 : 0
  return inter / widest
}

export type ConsensusInput = {
  preScreen: PreScreen
  classifier: ClassifierResult
  label: LabelProposal
  verifier: VerifierResult
  verifierLabel?: LabelProposal
}

export type ConsensusDecision = {
  state: CurationState
  tier: DatasetTier
  reason: string
  confidence: number
  criticalDisagreements: DisagreementCode[]
  deterministicProblems: string[]
}

/**
 * The gate. Order matters: deterministic blockers first, then privacy/licence,
 * then agreement, then confidence. Anything that is not clearly a pass and not
 * clearly a reject becomes a human's problem, which is the correct default.
 */
export function decide(input: ConsensusInput): ConsensusDecision {
  const { preScreen: pre, classifier, label, verifier } = input
  const problems = validateProposal(label)
  // A verifier that raises truck_space_inconsistent against arithmetic we can
  // check ourselves is simply wrong. Drop that one code rather than the whole
  // verdict: its other disagreements may still be sound.
  const arithmeticOk = truckSpaceConsistent(label)
  const disagreements = arithmeticOk
    ? verifier.disagreements.filter(d => d !== 'truck_space_inconsistent')
    : verifier.disagreements
  const critical = disagreements.filter(d => CRITICAL_CODES.includes(d))
  const consensus = Math.min(classifier.confidence, verifier.confidence)

  const out = (state: CurationState, reason: string, tier: DatasetTier = 'candidate'): ConsensusDecision =>
    ({ state, tier, reason, confidence: consensus, criticalDisagreements: critical, deterministicProblems: problems })

  if (pre.state) return out(pre.state, pre.reasons.join('; '))

  // Privacy and licence are never traded against confidence.
  if (classifier.privacyRisk || disagreements.includes('privacy_risk')) {
    return out('privacy_blocked', 'privacy risk raised by a model — a human decides, never automation')
  }
  if (classifier.licenseRisk || disagreements.includes('license_risk')) {
    return out('license_blocked', 'licence risk raised by a model')
  }

  if (!classifier.operational && classifier.confidence >= THRESHOLDS.autoRejectConfidence
      && verifier.verdict === 'reject') {
    return out('auto_rejected', `both roles agree this is not an operational scene (${consensus.toFixed(2)})`)
  }
  if (classifier.lane === 'neither') return out('auto_rejected', 'classified as neither lane')
  if (classifier.lane === 'ambiguous') return out('needs_human_review', 'lane is ambiguous')

  if (disagreements.includes('insufficient_context')
      && classifier.confidence < THRESHOLDS.autoVerifyConfidence) {
    return out('insufficient_evidence', 'both roles report the image cannot support operational labelling')
  }

  if (classifier.lane !== label.lane) return out('needs_human_review', 'classifier and labeler disagree on lane')
  if (problems.length) return out('needs_human_review', `deterministic validation failed: ${problems[0]}`)
  if (critical.length) return out('needs_human_review', `critical disagreement: ${critical.join(', ')}`)
  if (verifier.verdict === 'reject') return out('needs_human_review', 'verifier rejected a labeled candidate')
  if (verifier.verdict === 'revise' || verifier.verdict === 'uncertain') {
    return out('needs_human_review', `verifier returned ${verifier.verdict}`)
  }

  // Where the verifier produced its own ranges, they must materially overlap.
  if (input.verifierLabel) {
    for (const k of ['quantityRange', 'volumeCubicFeet', 'truckSpacePercent'] as const) {
      const ov = rangeOverlap(label[k], input.verifierLabel[k])
      if (ov < THRESHOLDS.minRangeOverlap) {
        return out('needs_human_review', `${k} overlap ${ov.toFixed(2)} below ${THRESHOLDS.minRangeOverlap}`)
      }
    }
  }

  if (consensus < THRESHOLDS.humanReviewFloor) return out('insufficient_evidence', `confidence ${consensus.toFixed(2)} below floor`)
  if (consensus < THRESHOLDS.autoVerifyConfidence) return out('needs_human_review', `confidence ${consensus.toFixed(2)} below auto-verify threshold`)

  // Machine consensus produces SILVER. Gold requires a human — always.
  return out('auto_verified', `consensus ${consensus.toFixed(2)}, no critical disagreement`, 'silver')
}
