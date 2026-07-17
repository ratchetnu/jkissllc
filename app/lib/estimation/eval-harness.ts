// ─────────────────────────────────────────────────────────────────────────────
// Phase 14 — OFFLINE EVALUATION HARNESS for the V2 vision estimator.
//
// Runs the DETERMINISTIC half of the pipeline (v2-bridge → load-tier → confidence
// → clarify-v2) over stored, privacy-safe fixture analyses (Phase 13) that each
// carry a human-authored `groundTruth`, and measures accuracy with regression
// thresholds. There are NO live AI calls and NO real customer photos: a fixture is
// a pre-made, anonymized JunkPhotoAnalysisV2 — i.e. the model's structured output
// for a known scene — so this evaluates the deterministic engine that turns that
// output into an estimate. (A later phase can diff a real model run against the
// same fixtures to catch prompt/model drift.)
//
// Metrics (Phase 14/18):
//   • inventory category precision / recall
//   • count accuracy + duplicate-object error rate (did overlapping photos of the
//     same item collapse to the right count? did different rooms stay un-merged?)
//   • volume coverage (did ground-truth volume land inside the deterministic band?)
//     + mean absolute volume error
//   • load-tier accuracy (exact + within-one-tier)
//   • quote-range presence
//   • manual-review recall (flagged when GT says a human must look)
//   • hazard / specialty flag recall
//   • clarification-question presence recall (asked when GT expects a question)
//
// Comparisons are DETERMINISTIC (numbers / tiers / categories / booleans) — never
// string matching of free-text descriptions. `EVAL_THRESHOLDS` gate the run so a
// change to the taxonomy volumes, load-tier bounds, confidence penalties, or the
// bridge can't silently regress: runEval returns pass=false if any gate is breached.
//
// Pure + deterministic — no I/O, no Date.now, no randomness. Reuses the SAME
// modules the shadow orchestrator uses (estimateFromV2, clarificationsForV2), so
// the eval exercises the exact production code path.
// ─────────────────────────────────────────────────────────────────────────────

import type { JunkPhotoAnalysisV2 } from '../ai/analysis-schema-v2'
import type { InventoryCategory } from '../ai/inventory-taxonomy'
import { estimateFromV2, type EstimateFromV2Opts, type EstimationResultV2 } from './v2-bridge'
import { clarificationsForV2 } from './clarify-v2'
import { LOAD_TIERS, type LoadTierKey } from './load-tier'
import { detectSpecialty } from './specialty-taxonomy'

export const EVAL_HARNESS_VERSION = 1

// ── Ground truth authored per scene (what a human estimator would call it) ─────
export type GroundTruth = {
  /** Governed categories that MUST appear in the deterministic inventory. */
  expectedCategories: InventoryCategory[]
  /** Total item count across the inventory (sum of counts). For dedup fixtures this
   *  is the post-dedup target (overlapping photos of one couch → 1). */
  expectedItemCount: number
  /** Allowed absolute difference on the count check (default 0 — fixtures are exact). */
  countTolerance?: number
  /** Human volume range in cubic yards. Coverage = the deterministic band overlaps it. */
  expectedVolumeCuYd: [number, number]
  /** The named load bucket a human would use. */
  expectedLoadTier: LoadTierKey
  /** Must this booking be routed to a human? */
  expectManualReview: boolean
  /** Possible hazardous / special-disposal material present? */
  expectHazard: boolean
  /** Specialty item (piano / hot tub / safe) present? */
  expectSpecialty: boolean
  /** Should the engine ask the customer at least one clarifying question? */
  expectClarification: boolean
  /** This fixture exercises deduplication — the count check is a dedup assertion. */
  dedupCheck?: boolean
}

export type Fixture = {
  id: string
  scenario: string
  analysis: JunkPhotoAnalysisV2
  groundTruth: GroundTruth
}

// ── Per-case + aggregate report shapes ────────────────────────────────────────
export type CaseChecks = {
  categoriesOk: boolean
  countOk: boolean
  tierExact: boolean
  tierWithinOne: boolean
  volumeCovered: boolean
  reviewOk: boolean
  hazardOk: boolean
  specialtyOk: boolean
  clarifyOk: boolean
  quoteRangePresent: boolean
}

export type PerCaseResult = {
  id: string
  scenario: string
  pass: boolean
  failures: string[]
  checks: CaseChecks
  // observed vs expected (for the printed table + debugging)
  predictedCategories: InventoryCategory[]
  predictedItemCount: number
  predictedTier: LoadTierKey
  detVolumeCuYd: { low: number; expected: number; high: number }
  volumeAbsError: number
  predictedManualReview: boolean
  predictedHazard: boolean
  predictedSpecialty: boolean
  predictedClarificationCount: number
  gt: GroundTruth
}

