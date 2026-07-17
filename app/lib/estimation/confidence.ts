// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — DETERMINISTIC CONFIDENCE GATING.
//
// Turns a normalized JunkPhotoAnalysisV2 + the deterministic volume estimate into
// an owner-facing confidence BAND (high / medium / low) plus a manual-review
// decision. This decides whether an estimate is owner-ready, owner-should-review,
// or must go on-site / get more photos — it NEVER touches the price.
//
//   HIGH   → narrow volume range, good coverage, no specialty, no dup concerns.
//            Owner-ready to send.
//   MEDIUM → wider range, missing access answers, or a specialty item. Owner should
//            review before sending.
//   LOW    → poor/unusable photos, major portions hidden, multi-load, heavy
//            construction, hazard, or conflicting images. On-site or more photos.
//
// Never emits false precision: callers get a BAND + an internal 0..1 score, never
// an "87.43%". Pure + deterministic — no I/O, no Date.now, no randomness. Thresholds
// + penalty weights are configurable so ops can retune gating without a deploy.
// ─────────────────────────────────────────────────────────────────────────────

import type { JunkPhotoAnalysisV2, ConfidenceBand } from '../ai/analysis-schema-v2'
import type { VolumeEstimate } from './types'
import { detectSpecialty } from './specialty-taxonomy'

export const CONFIDENCE_VERSION = 1

export type ConfidenceResult = {
  band: ConfidenceBand
  score: number            // internal 0..1 — attribution/telemetry only, never shown raw
  reasons: string[]        // what pulled the band down (explainable)
  manualReview: boolean
  manualReviewReasons: string[]
}

export type ConfidenceThresholds = {
  highMin: number          // score at/above → HIGH (unless a cap forces lower)
  mediumMin: number        // score at/above → MEDIUM
  wideVolumeSpread: number  // (high-low)/expected above this → volume-uncertainty penalty
  multiLoadFraction: number // truckFraction.high at/above this → multi-load concern
  lowConfItemShare: number  // share of low-confidence items above this → penalty
  wideQtyShare: number     // share of objects with a wide min/max qty above this → dup penalty
  penalties: {
    someUnusable: number
    fewViewpoints: number
    coverageGap: number
    volumeSpread: number
    dupAmbiguity: number
    lowConfItems: number
    accessUnknown: number
    specialty: number
    hazard: number
    largeJob: number
    multiLoad: number
    missingAnswers: number
    modelReview: number
    volumeHintDivergence: number
  }
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  highMin: 0.8,
  mediumMin: 0.55,
  wideVolumeSpread: 0.55,
  multiLoadFraction: 1.0,
  lowConfItemShare: 0.34,
  wideQtyShare: 0.34,
  penalties: {
    someUnusable: 0.12,
    fewViewpoints: 0.15,
    coverageGap: 0.15,
    volumeSpread: 0.2,
    dupAmbiguity: 0.15,
    lowConfItems: 0.15,
    accessUnknown: 0.1,
    specialty: 0.12,
    hazard: 0.25,
    largeJob: 0.1,
    multiLoad: 0.25,
    missingAnswers: 0.08,
    modelReview: 0.2,
    volumeHintDivergence: 0.12,
  },
}

