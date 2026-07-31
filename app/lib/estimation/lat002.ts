// ─────────────────────────────────────────────────────────────────────────────
// LAT-002 — the photo-estimate latency experiment.
//
// WHAT LAT-002 IS. An EXPERIMENT IDENTIFIER, not a service level objective. The
// roadmap names "LAT-002" as the thing Preview-only flags gate, but no latency
// threshold is defined anywhere in this repo, and inventing one would create a
// Production SLO nobody agreed to — a build that starts failing because a provider
// had a slow afternoon. So LAT-002 is defined here the way the codebase already
// defines its other comparison: a paired A/B measurement with a verdict.
//
// The asymmetry is deliberate and is the whole design:
//
//   • LATENCY, TOKENS and COST are MEASURED and reported. They never fail the
//     experiment. A candidate that is slower is reported as slower; that is a
//     result, not an error.
//   • QUOTE, CONFIDENCE, REVIEW RATE and SCHEMA VALIDITY are GUARDRAILS. A
//     candidate that moves any of them beyond tolerance is a `parity_regression`
//     and is never promotable, however fast it is.
//
// That mirrors `image-opt-eval.ts`, which gates an image optimization on accuracy
// and reports the saving separately, and it satisfies the sprint objective —
// "reduce latency WITHOUT changing schema, deterministic pricing, confidence, or
// manual-review behavior" — by making the "without" the only pass/fail axis.
//
// PURE + DETERMINISTIC + SIDE-EFFECT-FREE — no env, no clock, no I/O, never throws.
// Percentiles come from `ai/analytics.latencyStats` so this report and the AI
// Control Center cannot disagree about what p95 means.
// ─────────────────────────────────────────────────────────────────────────────
import { latencyStats, type LatencyStats } from '../ai/analytics'

export const LAT002_ID = 'LAT-002'
export const LAT002_VERSION = 1

/** One arm's outcome for ONE booking. Both arms analyze the SAME photos. */
export type Lat002Sample = {
  latencyMs: number
  outputTokens: number
  costUsd: number
  /** The quote this arm produced, in dollars. Pricing parity is judged on this. */
  quoteUsd: number
  /** 0..1 model self-confidence. */
  confidence: number
  /** Did this arm route the booking to manual review? */
  manualReview: boolean
  /** Did this arm's response satisfy the estimate schema? */
  schemaValid: boolean
}

/** The same booking analyzed by both arms. Pairing is what makes the comparison
 *  meaningful — unpaired arms would compare different photos. */
export type Lat002Pair = {
  bookingId: string
  baseline: Lat002Sample
  candidate: Lat002Sample
}

export type Lat002Thresholds = {
  /** Per-booking quote drift tolerated before that pair counts as a mismatch. */
  maxQuoteDeltaPct: number
  /** Share of pairs (0..1) allowed to breach the quote tolerance. */
  maxQuoteMismatchRate: number
  /** Max mean absolute confidence drop (0..1). */
  maxConfidenceDrop: number
  /** Max absolute increase in manual-review rate (0..1). */
  maxReviewRateIncrease: number
  /** Minimum pairs before a verdict is meaningful at all. */
  minPairs: number
}

// Conservative. A candidate has to be clearly harmless, not merely not-obviously-harmful.
export const DEFAULT_LAT002_THRESHOLDS: Lat002Thresholds = {
  maxQuoteDeltaPct: 5,
  maxQuoteMismatchRate: 0.05,
  maxConfidenceDrop: 0.05,
  maxReviewRateIncrease: 0.02,
  minPairs: 20,
}

export type Lat002Verdict =
  | 'safe_to_promote'           // parity held AND the candidate is measurably faster
  | 'no_regression_no_benefit'  // parity held but nothing was actually saved
  | 'parity_regression'         // a guardrail moved — DO NOT promote, whatever the speed
  | 'insufficient_samples'      // too few pairs to claim anything

export type ArmAggregate = {
  latency: LatencyStats
  totalOutputTokens: number
  meanOutputTokens: number
  totalCostUsd: number
  meanCostUsd: number
  meanConfidence: number
  reviewRate: number
  schemaValidRate: number
}

export type Lat002Report = {
  experiment: typeof LAT002_ID
  version: number
  pairs: number
  baseline: ArmAggregate
  candidate: ArmAggregate
  /** Measured, never pass/fail. Positive = the candidate is better. */
  measured: {
    latencyP50ImprovedPct: number
    latencyP95ImprovedPct: number
    meanLatencyDeltaMs: number
    outputTokenReductionPct: number
    costReductionPct: number
  }
  /** Pass/fail. These are what the sprint objective forbids moving. */
  guardrails: {
    quoteMismatchRate: number
    worstQuoteDeltaPct: number
    confidenceDrop: number
    reviewRateDelta: number
    candidateSchemaInvalid: number
    breached: string[]
  }
  verdict: Lat002Verdict
  reasons: string[]
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round4 = (n: number) => Math.round(n * 10_000) / 10_000
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0)
/**
 * Percentage improvement of `to` over `from`. SIGNED on purpose: a regression comes
 * back negative rather than floored to 0, because "no change" and "half as fast"
 * must not render identically. 0 when `from` is 0 — there is nothing to improve on.
 */
