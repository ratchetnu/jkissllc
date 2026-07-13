// ─────────────────────────────────────────────────────────────────────────────
// Quote decision layer — the SEAM between AI vision and the deterministic engine.
//
// The vision model produces a structured `JunkPhotoAnalysis` (observations only).
// This module feeds the model's truck-fill READING into the existing deterministic
// pricing engine (lib/disposal.priceJob) — the model NEVER invents the final price —
// and then classifies the result into one of three customer outcomes:
//   • instant_quote   — confident, single-load, no hazards, within instant caps
//   • estimate_range  — analyzable but uncertain → show a range, invite review
//   • manual_review   — unusable/hazard/multi-load/over-cap → human prices it
// The booking is ALWAYS saved regardless (the caller persists it) so a lead is
// never lost when the AI is unsure or unavailable.
// ─────────────────────────────────────────────────────────────────────────────

import { priceJob, categoryFor, type DisposalSettings, type DisposalQuote, type CalibrationBias } from '../disposal'
import type { JunkPhotoAnalysis } from '../ai/analysis-schema'

export const PRICING_DECISION_VERSION = 'junk-decision-1'

export type QuoteDecision = 'instant_quote' | 'estimate_range' | 'manual_review'

// Instant-quote guardrails. Configurable in OpsPilot (merged from DisposalSettings
// when present) so ops can tighten/loosen auto-quoting without a deploy.
export type QuoteThresholds = {
  instantConfidenceMin: number   // overall confidence needed for an instant quote
  volumeConfidenceMin: number    // volume confidence needed for an instant quote
  maxInstantLoads: number        // fraction.likely above this → never instant
  maxInstantQuoteUsd: number     // recommended price above this → never instant
  reviewLoads: number            // fraction.likely above this → force manual review
}
export const DEFAULT_QUOTE_THRESHOLDS: QuoteThresholds = {
  instantConfidenceMin: 0.7,
  volumeConfidenceMin: 0.6,
  maxInstantLoads: 1,
  maxInstantQuoteUsd: 1200,
  reviewLoads: 2,
}

// A compact, auditable pricing breakdown built FROM the deterministic engine's
// output. `costLines` is the engine's itemized build-up (source of truth for ops).
export type PricingBreakdown = {
  pricingVersion: string
  minimumPriceApplied: boolean
  disposalTrips: number
  truckLoads: number
  fillPct: number
  laborCents: number
  disposalCents: number
  costBasisCents: number
  sellingPriceCents: number
  estimateRange: { minimumUsd: number; recommendedUsd: number; maximumUsd: number }
  costLines: { label: string; cents: number }[]
  assumptions: string[]
  confidence: DisposalQuote['confidence']
}

export type QuoteDecisionResult = {
  decision: QuoteDecision
  quote: DisposalQuote
  breakdown: PricingBreakdown
  reviewReasons: string[]
  // The single number we show the customer (the protected floor is `low`).
  recommendedUsd: number
  rangeUsd: { low: number; high: number }
}

const round5 = (n: number) => Math.round(n / 5) * 5

// Map an AI truck-fill fraction to the nearest named load bucket so priceJob
// treats it as a KNOWN load (+ photoAdjusted → high confidence). The fraction
// still drives the actual math via fillPctOverride; the bucket only informs the
// engine's confidence/labeling.
function loadBucket(fraction: number): string {
  if (fraction <= 0.2) return 'few-items'
  if (fraction <= 0.42) return 'quarter'
  if (fraction <= 0.66) return 'half'
  if (fraction <= 0.9) return 'three-quarter'
  if (fraction <= 1.4) return 'full'
  return 'multiple'
}

export function buildBreakdown(q: DisposalQuote): PricingBreakdown {
  const recommended = round5((q.low + q.high) / 2)
  return {
    pricingVersion: PRICING_DECISION_VERSION,
    minimumPriceApplied: q.low * 100 <= q.sellingPriceCents + 500,
    disposalTrips: q.landfillTrips,
    truckLoads: q.truckLoads,
    fillPct: q.fillPct,
    laborCents: q.laborCents,
    disposalCents: q.disposalCents,
    costBasisCents: q.costBasisCents,
    sellingPriceCents: q.sellingPriceCents,
    estimateRange: { minimumUsd: q.low, recommendedUsd: Math.max(q.low, recommended), maximumUsd: q.high },
    costLines: q.breakdown,
    assumptions: q.assumptions,
    confidence: q.confidence,
  }
}

export function decideQuote(opts: {
  analysis: JunkPhotoAnalysis
  settings: DisposalSettings
  calibration?: CalibrationBias
  serviceType: string
  debris?: string
  thresholds?: Partial<QuoteThresholds>
}): QuoteDecisionResult {
  const t: QuoteThresholds = { ...DEFAULT_QUOTE_THRESHOLDS, ...(opts.thresholds ?? {}) }
  const a = opts.analysis
  const c = a.detectedConditions

  // Run the deterministic engine, seeding it with the model's truck-fill reading.
  const category = categoryFor(opts.serviceType, opts.debris)
  const hasRead = a.normalizedItems.length > 0 && a.estimatedTruckLoadFraction.likely > 0
  const quote = priceJob({
    settings: opts.settings,
    category,
    loadSize: hasRead ? loadBucket(a.estimatedTruckLoadFraction.likely) : undefined,
    fillPctOverride: hasRead ? a.estimatedTruckLoadFraction.likely : undefined,
    photoAdjusted: hasRead && !a.reviewRequired,
    calibration: opts.calibration,
  })
  const breakdown = buildBreakdown(quote)
  const recommendedUsd = breakdown.estimateRange.recommendedUsd

  // Reasons accumulate from the analysis + pricing + guardrails.
  const reasons = new Set<string>(a.reviewReasons)
  const hazard = c.hazardousMaterialPossible || c.paintOrChemicalPossible
  const dense = c.concreteOrSoilPossible
  const loads = a.estimatedTruckLoadFraction.likely
  const noItems = a.normalizedItems.length === 0
  const unusable = a.photoObservations.length > 0 && a.photoObservations.every(p => p.imageQuality === 'unusable')

  // ── Hard stops → manual review (booking still saved by caller). ────────────
  if (noItems) reasons.add('No items could be identified from the photos.')
  if (unusable) reasons.add('Photos were unusable.')
  if (hazard) reasons.add('Possible hazardous materials — needs human confirmation.')
  if (dense) reasons.add('Possible dense debris (concrete/soil) — weight risk.')
  if (loads > t.reviewLoads) reasons.add(`Job may need ${Math.ceil(loads)} truckloads.`)
  if (recommendedUsd > t.maxInstantQuoteUsd * 1.5) reasons.add('Estimate exceeds the automatic-quote limit.')

  const mustReview = noItems || unusable || hazard || dense || loads > t.reviewLoads || recommendedUsd > t.maxInstantQuoteUsd * 1.5

  // ── Range (analyzable but not instant). ────────────────────────────────────
  const rangeOnly =
    a.reviewRequired ||
    quote.requiresReview ||
    a.confidence.overall < t.instantConfidenceMin ||
    a.confidence.volume < t.volumeConfidenceMin ||
    loads > t.maxInstantLoads ||
    recommendedUsd > t.maxInstantQuoteUsd

  let decision: QuoteDecision
  if (mustReview) decision = 'manual_review'
  else if (rangeOnly) decision = 'estimate_range'
  else decision = 'instant_quote'

  return {
    decision,
    quote,
    breakdown,
    reviewReasons: Array.from(reasons),
    recommendedUsd,
    rangeUsd: { low: quote.low, high: quote.high },
  }
}
