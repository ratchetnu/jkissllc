// ── Operion Shadow Analytics — PURE evaluation engine ────────────────────────
//
// Turns the persisted V2ShadowJob[] (shadow-store) into the numbers the owner needs to
// decide whether V2 can replace V1 — WITHOUT reading terminal logs. No I/O, no clock
// (callers pass `now`), no randomness → every metric is reproducible + unit-tested. The
// dashboard/API read THROUGH these functions so the UI never re-derives model math.
//
// Scope: read-only over already-stored data. Enables no processing and changes no customer
// behavior; gated by SHADOW_ANALYTICS_ENABLED at the route layer.

import type { V2ShadowJob, V2Comparison } from './shadow-types'

const evaluated = (jobs: V2ShadowJob[]) => jobs.filter((j) => j.comparison && (j.status === 'completed' || j.status === 'manual_review'))
const round = (n: number, dp = 2) => { const f = 10 ** dp; return Math.round(n * f) / f }
const pct = (num: number, den: number) => (den > 0 ? round((num / den) * 100, 1) : 0)
const mean = (xs: number[]) => (xs.length ? round(xs.reduce((s, x) => s + x, 0) / xs.length, 2) : null)

// ── Aggregate analytics ──────────────────────────────────────────────────────
export type ShadowAnalytics = {
  total: number
  evaluated: number
  agreementPct: number          // outcome equivalent|better AND manual-review does not differ
  disagreementPct: number
  autoQuoteRate: number         // V2 shadow auto-quoted (not manual review), of evaluated
  manualReviewRate: number
  avgConfidence: number | null
  confidenceDistribution: { high: number; medium: number; low: number }
  avgQuoteDeltaUsd: number | null
  avgAbsQuoteDeltaUsd: number | null
  manualReviewDiffers: number
  reviewReasonFrequency: Record<string, number>
}

export function computeShadowAnalytics(jobs: V2ShadowJob[]): ShadowAnalytics {
  const ev = evaluated(jobs)
  const conf = { high: 0, medium: 0, low: 0 }
  const reasonFreq: Record<string, number> = {}
  let agree = 0, autoQuote = 0, mrDiffers = 0
  const confScores: number[] = [], deltas: number[] = []
  for (const j of ev) {
    const c = j.comparison as V2Comparison
    if ((c.outcome === 'equivalent' || c.outcome === 'better_than_authoritative') && !c.manualReviewDiffers) agree++
    if (!c.shadowManualReview) autoQuote++
    if (c.manualReviewDiffers) mrDiffers++
    const band = c.shadowConfidenceBand
    if (band === 'high' || band === 'medium' || band === 'low') conf[band]++
    const score = j.result?.estimate?.confidenceScore
    if (typeof score === 'number') confScores.push(score)
    if (typeof c.quoteDeltaUsd === 'number') deltas.push(c.quoteDeltaUsd)
    for (const r of j.result?.estimate?.manualReviewReasons ?? []) reasonFreq[r] = (reasonFreq[r] ?? 0) + 1
  }
  return {
    total: jobs.length,
    evaluated: ev.length,
    agreementPct: pct(agree, ev.length),
    disagreementPct: pct(ev.length - agree, ev.length),
    autoQuoteRate: pct(autoQuote, ev.length),
    manualReviewRate: pct(ev.length - autoQuote, ev.length),
    avgConfidence: mean(confScores),
    confidenceDistribution: conf,
    avgQuoteDeltaUsd: mean(deltas),
    avgAbsQuoteDeltaUsd: mean(deltas.map(Math.abs)),
    manualReviewDiffers: mrDiffers,
    reviewReasonFrequency: reasonFreq,
  }
}

// ── Time-series rollups (Phase 5) — bucketed trend over a window ─────────────
export type RollupWindow = '24h' | '7d' | '30d' | '90d'
export type RollupBucket = { start: number; end: number; count: number; agreementPct: number; autoQuotePct: number; avgConfidence: number | null; avgLatencyMs: number | null }

const HOUR = 3_600_000, DAY = 24 * HOUR
// window → [total span, bucket size]. 24h→hourly, 7d/30d→daily, 90d→weekly.
const WINDOW_SPEC: Record<RollupWindow, [number, number]> = {
  '24h': [DAY, HOUR], '7d': [7 * DAY, DAY], '30d': [30 * DAY, DAY], '90d': [90 * DAY, 7 * DAY],
}

/** Bucket evaluated jobs across a trailing window (or an explicit [from,to]) into a trend series.
 *  Each bucket carries the agreement/auto-quote/confidence/latency for jobs completed within it. */