export type EvalMetrics = {
  inventoryPrecision: number
  inventoryRecall: number
  countAccuracy: number          // fraction of cases within count tolerance
  meanCountAbsError: number
  duplicateErrorRate: number     // over dedupCheck cases: fraction with wrong count
  duplicateCaseCount: number
  volumeCoverageRate: number
  volumeCoverageMiss: number     // 1 - coverageRate
  meanVolumeAbsError: number
  loadTierExactAccuracy: number
  loadTierWithinOneAccuracy: number
  quoteRangePresenceRate: number
  manualReviewRecall: number
  hazardRecall: number
  specialtyRecall: number
  clarificationRecall: number
}

export type EvalThresholds = {
  minInventoryRecall: number
  maxDuplicateErrorRate: number
  minLoadTierWithinOne: number
  minManualReviewRecall: number
  minHazardRecall: number
  maxVolumeCoverageMiss: number
}

// Regression gates. Tuned so the representative fixture set passes today (i.e. the
// current deterministic engine is the correct baseline); a future change that drifts
// the engine away from the ground truth trips a gate and fails the eval.
export const EVAL_THRESHOLDS: EvalThresholds = {
  minInventoryRecall: 0.9,
  maxDuplicateErrorRate: 0,
  minLoadTierWithinOne: 0.9,
  minManualReviewRecall: 1,
  minHazardRecall: 1,
  maxVolumeCoverageMiss: 0.15,
}

export type EvalReport = {
  harnessVersion: number
  perCase: PerCaseResult[]
  totals: { cases: number; passed: number }
  metrics: EvalMetrics
  thresholds: EvalThresholds
  breaches: string[]
  pass: boolean
}

export type RunEvalOpts = {
  thresholds?: Partial<EvalThresholds>
  estimateOpts?: EstimateFromV2Opts
}

const TIER_INDEX: Record<string, number> = Object.fromEntries(LOAD_TIERS.map((t, i) => [t.key, i]))
const round2 = (n: number) => Math.round(n * 100) / 100
const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 1)

// Distance from the deterministic expected volume to the ground-truth range (0 if inside).
function rangeDistance(x: number, lo: number, hi: number): number {
  if (x < lo) return lo - x
  if (x > hi) return x - hi
  return 0
}

// Hazard signal, read the SAME way the bridge/confidence engine reads it.
function predictedHazard(fx: Fixture, res: EstimationResultV2): boolean {
  return (
    (res.restrictedItems?.length ?? 0) > 0 ||
    !!res.v2.disposalAssessment?.hazardousPossible ||
    (fx.analysis.perImageObservations ?? []).some((p) => p.hazardousConcern || p.paintOrChemical) ||
    (fx.analysis.unifiedInventory ?? []).some((o) => o.disposalClass === 'hazardous')
  )
}

// Specialty signal as confidence.ts NOW defines it — the deterministic specialty TAXONOMY
// matched against item description/category + explicit specialtyItems. NOT generic
// specialHandling notes (a "2-person lift" / "disassembly" is a surcharge, never a specialty).
function predictedSpecialty(fx: Fixture, res: EstimationResultV2): boolean {
  return detectSpecialty({
    descriptions: (fx.analysis.unifiedInventory ?? []).map((o) => o.description),
    categories: (fx.analysis.unifiedInventory ?? []).map((o) => o.category),
    specialtyItems: [...(fx.analysis.disposalAssessment?.specialtyItems ?? []), ...(res.v2.specialtyItems ?? [])],
  }) !== null
}