const gainPct = (from: number, to: number): number => (from <= 0 ? 0 : ((from - to) / from) * 100)
const absPct = (from: number, to: number): number =>
  from === 0 ? (to === 0 ? 0 : 100) : Math.abs((to - from) / from) * 100

function aggregate(samples: Lat002Sample[]): ArmAggregate {
  return {
    latency: latencyStats(samples.map(s => s.latencyMs)),
    totalOutputTokens: sum(samples.map(s => s.outputTokens)),
    meanOutputTokens: round1(mean(samples.map(s => s.outputTokens))),
    totalCostUsd: round4(sum(samples.map(s => s.costUsd))),
    meanCostUsd: round4(mean(samples.map(s => s.costUsd))),
    meanConfidence: round4(mean(samples.map(s => s.confidence))),
    reviewRate: round4(samples.length ? samples.filter(s => s.manualReview).length / samples.length : 0),
    schemaValidRate: round4(samples.length ? samples.filter(s => s.schemaValid).length / samples.length : 0),
  }
}

/**
 * Evaluate one LAT-002 experiment from its paired samples.
 *
 * Pairs whose ids do not match are not silently tolerated — the caller builds the
 * pairs, and a mismatch there means the two arms saw different work.
 */
export function evaluateLat002(
  pairs: Lat002Pair[],
  thresholds: Partial<Lat002Thresholds> = {},
): Lat002Report {
  const t: Lat002Thresholds = { ...DEFAULT_LAT002_THRESHOLDS, ...thresholds }
  const baseline = aggregate(pairs.map(p => p.baseline))
  const candidate = aggregate(pairs.map(p => p.candidate))

  const measured = {
    latencyP50ImprovedPct: round1(gainPct(baseline.latency.p50, candidate.latency.p50)),
    latencyP95ImprovedPct: round1(gainPct(baseline.latency.p95, candidate.latency.p95)),
    meanLatencyDeltaMs: Math.round(candidate.latency.avg - baseline.latency.avg),
    outputTokenReductionPct: round1(gainPct(baseline.totalOutputTokens, candidate.totalOutputTokens)),
    costReductionPct: round1(gainPct(baseline.totalCostUsd, candidate.totalCostUsd)),
  }

  // ── Guardrails ──
  const quoteDeltas = pairs.map(p => absPct(p.baseline.quoteUsd, p.candidate.quoteUsd))
  const mismatches = quoteDeltas.filter(d => d > t.maxQuoteDeltaPct).length
  const quoteMismatchRate = round4(pairs.length ? mismatches / pairs.length : 0)
  const worstQuoteDeltaPct = round1(quoteDeltas.length ? Math.max(...quoteDeltas) : 0)
  // Signed so a DROP is positive — a candidate that is more confident never breaches.
  const confidenceDrop = round4(baseline.meanConfidence - candidate.meanConfidence)
  const reviewRateDelta = round4(candidate.reviewRate - baseline.reviewRate)
  const candidateSchemaInvalid = pairs.filter(p => !p.candidate.schemaValid).length

  const breached: string[] = []
  if (quoteMismatchRate > t.maxQuoteMismatchRate) {
    breached.push(`quote_mismatch_rate:${quoteMismatchRate}>${t.maxQuoteMismatchRate}`)
  }
  if (confidenceDrop > t.maxConfidenceDrop) {
    breached.push(`confidence_drop:${confidenceDrop}>${t.maxConfidenceDrop}`)
  }
  if (reviewRateDelta > t.maxReviewRateIncrease) {
    breached.push(`review_rate_increase:${reviewRateDelta}>${t.maxReviewRateIncrease}`)
  }
  // Schema validity is absolute: the sprint objective says the schema does not
  // change, so ONE invalid candidate response is a regression, not a rate.
  if (candidateSchemaInvalid > 0) {
    breached.push(`schema_invalid:${candidateSchemaInvalid}`)
  }

  const reasons: string[] = [...breached]
  let verdict: Lat002Verdict
  if (pairs.length < t.minPairs) {
    // Reported BEFORE the guardrails so a tiny sample can never read as "safe".
    verdict = 'insufficient_samples'
    reasons.unshift(`pairs:${pairs.length}<${t.minPairs}`)
  } else if (breached.length > 0) {
    verdict = 'parity_regression'
  } else if (measured.latencyP50ImprovedPct > 0 || measured.latencyP95ImprovedPct > 0) {
    verdict = 'safe_to_promote'
    reasons.push(`latency_p50:${measured.latencyP50ImprovedPct}%`, `latency_p95:${measured.latencyP95ImprovedPct}%`)
  } else {
    verdict = 'no_regression_no_benefit'
    reasons.push('no_latency_improvement')
  }

  return {
    experiment: LAT002_ID,
    version: LAT002_VERSION,
    pairs: pairs.length,
    baseline,
    candidate,
    measured,
    guardrails: {
      quoteMismatchRate, worstQuoteDeltaPct, confidenceDrop, reviewRateDelta,
      candidateSchemaInvalid, breached,
    },
    verdict,
    reasons,
  }
}
