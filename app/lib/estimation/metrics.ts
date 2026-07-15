// ── Estimation metrics (Phase 10) ────────────────────────────────────────────
//
// Pure, deterministic, EXPLAINABLE aggregation over a set of shadow-comparison /
// outcome samples. This is the enterprise accuracy view for the new deterministic
// engine: how close its predictions land to ground truth, how often it under- or
// over-quotes, how much it routes to manual review, and how often customers correct
// the AI inventory. No ML, no fabrication — every metric returns `null` when the
// underlying data isn't present rather than inventing a number. Wiring this into an
// internal AI-analytics view is a documented follow-up; this file just exports the
// aggregator + its result type.

/**
 * One evaluation sample. Predicted fields come from an EstimationResult; the `actual*`
 * fields are GROUND TRUTH from the completed job (final invoice, real truck loads, the
 * crew actually sent, etc.) and are frequently absent — every accuracy metric degrades
 * to `null` when its ground truth is missing.
 */
export type EstimationSample = {
  // ── Predicted (from the engine) ──
  predictedItemCount?: number
  predictedVolumeCubicYards?: number
  predictedWeightPounds?: number
  predictedTruckLoads?: number
  predictedCrewSize?: number
  predictedLaborHours?: number
  recommendedCents?: number
  confidence?: number                // overall confidenceScore, 0..1
  manualReviewRequired?: boolean
  customerCorrected?: boolean         // did the customer edit the AI inventory?
  // ── Ground truth (from the actual job outcome; often absent) ──
  inventoryMatch?: boolean            // did the itemized inventory match reality?
  actualItemCount?: number
  actualVolumeCubicYards?: number
  actualWeightPounds?: number
  actualTruckLoads?: number
  actualCrewSize?: number
  actualLaborHours?: number
  actualCents?: number                // final invoiced price — the pricing ground truth
  // ── Pass-through operational (optional) ──
  latencyMs?: number
  costUsd?: number
}

export type EstimationMetrics = {
  sampleCount: number
  // Accuracy vs ground truth (null when no sample carries the ground truth):
  inventoryAccuracy: number | null    // fraction of samples with inventoryMatch === true
  countAccuracy: number | null        // fraction where predicted item count exactly matched
  countMeanAbsError: number | null    // mean |predicted − actual| item count
  volumeMape: number | null           // mean absolute percentage error (%)
  weightMape: number | null
  truckMape: number | null
  crewMeanAbsError: number | null
  laborMape: number | null
  priceMape: number | null
  // Business-risk rates (over samples that carry both predicted + actual price):
  underquoteRate: number | null       // fraction where predicted price < actual (%)
  overquoteRate: number | null        // fraction where predicted price > actual (%)
  // Operational rates:
  manualReviewRate: number | null     // fraction flagged for manual review
  customerCorrectionRate: number | null // fraction where the customer corrected inventory
  avgConfidence: number | null
  // Pass-through averages (only when provided):
  avgLatencyMs: number | null
  avgCostUsd: number | null
}

// ── Deterministic helpers — each returns null when it has no data to summarize ──

/** Mean of the finite numbers; null when empty. */
function mean(xs: number[]): number | null {
  if (xs.length === 0) return null
  const sum = xs.reduce((a, b) => a + b, 0)
  return sum / xs.length
}

/** Fraction of `true` over the defined booleans; null when none are defined. */
function rate(bs: boolean[]): number | null {
  if (bs.length === 0) return null
  return bs.filter(Boolean).length / bs.length
}

/** Round to 2 decimal places (keeps output stable + explainable), preserving null. */
function r2(x: number | null): number | null {
  return x == null ? null : Math.round(x * 100) / 100
}

/**
 * Mean absolute percentage error over (predicted, actual) pairs where BOTH are present
 * and actual !== 0. Returned as a percentage (e.g. 12.5 for 12.5%). Null when no usable
 * pair exists — we never divide by zero and never fabricate.
 */
function mape(
  samples: EstimationSample[],
  pred: (s: EstimationSample) => number | undefined,
  act: (s: EstimationSample) => number | undefined,
): number | null {
  const errs: number[] = []
  for (const s of samples) {
    const p = pred(s)
    const a = act(s)
    if (p == null || a == null || !Number.isFinite(p) || !Number.isFinite(a) || a === 0) continue
    errs.push(Math.abs(p - a) / Math.abs(a) * 100)
  }
  return mean(errs)
}

/** Mean absolute error over (predicted, actual) pairs where both are present. */
function mae(
  samples: EstimationSample[],
  pred: (s: EstimationSample) => number | undefined,
  act: (s: EstimationSample) => number | undefined,
): number | null {
  const errs: number[] = []
  for (const s of samples) {
    const p = pred(s)
    const a = act(s)
    if (p == null || a == null || !Number.isFinite(p) || !Number.isFinite(a)) continue
    errs.push(Math.abs(p - a))
  }
  return mean(errs)
}

/**
 * Aggregate estimation accuracy + risk metrics over a set of samples. Pure and
 * deterministic. Metrics lacking their underlying data return `null` (NOT 0) so the
 * analytics view can distinguish "no data" from "measured zero".
 */
export function computeEstimationMetrics(samples: EstimationSample[]): EstimationMetrics {
  const s = Array.isArray(samples) ? samples : []

  // Price under/over-quote: only samples with both predicted and actual price (> 0).
  const pricePairs = s.filter(
    x => x.recommendedCents != null && x.actualCents != null && (x.actualCents as number) > 0,
  )
  const underquoteRate = pricePairs.length === 0
    ? null
    : pricePairs.filter(x => (x.recommendedCents as number) < (x.actualCents as number)).length / pricePairs.length
  const overquoteRate = pricePairs.length === 0
    ? null
    : pricePairs.filter(x => (x.recommendedCents as number) > (x.actualCents as number)).length / pricePairs.length

  const defined = <T>(xs: (T | undefined)[]): T[] => xs.filter((x): x is T => x !== undefined && x !== null)

  return {
    sampleCount: s.length,

    inventoryAccuracy: r2(rate(defined(s.map(x => x.inventoryMatch)))),
    countAccuracy: r2(rate(
      s.filter(x => x.predictedItemCount != null && x.actualItemCount != null)
        .map(x => x.predictedItemCount === x.actualItemCount),
    )),
    countMeanAbsError: r2(mae(s, x => x.predictedItemCount, x => x.actualItemCount)),

    volumeMape: r2(mape(s, x => x.predictedVolumeCubicYards, x => x.actualVolumeCubicYards)),
    weightMape: r2(mape(s, x => x.predictedWeightPounds, x => x.actualWeightPounds)),
    truckMape: r2(mape(s, x => x.predictedTruckLoads, x => x.actualTruckLoads)),
    crewMeanAbsError: r2(mae(s, x => x.predictedCrewSize, x => x.actualCrewSize)),
    laborMape: r2(mape(s, x => x.predictedLaborHours, x => x.actualLaborHours)),
    priceMape: r2(mape(s, x => x.recommendedCents, x => x.actualCents)),

    underquoteRate: r2(underquoteRate),
    overquoteRate: r2(overquoteRate),

    manualReviewRate: r2(rate(defined(s.map(x => x.manualReviewRequired)))),
    customerCorrectionRate: r2(rate(defined(s.map(x => x.customerCorrected)))),
    avgConfidence: r2(mean(defined(s.map(x => x.confidence)))),

    avgLatencyMs: r2(mean(defined(s.map(x => x.latencyMs)))),
    avgCostUsd: r2(mean(defined(s.map(x => x.costUsd)))),
  }
}