function evalCase(fx: Fixture, opts?: RunEvalOpts): PerCaseResult {
  const gt = fx.groundTruth
  const res = estimateFromV2(fx.analysis, opts?.estimateOpts)
  const clar = clarificationsForV2(fx.analysis)

  // ── Inventory categories ────────────────────────────────────────────────────
  const predictedCategories = res.inventory.map((i) => i.taxonomyId)
  const predSet = new Set<InventoryCategory>(predictedCategories)
  const gtSet = new Set<InventoryCategory>(gt.expectedCategories)
  const categoriesOk = [...gtSet].every((c) => predSet.has(c))

  // ── Counts + dedup ──────────────────────────────────────────────────────────
  const predictedItemCount = res.inventory.reduce((s, i) => s + (i.count || 0), 0)
  const countAbsError = Math.abs(predictedItemCount - gt.expectedItemCount)
  const countOk = countAbsError <= (gt.countTolerance ?? 0)

  // ── Load tier ───────────────────────────────────────────────────────────────
  const predictedTier = res.v2.loadTier.key
  const tierExact = predictedTier === gt.expectedLoadTier
  const tierWithinOne =
    Math.abs((TIER_INDEX[predictedTier] ?? -99) - (TIER_INDEX[gt.expectedLoadTier] ?? 99)) <= 1

  // ── Volume coverage (deterministic band vs GT range) ────────────────────────
  const det = res.volume.cubicYards
  const [gLo, gHi] = gt.expectedVolumeCuYd
  const volumeCovered = det.high >= gLo && det.low <= gHi
  const volumeAbsError = round2(rangeDistance(det.expected, gLo, gHi))

  // ── Review / hazard / specialty / clarification ─────────────────────────────
  const predictedManualReview = res.manualReviewRequired
  const predHazard = predictedHazard(fx, res)
  const predSpecialty = predictedSpecialty(fx, res)
  const predictedClarificationCount = clar.length

  const reviewOk = predictedManualReview === gt.expectManualReview
  const hazardOk = predHazard === gt.expectHazard
  const specialtyOk = predSpecialty === gt.expectSpecialty
  const clarifyOk = predictedClarificationCount > 0 === gt.expectClarification

  // ── Quote-range presence ────────────────────────────────────────────────────
  const rc = res.pricing?.rangeCents
  const quoteRangePresent =
    !!rc && Number.isFinite(rc.low) && Number.isFinite(rc.high) && rc.high >= rc.low

  const checks: CaseChecks = {
    categoriesOk, countOk, tierExact, tierWithinOne, volumeCovered,
    reviewOk, hazardOk, specialtyOk, clarifyOk, quoteRangePresent,
  }

  const failures: string[] = []
  if (!categoriesOk) failures.push(`missing categories: expected ${[...gtSet].join(',')} got ${[...predSet].join(',')}`)
  if (!countOk) failures.push(`count ${predictedItemCount} vs GT ${gt.expectedItemCount} (±${gt.countTolerance ?? 0})`)
  if (!tierWithinOne) failures.push(`load tier ${predictedTier} not within one of ${gt.expectedLoadTier}`)
  if (!volumeCovered) failures.push(`volume ${det.low}–${det.high} misses GT ${gLo}–${gHi}`)
  if (!reviewOk) failures.push(`manualReview ${predictedManualReview} vs GT ${gt.expectManualReview}`)
  if (!hazardOk) failures.push(`hazard ${predHazard} vs GT ${gt.expectHazard}`)
  if (!specialtyOk) failures.push(`specialty ${predSpecialty} vs GT ${gt.expectSpecialty}`)
  if (!clarifyOk) failures.push(`clarification present ${predictedClarificationCount > 0} vs GT ${gt.expectClarification}`)
  if (!quoteRangePresent) failures.push('quote range missing')

  return {
    id: fx.id,
    scenario: fx.scenario,
    pass: failures.length === 0,
    failures,
    checks,
    predictedCategories,
    predictedItemCount,
    predictedTier,
    detVolumeCuYd: det,
    volumeAbsError,
    predictedManualReview,
    predictedHazard: predHazard,
    predictedSpecialty: predSpecialty,
    predictedClarificationCount,
    gt,
  }
}

/**
 * Run the offline evaluation over a set of fixtures. Deterministic + reproducible:
 * the same fixtures always produce the same report. Returns pass=false when any
 * EVAL_THRESHOLDS gate is breached.
 */