export function timeSeriesRollup(
  jobs: V2ShadowJob[],
  window: RollupWindow,
  now: number,
  range?: { from?: number; to?: number },
): RollupBucket[] {
  const [span, size] = WINDOW_SPEC[window]
  const to = range?.to ?? now
  const from = range?.from ?? to - span
  const nBuckets = Math.max(1, Math.ceil((to - from) / size))
  const buckets: RollupBucket[] = Array.from({ length: nBuckets }, (_, i) => ({
    start: from + i * size, end: from + (i + 1) * size, count: 0, agreementPct: 0, autoQuotePct: 0, avgConfidence: null, avgLatencyMs: null,
  }))
  const acc = buckets.map(() => ({ agree: 0, auto: 0, conf: [] as number[], lat: [] as number[] }))
  for (const j of evaluated(jobs)) {
    const t = j.completedAt ?? j.updatedAt
    if (t < from || t >= to) continue
    const idx = Math.min(nBuckets - 1, Math.floor((t - from) / size))
    const c = j.comparison as V2Comparison
    buckets[idx].count++
    if ((c.outcome === 'equivalent' || c.outcome === 'better_than_authoritative') && !c.manualReviewDiffers) acc[idx].agree++
    if (!c.shadowManualReview) acc[idx].auto++
    const score = j.result?.estimate?.confidenceScore
    if (typeof score === 'number') acc[idx].conf.push(score)
    if (typeof j.latencyMs === 'number' && j.latencyMs > 0) acc[idx].lat.push(j.latencyMs)
  }
  return buckets.map((b, i) => ({
    ...b,
    agreementPct: pct(acc[i].agree, b.count),
    autoQuotePct: pct(acc[i].auto, b.count),
    avgConfidence: mean(acc[i].conf),
    avgLatencyMs: acc[i].lat.length ? Math.round(acc[i].lat.reduce((s, x) => s + x, 0) / acc[i].lat.length) : null,
  }))
}

// ── FP / FN + disagreement detection (Phase 6) ───────────────────────────────
export type DisagreementKind =
  | 'possible_false_positive'   // V2 reviewed, V1 auto-quoted (V2 may be over-cautious)
  | 'possible_false_negative'   // V2 auto-quoted, V1 reviewed (V2 may have missed a blocker)
  | 'hazard_disagreement'
  | 'specialty_disagreement'
  | 'large_price_difference'
  | 'large_volume_difference'
export type Severity = 'high' | 'medium' | 'low'
export type Disagreement = {
  bookingId: string
  kind: DisagreementKind
  severity: Severity
  detail: string
  quoteDeltaUsd?: number
  at: number
}

export type DisagreementThresholds = { largePriceUsd: number; largePricePct: number }
export const DEFAULT_DISAGREEMENT_THRESHOLDS: DisagreementThresholds = { largePriceUsd: 150, largePricePct: 40 }

const isReview = (d?: string) => d === 'manual_review'
const sevRank: Record<Severity, number> = { high: 3, medium: 2, low: 1 }

export function detectDisagreements(jobs: V2ShadowJob[], t: DisagreementThresholds = DEFAULT_DISAGREEMENT_THRESHOLDS): Disagreement[] {
  const out: Disagreement[] = []
  for (const j of evaluated(jobs)) {
    const c = j.comparison as V2Comparison
    const at = j.completedAt ?? j.updatedAt
    // FP: V2 reviewed but V1 auto-quoted (V2 stricter) — a false positive if V1 was right.
    if (c.shadowManualReview && c.authoritativeDecision && !isReview(c.authoritativeDecision)) {
      out.push({ bookingId: j.bookingId, kind: 'possible_false_positive', severity: 'medium', detail: 'V2 requires review where V1 auto-quotes.', quoteDeltaUsd: c.quoteDeltaUsd, at })
    }
    // FN: V2 auto-quoted but V1 reviewed (V2 missed a blocker) — higher severity.
    if (!c.shadowManualReview && isReview(c.authoritativeDecision)) {
      out.push({ bookingId: j.bookingId, kind: 'possible_false_negative', severity: 'high', detail: 'V2 auto-quotes where V1 requires review.', quoteDeltaUsd: c.quoteDeltaUsd, at })
    }
    // Large price difference.
    const dUsd = Math.abs(c.quoteDeltaUsd ?? 0)
    const dPct = Math.abs(c.quoteDeltaPct ?? 0)
    if (c.authoritativeRecommendedUsd != null && (dUsd >= t.largePriceUsd || dPct >= t.largePricePct)) {
      out.push({ bookingId: j.bookingId, kind: 'large_price_difference', severity: dUsd >= t.largePriceUsd * 2 ? 'high' : 'medium', detail: `V2 price differs by $${Math.round(dUsd)} (${Math.round(dPct)}%).`, quoteDeltaUsd: c.quoteDeltaUsd, at })
    }
  }
  return out.sort((a, b) => sevRank[b.severity] - sevRank[a.severity] || Math.abs(b.quoteDeltaUsd ?? 0) - Math.abs(a.quoteDeltaUsd ?? 0))
}

