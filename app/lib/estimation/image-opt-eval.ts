// ─────────────────────────────────────────────────────────────────────────────
// IMAGE-OPTIMIZATION A/B EVALUATION — the accuracy guardrail for the optimization
// rollout. Given the SAME photos analyzed twice — once as the original, once as the
// optimized derivative — this decides whether the derivative preserved quote
// accuracy AND delivered a measurable cost/latency win. It is the gate the higher-
// risk ops (autocrop/normalize/sharpen/denoise) must clear before they go live.
//
// The user requirement — "do not reduce quote accuracy" — is enforced here: a
// derivative that moves volume, truck-fill, confidence, or the set of detected
// objects beyond tolerance is flagged as an accuracy regression and is NEVER
// promoted, no matter how large the token/byte saving.
//
// PURE + DETERMINISTIC + SIDE-EFFECT-FREE — no env, no clock, no I/O, never throws.
// The shadow worker feeds it two OptEvalSample projections; this file owns only the
// comparison math + verdict, so it is trivially unit-testable and safe to import
// anywhere. Wiring point: app/lib/estimation/shadow-worker.ts (see docs).
// ─────────────────────────────────────────────────────────────────────────────

// A minimal projection of one analysis outcome — the accuracy-bearing signals plus
// the cost facts. The shadow harness maps a full JunkPhotoAnalysis onto this shape.
export type OptEvalSample = {
  itemCount: number             // number of distinct normalized items detected
  totalVolumeCuYd: number       // likely total volume (the pricing-dominant number)
  truckLoadFraction: number     // likely truck-fill fraction
  confidence: number            // 0..1 model self-confidence
  detectedLabels: string[]      // normalized item labels (for object-overlap)
  latencyMs?: number            // provider round-trip
  bytes?: number                // image bytes the model consumed
  estTokens?: number            // estimated image tokens
  costUsd?: number              // AI input cost
}

export type OptEvalThresholds = {
  maxVolumeDeltaPct: number         // volume must stay within this % of the original
  maxTruckFractionDeltaPct: number  // truck-fill must stay within this %
  maxConfidenceDrop: number         // max allowed absolute confidence drop (0..1)
  minLabelJaccard: number           // min detected-object set overlap (0..1)
  maxItemCountDelta: number         // max allowed change in item count
}

// Conservative defaults — tuned to catch a meaningful accuracy shift, not noise.
export const DEFAULT_OPT_EVAL_THRESHOLDS: OptEvalThresholds = {
  maxVolumeDeltaPct: 10,
  maxTruckFractionDeltaPct: 10,
  maxConfidenceDrop: 0.1,
  minLabelJaccard: 0.7,
  maxItemCountDelta: 1,
}

export type OptEvalVerdict =
  | 'safe_to_promote'          // accuracy preserved AND a measurable cost/latency win
  | 'no_regression_no_benefit' // accuracy preserved but nothing was actually saved
  | 'accuracy_regression'      // an accuracy proxy moved beyond tolerance — DO NOT promote

export type OptEvalResult = {
  // Accuracy proxies (derivative vs original).
  itemCountDelta: number
  volumeDeltaPct: number
  truckFractionDeltaPct: number
  confidenceDelta: number      // signed: negative = derivative less confident
  labelJaccard: number         // 1 = identical detected-object sets
  // Efficiency (positive = the derivative was cheaper/faster).
  byteReductionPct: number
  tokenReductionPct: number
  costReductionPct: number
  latencyDeltaMs: number       // signed: negative = derivative faster
  latencyImprovedPct: number
  // Decision.
  accuracyRegression: boolean
  measurableBenefit: boolean
  verdict: OptEvalVerdict
  reasons: string[]            // which thresholds (if any) were breached / which wins counted
}

const absPct = (from: number, to: number): number =>
  from === 0 ? (to === 0 ? 0 : 100) : Math.abs((to - from) / from) * 100
const gainPct = (from: number, to: number): number =>
  from <= 0 ? 0 : Math.max(0, ((from - to) / from) * 100)
const round1 = (n: number) => Math.round(n * 10) / 10

function jaccard(a: string[], b: string[]): number {
  const norm = (xs: string[]) => new Set((Array.isArray(xs) ? xs : []).map(s => String(s).trim().toLowerCase()).filter(Boolean))
  const A = norm(a), B = norm(b)
  if (A.size === 0 && B.size === 0) return 1
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = A.size + B.size - inter
  return union === 0 ? 1 : inter / union
}

/**
 * Compare an original-image analysis (`original`) against its optimized-derivative
 * analysis (`derivative`) and decide whether the derivative is safe to promote.
 */