export function runEval(fixtures: Fixture[], opts?: RunEvalOpts): EvalReport {
  const thresholds: EvalThresholds = { ...EVAL_THRESHOLDS, ...(opts?.thresholds ?? {}) }
  const perCase = fixtures.map((fx) => evalCase(fx, opts))

  // ── Micro-averaged inventory precision / recall ─────────────────────────────
  let interSum = 0
  let predSum = 0
  let gtSum = 0
  for (const c of perCase) {
    const predSet = new Set(c.predictedCategories)
    const gtSet = new Set(c.gt.expectedCategories)
    const inter = [...gtSet].filter((x) => predSet.has(x)).length
    interSum += inter
    predSum += predSet.size
    gtSum += gtSet.size
  }
  const inventoryPrecision = round2(safeDiv(interSum, predSum))
  const inventoryRecall = round2(safeDiv(interSum, gtSum))

  // ── Counts ──────────────────────────────────────────────────────────────────
  const countAccuracy = round2(safeDiv(perCase.filter((c) => c.checks.countOk).length, perCase.length))
  const meanCountAbsError = round2(
    safeDiv(perCase.reduce((s, c) => s + Math.abs(c.predictedItemCount - c.gt.expectedItemCount), 0), perCase.length),
  )

  // ── Duplicate-object error rate (dedup fixtures only) ───────────────────────
  const dupCases = perCase.filter((c) => c.gt.dedupCheck)
  const dupErrors = dupCases.filter((c) => !c.checks.countOk).length
  const duplicateErrorRate = round2(safeDiv(dupErrors, dupCases.length))

  // ── Volume coverage ─────────────────────────────────────────────────────────
  const covered = perCase.filter((c) => c.checks.volumeCovered).length
  const volumeCoverageRate = round2(safeDiv(covered, perCase.length))
  const meanVolumeAbsError = round2(safeDiv(perCase.reduce((s, c) => s + c.volumeAbsError, 0), perCase.length))

  // ── Load tier ───────────────────────────────────────────────────────────────
  const loadTierExactAccuracy = round2(safeDiv(perCase.filter((c) => c.checks.tierExact).length, perCase.length))
  const loadTierWithinOneAccuracy = round2(safeDiv(perCase.filter((c) => c.checks.tierWithinOne).length, perCase.length))

  // ── Quote-range presence ────────────────────────────────────────────────────
  const quoteRangePresenceRate = round2(safeDiv(perCase.filter((c) => c.checks.quoteRangePresent).length, perCase.length))

  // ── Recalls (over the cases where GT expects the signal) ────────────────────
  const recall = (want: (c: PerCaseResult) => boolean, ok: (c: PerCaseResult) => boolean) => {
    const pos = perCase.filter(want)
    return round2(safeDiv(pos.filter(ok).length, pos.length))
  }
  const manualReviewRecall = recall((c) => c.gt.expectManualReview, (c) => c.predictedManualReview)
  const hazardRecall = recall((c) => c.gt.expectHazard, (c) => c.predictedHazard)
  const specialtyRecall = recall((c) => c.gt.expectSpecialty, (c) => c.predictedSpecialty)
  const clarificationRecall = recall((c) => c.gt.expectClarification, (c) => c.predictedClarificationCount > 0)

  const metrics: EvalMetrics = {
    inventoryPrecision,
    inventoryRecall,
    countAccuracy,
    meanCountAbsError,
    duplicateErrorRate,
    duplicateCaseCount: dupCases.length,
    volumeCoverageRate,
    volumeCoverageMiss: round2(1 - volumeCoverageRate),
    meanVolumeAbsError,
    loadTierExactAccuracy,
    loadTierWithinOneAccuracy,
    quoteRangePresenceRate,
    manualReviewRecall,
    hazardRecall,
    specialtyRecall,
    clarificationRecall,
  }

  // ── Threshold gates ─────────────────────────────────────────────────────────
  const breaches: string[] = []
  if (metrics.inventoryRecall < thresholds.minInventoryRecall)
    breaches.push(`inventoryRecall ${metrics.inventoryRecall} < ${thresholds.minInventoryRecall}`)
  if (metrics.duplicateErrorRate > thresholds.maxDuplicateErrorRate)
    breaches.push(`duplicateErrorRate ${metrics.duplicateErrorRate} > ${thresholds.maxDuplicateErrorRate}`)
  if (metrics.loadTierWithinOneAccuracy < thresholds.minLoadTierWithinOne)
    breaches.push(`loadTierWithinOne ${metrics.loadTierWithinOneAccuracy} < ${thresholds.minLoadTierWithinOne}`)
  if (metrics.manualReviewRecall < thresholds.minManualReviewRecall)
    breaches.push(`manualReviewRecall ${metrics.manualReviewRecall} < ${thresholds.minManualReviewRecall}`)
  if (metrics.hazardRecall < thresholds.minHazardRecall)
    breaches.push(`hazardRecall ${metrics.hazardRecall} < ${thresholds.minHazardRecall}`)
  if (metrics.volumeCoverageMiss > thresholds.maxVolumeCoverageMiss)
    breaches.push(`volumeCoverageMiss ${metrics.volumeCoverageMiss} > ${thresholds.maxVolumeCoverageMiss}`)

  return {
    harnessVersion: EVAL_HARNESS_VERSION,
    perCase,
    totals: { cases: perCase.length, passed: perCase.filter((c) => c.pass).length },
    metrics,
    thresholds,
    breaches,
    pass: breaches.length === 0,
  }
}