export type ComputeConfidenceOpts = {
  thresholds?: Partial<ConfidenceThresholds>
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
// Round the internal score to 2 dp so it is stable/attributable but never paraded
// as false precision (the customer only ever sees the band).
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Deterministic confidence gate. `volume` is the DETERMINISTIC engine output — its
 * spread (not the model's volumeHint) drives the volume-uncertainty signal. The
 * model's volumeHint is used only as an optional sanity CROSS-CHECK.
 */
export function computeConfidence(
  v2: JunkPhotoAnalysisV2,
  volume: VolumeEstimate,
  opts: ComputeConfidenceOpts = {},
): ConfidenceResult {
  const t: ConfidenceThresholds = {
    ...DEFAULT_CONFIDENCE_THRESHOLDS,
    ...(opts.thresholds ?? {}),
    penalties: { ...DEFAULT_CONFIDENCE_THRESHOLDS.penalties, ...(opts.thresholds?.penalties ?? {}) },
  }
  const P = t.penalties

  let score = 1
  const reasons: string[] = []
  const manualReviewReasons: string[] = []
  // A cap forces the band no higher than a ceiling regardless of score.
  let bandCeiling: ConfidenceBand = 'high'
  const capLow = () => { bandCeiling = 'low' }
  const capMedium = () => { if (bandCeiling === 'high') bandCeiling = 'medium' }
  const penalize = (amount: number, reason: string) => { score -= amount; reasons.push(reason) }

  const received = Math.max(0, v2.imageCountReceived | 0)
  const usable = Math.max(0, v2.imageCountUsable | 0)
  const inventory = Array.isArray(v2.unifiedInventory) ? v2.unifiedInventory : []

  // ── Image quality / usable viewpoints ──────────────────────────────────────
  if (usable === 0) {
    penalize(0.6, 'No usable photos — the read cannot be trusted.')
    manualReviewReasons.push('No usable photos.')
    capLow()
  } else {
    if (usable < received) {
      penalize(P.someUnusable, `${received - usable} of ${received} photos were unusable.`)
    }
    if (usable === 1) {
      penalize(P.fewViewpoints, 'Only a single usable viewpoint — limited angles to gauge volume.')
      capMedium()
    }
  }
  // Unusable / failed image results (independent of the usable count).
  const unusableResults = (v2.imageQualityResults ?? []).filter((q) => q.quality === 'unusable').length
  if (unusableResults > 0 && usable > 0 && unusableResults >= usable) {
    penalize(P.coverageGap, 'Most images were unusable — major portions of the job may be hidden.')
    capLow()
  }

  // ── Scene coverage — multiple areas but too few angles to cover them ────────
  if (v2.accessAssessment?.multipleRoomsOrAreas && usable > 0 && usable < 2) {
    penalize(P.coverageGap, 'Items are spread across multiple areas but only one photo covers them.')
    capMedium()
  }

  // ── Volume uncertainty — deterministic band spread (NOT the model hint) ──────
  const exp = volume?.cubicYards?.expected ?? 0
  const spread = exp > 0 ? (volume.cubicYards.high - volume.cubicYards.low) / exp : 0
  if (exp > 0 && spread >= t.wideVolumeSpread) {
    penalize(P.volumeSpread, 'Wide volume range — item counts are uncertain.')
    capMedium()
  }

  // ── Duplicate ambiguity — objects with a wide min/max quantity spread ───────
  const wideQtyCount = inventory.filter((o) => {
    const q = Math.max(1, o.quantity || 0)
    return (o.maxQuantity - o.minQuantity) / q >= 0.5
  }).length
  if (inventory.length > 0 && wideQtyCount / inventory.length >= t.wideQtyShare) {
    penalize(P.dupAmbiguity, 'Same items may be seen across photos — counts are ambiguous.')
    capMedium()
  }

  // ── Item-classification uncertainty — share of low-confidence objects ───────
  const lowConfItems = inventory.filter((o) => o.confidence === 'low').length
  if (inventory.length > 0 && lowConfItems / inventory.length >= t.lowConfItemShare) {
    penalize(P.lowConfItems, 'Several items were identified with low confidence.')
    capMedium()
  }

  // ── Access uncertainty — unresolved access questions ────────────────────────
  const acc = v2.accessAssessment ?? ({} as JunkPhotoAnalysisV2['accessAssessment'])
  const accessUnknowns = [acc.stairs, acc.elevator, acc.longCarry, acc.narrowAccess, acc.parkingRestricted, acc.outdoorDistance]
    .filter((v) => v === 'unknown').length
  if (accessUnknowns >= 4) {
    penalize(P.accessUnknown, 'Site access (stairs / carry / parking) is unknown from the photos.')
    capMedium()
  }

  // ── Hazard / specialty concern ──────────────────────────────────────────────
  const disp = v2.disposalAssessment ?? ({ surchargeItems: [], hazardousPossible: false, specialtyItems: [] } as JunkPhotoAnalysisV2['disposalAssessment'])
  const hazard = !!disp.hazardousPossible ||
    inventory.some((o) => o.disposalClass === 'hazardous') ||
    (v2.perImageObservations ?? []).some((p) => p.hazardousConcern || p.paintOrChemical)
  if (hazard) {
    penalize(P.hazard, 'Possible hazardous materials — must be confirmed by a person.')
    manualReviewReasons.push('Possible hazardous materials.')
    capLow()
  }
  // TRUE specialty only — match a curated item taxonomy against the model's structured
  // description/category + explicit specialtyItems. Generic operational notes (a
  // specialHandling like "2-person lift" / "disassembly" / "e-waste") must NOT trigger a
  // specialty review, or every ordinary job (desk, boxes, sofa, brush) is forced to manual.
  const specialtyMatch = detectSpecialty({
    descriptions: inventory.map((o) => o.description),
    categories: inventory.map((o) => o.category),
    specialtyItems: disp.specialtyItems,
  })
  if (specialtyMatch && !hazard) {
    penalize(P.specialty, `Specialty item (${specialtyMatch}) needs a handling check.`)
    manualReviewReasons.push('Specialty item needs a handling check.')
    capMedium()
  }

  // ── Heavy construction / dense debris ───────────────────────────────────────
  const heavyConstruction = inventory.some((o) => o.disposalClass === 'construction' || o.weightClass === 'very_heavy') ||
    (v2.perImageObservations ?? []).some((p) => p.constructionDebris)
  if (heavyConstruction) {
    penalize(P.largeJob, 'Heavy construction / dense debris — weight-limited load.')
    capMedium()
  }

  // ── Job size / more-than-one-load ───────────────────────────────────────────
  const fracHigh = volume?.truckFraction?.high ?? 0
  const fracExp = volume?.truckFraction?.expected ?? 0
  if (fracExp >= 0.9) {
    penalize(P.largeJob, 'Large job — near or above a full truck.')
    capMedium()
  }
  if (fracExp >= t.multiLoadFraction || fracHigh >= 1.2 || (v2.laborAssessment?.potentialSecondTrip && fracHigh >= t.multiLoadFraction)) {
    penalize(P.multiLoad, 'Likely more than one truck load — confirm scope on site.')
    manualReviewReasons.push('Possible multi-load job.')
    capLow()
  }

  // ── Missing customer answers ────────────────────────────────────────────────
  const missing = (v2.missingInformation?.length ?? 0) + (v2.recommendedCustomerQuestions?.length ?? 0)
  if (missing > 0) {
    penalize(P.missingAnswers, 'Some details still need a customer answer.')
    capMedium()
  }

  // ── The model itself asked for review ───────────────────────────────────────
  if (v2.manualReviewRequired) {
    penalize(P.modelReview, 'Analysis flagged this booking for manual review.')
    for (const r of v2.manualReviewReasons ?? []) manualReviewReasons.push(r)
    capMedium()
  }

  // ── Sanity cross-check: deterministic volume vs the model's hint ────────────
  // The hint NEVER overrides the deterministic volume — a big divergence just
  // lowers confidence so a human takes a look.
  const hintLikely = v2.volumeHint?.likelyCubicYards
  if (hintLikely != null && hintLikely > 0 && exp > 0) {
    const divergence = Math.abs(exp - hintLikely) / Math.max(exp, hintLikely)
    if (divergence >= 0.5) {
      penalize(P.volumeHintDivergence, 'Model volume hint diverges sharply from the deterministic estimate.')
      capMedium()
    }
  }

  score = round2(clamp01(score))

  // ── Band = score → thresholds, then clamped down to the cap ceiling ─────────
  let band: ConfidenceBand = score >= t.highMin ? 'high' : score >= t.mediumMin ? 'medium' : 'low'
  const order: Record<ConfidenceBand, number> = { high: 3, medium: 2, low: 1 }
  if (order[band] > order[bandCeiling]) band = bandCeiling

  const manualReview =
    band === 'low' ||
    hazard ||
    !!specialtyMatch ||
    !!v2.manualReviewRequired ||
    manualReviewReasons.length > 0

  return {
    band,
    score,
    reasons,
    manualReview,
    manualReviewReasons: Array.from(new Set(manualReviewReasons)),
  }
}