export function compareOptimizationOutcome(
  original: OptEvalSample,
  derivative: OptEvalSample,
  thresholds: Partial<OptEvalThresholds> = {},
): OptEvalResult {
  const t: OptEvalThresholds = { ...DEFAULT_OPT_EVAL_THRESHOLDS, ...thresholds }

  const itemCountDelta = (derivative.itemCount ?? 0) - (original.itemCount ?? 0)
  const volumeDeltaPct = round1(absPct(original.totalVolumeCuYd ?? 0, derivative.totalVolumeCuYd ?? 0))
  const truckFractionDeltaPct = round1(absPct(original.truckLoadFraction ?? 0, derivative.truckLoadFraction ?? 0))
  const confidenceDelta = round1(((derivative.confidence ?? 0) - (original.confidence ?? 0)) * 100) / 100
  const labelJaccard = Math.round(jaccard(original.detectedLabels, derivative.detectedLabels) * 100) / 100

  const byteReductionPct = round1(gainPct(original.bytes ?? 0, derivative.bytes ?? 0))
  const tokenReductionPct = round1(gainPct(original.estTokens ?? 0, derivative.estTokens ?? 0))
  const costReductionPct = round1(gainPct(original.costUsd ?? 0, derivative.costUsd ?? 0))
  const latencyDeltaMs = Math.round((derivative.latencyMs ?? 0) - (original.latencyMs ?? 0))
  const latencyImprovedPct = round1(gainPct(original.latencyMs ?? 0, derivative.latencyMs ?? 0))

  // ── Accuracy gate ──
  const reasons: string[] = []
  if (volumeDeltaPct > t.maxVolumeDeltaPct) reasons.push(`volume_shift:${volumeDeltaPct}%>${t.maxVolumeDeltaPct}%`)
  if (truckFractionDeltaPct > t.maxTruckFractionDeltaPct) reasons.push(`truck_fill_shift:${truckFractionDeltaPct}%>${t.maxTruckFractionDeltaPct}%`)
  if (-confidenceDelta > t.maxConfidenceDrop) reasons.push(`confidence_drop:${round1(-confidenceDelta * 100) / 100}>${t.maxConfidenceDrop}`)
  if (labelJaccard < t.minLabelJaccard) reasons.push(`object_overlap:${labelJaccard}<${t.minLabelJaccard}`)
  if (Math.abs(itemCountDelta) > t.maxItemCountDelta) reasons.push(`item_count_shift:${itemCountDelta}`)
  const accuracyRegression = reasons.length > 0

  // ── Efficiency ──
  const benefits: string[] = []
  if (tokenReductionPct > 0) benefits.push(`tokens_-${tokenReductionPct}%`)
  if (byteReductionPct > 0) benefits.push(`bytes_-${byteReductionPct}%`)
  if (latencyImprovedPct > 0) benefits.push(`latency_-${latencyImprovedPct}%`)
  const measurableBenefit = benefits.length > 0

  let verdict: OptEvalVerdict
  if (accuracyRegression) verdict = 'accuracy_regression'
  else if (measurableBenefit) { verdict = 'safe_to_promote'; reasons.push(...benefits) }
  else verdict = 'no_regression_no_benefit'

  return {
    itemCountDelta, volumeDeltaPct, truckFractionDeltaPct, confidenceDelta, labelJaccard,
    byteReductionPct, tokenReductionPct, costReductionPct, latencyDeltaMs, latencyImprovedPct,
    accuracyRegression, measurableBenefit, verdict, reasons,
  }
}

export type OptEvalAggregate = {
  samples: number
  regressions: number
  regressionRate: number       // 0..1
  safeToPromote: number
  meanVolumeDeltaPct: number
  meanTokenReductionPct: number
  meanByteReductionPct: number
  meanLatencyImprovedPct: number
  // The promotion recommendation for a whole shadow batch: only recommend enabling
  // when the regression rate is at/below `maxRegressionRate` AND the median token or
  // byte saving is meaningful.
  recommendPromotion: boolean
}

/** Roll a batch of per-photo comparisons into a promotion recommendation for a
 *  dashboard / the owner. Pure: input order does not affect the summary. */
export function aggregateOptEval(
  results: OptEvalResult[],
  opts: { maxRegressionRate?: number; minMeanTokenReductionPct?: number } = {},
): OptEvalAggregate {
  const maxRegressionRate = opts.maxRegressionRate ?? 0.02
  const minMeanTokenReductionPct = opts.minMeanTokenReductionPct ?? 15
  const n = results.length
  const mean = (pick: (r: OptEvalResult) => number) =>
    n === 0 ? 0 : round1(results.reduce((s, r) => s + pick(r), 0) / n)

  const regressions = results.filter(r => r.accuracyRegression).length
  const safeToPromote = results.filter(r => r.verdict === 'safe_to_promote').length
  const regressionRate = n === 0 ? 0 : Math.round((regressions / n) * 1000) / 1000
  const meanTokenReductionPct = mean(r => r.tokenReductionPct)

  return {
    samples: n,
    regressions,
    regressionRate,
    safeToPromote,
    meanVolumeDeltaPct: mean(r => r.volumeDeltaPct),
    meanTokenReductionPct,
    meanByteReductionPct: mean(r => r.byteReductionPct),
    meanLatencyImprovedPct: mean(r => r.latencyImprovedPct),
    recommendPromotion: n > 0 && regressionRate <= maxRegressionRate && meanTokenReductionPct >= minMeanTokenReductionPct,
  }
}
