// ─────────────────────────────────────────────────────────────────────────────
// Per-job-type scoring specs.
//
// A junk-removal label and a moving label are not interchangeable answer keys.
// They were entered against different questions, and scoring one with the other's
// fields produces a number that looks like accuracy and is not. This module makes
// that mistake structural rather than a matter of care: every scoring path takes a
// spec, the spec names its job type, and `assertLane` refuses a mismatch loudly
// instead of quietly returning a plausible percentage.
//
// It also records what CANNOT be scored, and why. The labelling UI captured one
// combined labour range, not separate loading and unloading; it captured an object
// list, not a box count. Those moving dimensions are genuinely unlabelled. The
// honest report says "unavailable — never labelled", not 0%, and NOT a relabelling
// demand for fields the existing ten labels were never asked to carry.
// ─────────────────────────────────────────────────────────────────────────────

import type { ManifestEntry, JobType, Range } from './schema'

/** A dimension the benchmark can score, and the label field that answers it. */
export type ScoreDimension = {
  key: string
  label: string
  /** Ground truth present on this entry? Blank ≠ zero — blank is excluded. */
  has: (e: ManifestEntry) => boolean
}

/** A dimension this job type cares about that the dataset cannot answer yet. */
export type UnavailableDimension = { key: string; label: string; reason: string }

export type ScoringSpec = {
  jobType: JobType
  dimensions: ScoreDimension[]
  unavailable: UnavailableDimension[]
}

const range = (r: Range | null | undefined): boolean => !!r && typeof r.min === 'number' && typeof r.max === 'number'
const list = (v: string[] | undefined): boolean => Array.isArray(v) && v.length > 0

// ── Junk removal ─────────────────────────────────────────────────────────────
export const JUNK_SCORING: ScoringSpec = {
  jobType: 'junk_removal',
  dimensions: [
    { key: 'item_detection', label: 'Item detection (recall vs expected objects)', has: e => list(e.expectedObjects) },
    { key: 'quantity', label: 'Quantity range', has: e => range(e.expectedQuantityRange) },
    { key: 'volume', label: 'Volume range (cubic yards)', has: e => range(e.expectedVolumeRangeCubicYards) },
    { key: 'truck_space', label: 'Truck-space range (%)', has: e => range(e.expectedTruckSpaceRangePercent) },
    { key: 'crew', label: 'Crew-size range', has: e => range(e.expectedCrewRange) },
    { key: 'labor_hours', label: 'Labour-hours range', has: e => range(e.expectedLaborHoursRange) },
    { key: 'handling_flags', label: 'Handling flags', has: e => e.flagsReviewed === true },
    { key: 'disposal_flags', label: 'Disposal flags (fees, refrigerant, hazardous)', has: e => e.flagsReviewed === true },
    { key: 'access', label: 'Access concerns', has: e => e.flagsReviewed === true },
    { key: 'confidence', label: 'Confidence calibration', has: e => e.labelConfidence != null },
  ],
  unavailable: [],
}

// ── Moving ───────────────────────────────────────────────────────────────────
export const MOVING_SCORING: ScoringSpec = {
  jobType: 'moving',
  dimensions: [
    { key: 'item_detection', label: 'Furniture / item detection (recall vs expected objects)', has: e => list(e.expectedObjects) },
    { key: 'quantity', label: 'Quantity range', has: e => range(e.expectedQuantityRange) },
    { key: 'volume', label: 'Volume range (labelled in cubic yards; the moving lane reports cubic feet — converted, never compared raw)', has: e => range(e.expectedVolumeRangeCubicYards) },
    { key: 'truck_space', label: 'Truck-space range (%)', has: e => range(e.expectedTruckSpaceRangePercent) },
    { key: 'crew', label: 'Crew-size range', has: e => range(e.expectedCrewRange) },
    { key: 'labor_total', label: 'Total labour-hours range (loading + unloading combined)', has: e => range(e.expectedLaborHoursRange) },
    { key: 'handling_flags', label: 'Bulky / fragile / disassembly / appliance indicators', has: e => e.flagsReviewed === true },
    { key: 'access', label: 'Access indicators (stairs, elevator, long carry, narrow)', has: e => e.flagsReviewed === true },
    { key: 'missing_information', label: 'Missing-information decision (scored from the response, not the label)', has: () => true },
    { key: 'confidence', label: 'Confidence calibration', has: e => e.labelConfidence != null },
  ],
  unavailable: [
    {
      key: 'labor_split', label: 'Loading vs unloading labour, separately',
      reason: 'the labelling UI captured ONE combined labour range; the split was never asked for. Scored as a combined total instead — the ten existing labels stay valid.',
    },
    {
      key: 'box_count', label: 'Box / container count',
      reason: 'boxes were labelled inside the free-text object list, not as a separate count. Item detection covers their presence; the count itself is unlabelled.',
    },
    {
      key: 'flag_granularity', label: 'Fragile vs appliance vs bulky, individually',
      reason: 'the label schema carries handling/disposal/access flag groups shared with junk removal, so the moving-specific distinctions cannot be separated per item.',
    },
  ],
}

export function scoringFor(jobType: JobType): ScoringSpec {
  return jobType === 'moving' ? MOVING_SCORING : JUNK_SCORING
}

/**
 * The guard. A result and a label may only meet when both agree on the lane AND
 * the spec is that lane's. Throwing is deliberate: a silently skipped mismatch
 * would show up as a smaller sample rather than as an error, and a smaller sample
 * is exactly what nobody notices.
 */
export function assertLane(spec: ScoringSpec, entry: ManifestEntry, resultJobType: JobType): void {
  if (entry.jobType !== resultJobType) {
    throw new Error(`lane mismatch: label ${entry.id} is ${entry.jobType} but the result is ${resultJobType}`)
  }
  if (spec.jobType !== entry.jobType) {
    throw new Error(`scoring spec mismatch: ${spec.jobType} spec applied to a ${entry.jobType} label (${entry.id})`)
  }
}

/** Dimensions this entry can actually be scored on, given what was labelled. */
export function scorableDimensions(spec: ScoringSpec, entry: ManifestEntry): ScoreDimension[] {
  return spec.dimensions.filter(d => d.has(entry))
}