// ── Model scorecard, per model×prompt version (Phase 7) ──────────────────────
export type ModelScorecard = {
  model: string
  promptVersion?: number
  estimatorVersion?: number
  count: number
  agreementPct: number
  autoQuotePct: number
  manualReviewPct: number
  avgConfidence: number | null
  avgLatencyMs: number | null
  avgCostUsd: number | null
  falseNegatives: number        // V2 auto-quoted where V1 reviewed (the dangerous direction)
}

export function modelScorecards(jobs: V2ShadowJob[]): ModelScorecard[] {
  const groups = new Map<string, V2ShadowJob[]>()
  for (const j of evaluated(jobs)) {
    const key = `${j.model ?? 'unknown'}|${j.promptVersion ?? ''}|${j.estimatorVersion ?? ''}`
    ;(groups.get(key) ?? groups.set(key, []).get(key)!).push(j)
  }
  const cards: ModelScorecard[] = []
  for (const [, gjobs] of groups) {
    const a = computeShadowAnalytics(gjobs)
    const fns = detectDisagreements(gjobs).filter((d) => d.kind === 'possible_false_negative').length
    const lat = gjobs.map((j) => j.latencyMs).filter((x): x is number => typeof x === 'number' && x > 0)
    const cost = gjobs.map((j) => j.estimatedCostUsd).filter((x): x is number => typeof x === 'number')
    cards.push({
      model: gjobs[0].model ?? 'unknown', promptVersion: gjobs[0].promptVersion, estimatorVersion: gjobs[0].estimatorVersion,
      count: gjobs.length, agreementPct: a.agreementPct, autoQuotePct: a.autoQuoteRate, manualReviewPct: a.manualReviewRate,
      avgConfidence: a.avgConfidence, avgLatencyMs: lat.length ? Math.round(lat.reduce((s, x) => s + x, 0) / lat.length) : null,
      avgCostUsd: cost.length ? round(cost.reduce((s, x) => s + x, 0) / cost.length, 4) : null, falseNegatives: fns,
    })
  }
  return cards.sort((x, y) => y.count - x.count)
}

// ── Model promotion readiness (Phase 10) ─────────────────────────────────────
export type ReadinessTier =
  | 'BLOCKED'
  | 'NEEDS_MORE_DATA'
  | 'READY_FOR_EXPANDED_SHADOW'
  | 'READY_FOR_LIMITED_ROLLOUT'
  | 'READY_FOR_CUSTOMER_ROLLOUT'

export type ReadinessThresholds = {
  minSample: number             // below this ⇒ NEEDS_MORE_DATA
  expandedSample: number
  rolloutSample: number
  minAgreementPct: number       // for limited rollout
  customerAgreementPct: number  // for customer rollout
  maxFalseNegatives: number     // any more than this ⇒ BLOCKED (V2 missing real blockers)
}
export const DEFAULT_READINESS_THRESHOLDS: ReadinessThresholds = {
  minSample: 30, expandedSample: 100, rolloutSample: 300,
  minAgreementPct: 85, customerAgreementPct: 95, maxFalseNegatives: 0,
}

export type ReadinessResult = { tier: ReadinessTier; score: number; reasons: string[]; blockers: string[] }

export function readinessScore(
  jobs: V2ShadowJob[],
  thresholds: ReadinessThresholds = DEFAULT_READINESS_THRESHOLDS,
): ReadinessResult {
  const a = computeShadowAnalytics(jobs)
  const fns = detectDisagreements(jobs).filter((d) => d.kind === 'possible_false_negative').length
  const reasons: string[] = [], blockers: string[] = []

  // BLOCKED: V2 auto-quotes where V1 requires review — a safety regression, overrides tier.
  if (fns > thresholds.maxFalseNegatives) {
    blockers.push(`${fns} possible false-negative(s): V2 auto-quotes where V1 reviews.`)
    return { tier: 'BLOCKED', score: 0, reasons, blockers }
  }
  if (a.evaluated < thresholds.minSample) {
    reasons.push(`Only ${a.evaluated}/${thresholds.minSample} evaluated — need more shadow traffic.`)
    return { tier: 'NEEDS_MORE_DATA', score: round(a.evaluated / thresholds.minSample, 2), reasons, blockers }
  }
  let tier: ReadinessTier = 'READY_FOR_EXPANDED_SHADOW'
  reasons.push(`${a.evaluated} evaluated; agreement ${a.agreementPct}%.`)
  if (a.evaluated >= thresholds.rolloutSample && a.agreementPct >= thresholds.customerAgreementPct) {
    tier = 'READY_FOR_CUSTOMER_ROLLOUT'
  } else if (a.evaluated >= thresholds.expandedSample && a.agreementPct >= thresholds.minAgreementPct) {
    tier = 'READY_FOR_LIMITED_ROLLOUT'
  }
  const score = round(Math.min(1, (a.agreementPct / 100) * Math.min(1, a.evaluated / thresholds.rolloutSample)), 2)
  return { tier, score, reasons, blockers }
}
