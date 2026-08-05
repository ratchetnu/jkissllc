// ─────────────────────────────────────────────────────────────────────────────
// Gold / Silver separation and cost control.
//
// The single most important rule in this file: a Gold number and a Silver number
// are never added together. Combining them produces a figure that looks like
// accuracy and is not — Silver labels come from a model that never measured the
// room, so pooling them into an accuracy claim launders correlated bias into
// what reads as evidence.
//
// `tierReport()` therefore returns THREE separate blocks and has no combined
// field, and `assertClaimSupported()` throws rather than let a caller cite the
// wrong tier for a claim.
// ─────────────────────────────────────────────────────────────────────────────

import { TIER_CLAIMS, tierSupportsClaim, type DatasetTier } from './types'
import type { JobType, ManifestEntry } from '../schema'

export type TierCounts = {
  tier: DatasetTier
  split: 'development' | 'holdout'
  count: number
  categories: string[]
  difficulties: string[]
}

/**
 * A label is GOLD only when a human verified it. Machine consensus is SILVER
 * however confident it was. Promotion is a human action and never a side effect.
 */
export function tierOf(e: ManifestEntry & { curationTier?: DatasetTier }): DatasetTier {
  if (e.labelStatus === 'verified' && e.reviewStatus === 'approved') return 'gold'
  if (e.curationTier === 'silver') return 'silver'
  return 'candidate'
}

export type TierReport = {
  jobType: JobType
  goldDevelopment: TierCounts
  goldHoldout: TierCounts
  silverDevelopment: TierCounts
  /** Deliberately absent: any combined total. See the file header. */
  note: string
}

function counts(rows: ManifestEntry[], tier: DatasetTier, split: 'development' | 'holdout'): TierCounts {
  const sel = rows.filter(e => e.split === split)
  return {
    tier, split, count: sel.length,
    categories: [...new Set(sel.map(e => e.category))].sort(),
    difficulties: [...new Set(sel.map(e => e.difficulty).filter(Boolean) as string[])].sort(),
  }
}

/** Three separate blocks, per lane. There is no fourth, combined block. */
export function tierReport(
  entries: Array<ManifestEntry & { curationTier?: DatasetTier }>, jobType: JobType,
): TierReport {
  const lane = entries.filter(e => e.jobType === jobType)
  const gold = lane.filter(e => tierOf(e) === 'gold')
  const silver = lane.filter(e => tierOf(e) === 'silver')
  return {
    jobType,
    goldDevelopment: counts(gold, 'gold', 'development'),
    goldHoldout: counts(gold, 'gold', 'holdout'),
    silverDevelopment: counts(silver, 'silver', 'development'),
    note: 'Gold and Silver are reported separately and must never be summed into one accuracy figure.',
  }
}

/** Throws when a caller cites a tier for a claim that tier cannot support. */
export function assertClaimSupported(tier: DatasetTier, claim: string): void {
  if (!tierSupportsClaim(tier, claim)) {
    throw new Error(
      `${tier} labels cannot support "${claim}". ${tier === 'silver'
        ? 'Silver is model-generated: two models agreeing on volume measures correlated bias, not accuracy. Use Gold holdout.'
        : `Supported: ${TIER_CLAIMS[tier].join(', ') || '(none)'}`}`,
    )
  }
}

// ── Cost control ────────────────────────────────────────────────────────────

export type CostEstimate = {
  candidates: number
  calls: number
  estimatedUsd: number
  withinCeiling: boolean
  ceilingUsd: number
  perModel: Record<string, { calls: number; usd: number }>
}

/**
 * One label call plus one verifier call per candidate. An adjudicator runs ONLY
 * on disagreement — never unconditionally, which is the difference between a
 * bounded run and one that quietly triples.
 */
export function estimateCost(opts: {
  candidates: number
  labelerModel: string
  verifierModel: string
  usdPerCall: Record<string, number>
  expectedDisagreementRate?: number
  adjudicatorModel?: string
  ceilingUsd: number
}): CostEstimate {
  const { candidates, labelerModel, verifierModel, usdPerCall, ceilingUsd } = opts
  const rate = Math.min(1, Math.max(0, opts.expectedDisagreementRate ?? 0))
  const perModel: Record<string, { calls: number; usd: number }> = {}
  const add = (model: string, calls: number) => {
    const usd = calls * (usdPerCall[model] ?? 0)
    perModel[model] = { calls: (perModel[model]?.calls ?? 0) + calls, usd: (perModel[model]?.usd ?? 0) + usd }
  }
  add(labelerModel, candidates)
  add(verifierModel, candidates)
  if (opts.adjudicatorModel && rate > 0) add(opts.adjudicatorModel, Math.ceil(candidates * rate))

  const calls = Object.values(perModel).reduce((s, m) => s + m.calls, 0)
  const estimatedUsd = Object.values(perModel).reduce((s, m) => s + m.usd, 0)
  return { candidates, calls, estimatedUsd, withinCeiling: estimatedUsd <= ceilingUsd, ceilingUsd, perModel }
}

/** Cache key: a candidate is reprocessed only when something that matters changed. */
export function cacheKey(parts: {
  imageSha256: string; model: string; promptVersion: string; schemaVersion: number
}): string {
  return [parts.imageSha256, parts.model, parts.promptVersion, `s${parts.schemaVersion}`].join('|')
}

/** Transient failures may retry; credit, auth and licence failures never do. */
export function isRetryable(kind: string): boolean {
  return ['timeout', 'rate_limit', 'network', 'server_error'].includes(kind)
}
