// ── V2 Shadow — PURE comparison + outcome classification (Phase 11) ──────────
//
// Compares a shadow V2 estimate against the authoritative estimate and, when present,
// the owner's ground truth. Pure: same inputs → same V2Comparison. Never promotes V2
// and never mutates anything — it only measures.

import type { EstimationResultV2 } from './v2-bridge'
import type { V2Comparison, V2ComparisonOutcome, V2GroundTruth } from './shadow-types'

export const V2_COMPARISON_VERSION = 1

export type AuthoritativeBaseline = { recommendedUsd?: number; decision?: string }

const round2 = (n: number) => Math.round(n * 100) / 100
const centsToUsd = (c: number) => round2(c / 100)

// Owner may type the tier as a key ("three_eighths") or a label ("3/8 load"); match either.
function tierMatches(ownerTier: string, key?: string, label?: string): boolean | null {
  if (key == null && label == null) return null
  const norm = (s: string) => s.trim().toLowerCase()
  const o = norm(ownerTier)
  return o === norm(key ?? '') || o === norm(label ?? '')
}

// Within this fraction of the authoritative quote, the two are "equivalent".
const EQUIVALENT_BAND = 0.1   // ±10%
// Ground-truth accuracy bands (fraction of the actual quote).
const GT_GOOD_BAND = 0.15     // within 15% of owner's actual → good
const GT_POOR_BAND = 0.35     // beyond 35% → clearly worse

export function buildV2Comparison(
  shadow: EstimationResultV2,
  authoritative?: AuthoritativeBaseline,
  groundTruth?: V2GroundTruth,
): V2Comparison {
  const shadowRecommendedUsd = centsToUsd(shadow.pricing.recommendedCents)
  const shadowManualReview = !!shadow.manualReviewRequired
  const shadowDecision = shadowManualReview ? 'manual_review' : 'auto'

  const authUsd = authoritative?.recommendedUsd
  const hasAuth = authUsd != null && Number.isFinite(authUsd)
  const quoteDeltaUsd = hasAuth ? round2(shadowRecommendedUsd - (authUsd as number)) : undefined
  const quoteDeltaPct = !hasAuth || authUsd === 0
    ? (hasAuth ? null : undefined)
    : round2(((shadowRecommendedUsd - (authUsd as number)) / (authUsd as number)) * 100)

  const authManualReview = authoritative?.decision === 'manual_review'
  const manualReviewDiffers = hasAuth || authoritative?.decision != null
    ? shadowManualReview !== authManualReview
    : undefined

  // vs owner ground truth (the real yardstick, when captured)
  const gtQuote = groundTruth?.actualQuoteUsd ?? groundTruth?.actualFinalUsd
  const hasGt = gtQuote != null && Number.isFinite(gtQuote)
  const vsGroundTruthQuoteDeltaUsd = hasGt ? round2(shadowRecommendedUsd - (gtQuote as number)) : (groundTruth ? null : undefined)
  const tierKey = shadow.v2?.loadTier?.key
  const tierLabel = shadow.v2?.loadTier?.label
  const vsGroundTruthTierMatches = groundTruth?.correctLoadTier != null
    ? tierMatches(groundTruth.correctLoadTier, tierKey, tierLabel)
    : (groundTruth ? null : undefined)

  const { outcome, reasons } = classifyOutcome({
    hasAuth, quoteDeltaPct: quoteDeltaPct ?? null,
    hasGt, gtQuote: hasGt ? (gtQuote as number) : undefined, shadowRecommendedUsd,
    vsGroundTruthTierMatches: vsGroundTruthTierMatches ?? null,
    manualReviewDiffers,
  })

  return {
    comparisonVersion: V2_COMPARISON_VERSION,
    authoritativeRecommendedUsd: hasAuth ? round2(authUsd as number) : undefined,
    authoritativeDecision: authoritative?.decision,
    shadowRecommendedUsd,
    shadowDecision,
    shadowLoadTier: tierLabel,
    shadowLoadTierKey: tierKey,
    shadowTruckPct: shadow.v2?.truckFraction?.expected != null ? round2(shadow.v2.truckFraction.expected * 100) : undefined,
    shadowConfidenceBand: shadow.v2?.confidence?.band,
    shadowManualReview,
    shadowInventoryCount: Array.isArray(shadow.inventory) ? shadow.inventory.length : 0,
    quoteDeltaUsd,
    quoteDeltaPct,
    manualReviewDiffers,
    vsGroundTruthQuoteDeltaUsd,
    vsGroundTruthTierMatches,
    outcome,
    outcomeReasons: reasons,
  }
}

function classifyOutcome(x: {
  hasAuth: boolean
  quoteDeltaPct: number | null
  hasGt: boolean
  gtQuote?: number
  shadowRecommendedUsd: number
  vsGroundTruthTierMatches: boolean | null
  manualReviewDiffers?: boolean
}): { outcome: V2ComparisonOutcome; reasons: string[] } {
  const reasons: string[] = []

  // Ground truth is the real judge when we have it.
  if (x.hasGt && x.gtQuote != null && x.gtQuote > 0) {
    const err = Math.abs(x.shadowRecommendedUsd - x.gtQuote) / x.gtQuote
    reasons.push(`shadow is ${round2(err * 100)}% from owner's actual`)
    if (x.vsGroundTruthTierMatches === true) reasons.push('load tier matches owner')
    if (x.vsGroundTruthTierMatches === false) reasons.push('load tier differs from owner')
    if (err <= GT_GOOD_BAND) return { outcome: 'better_than_authoritative', reasons }
    if (err >= GT_POOR_BAND) return { outcome: 'worse', reasons }
    return { outcome: 'equivalent', reasons }
  }

  // No ground truth → we can only say how it compares to the current estimator, which
  // is itself unverified. So the strongest honest verdict is "needs ground truth".
  if (!x.hasAuth || x.quoteDeltaPct == null) {
    reasons.push('no authoritative baseline to compare')
    return { outcome: 'needs_ground_truth', reasons }
  }
  const absPct = Math.abs(x.quoteDeltaPct)
  reasons.push(`shadow is ${x.quoteDeltaPct > 0 ? '+' : ''}${x.quoteDeltaPct}% vs authoritative`)
  if (x.manualReviewDiffers) reasons.push('manual-review decision differs')
  if (absPct <= EQUIVALENT_BAND * 100) {
    reasons.push('within equivalence band, but unverified')
    return { outcome: 'needs_ground_truth', reasons }
  }
  reasons.push('diverges from authoritative — owner review needed to judge')
  return { outcome: 'inconclusive', reasons }
}
