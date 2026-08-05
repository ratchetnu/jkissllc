// ─────────────────────────────────────────────────────────────────────────────
// Moving decision layer — the seam between the moving vision read and the money.
//
// Four outcomes, one of which the junk lane does not have:
//   • instant_quote      — photos adequate, required facts present, confident
//   • estimate_range     — usable inventory, real uncertainty → show a range
//   • needs_information  — a NON-VISUAL input is missing (destination, distance,
//                          stairs, elevator). Not the model's fault and not fixable
//                          by better photos: we must ask.
//   • manual_review      — oversized, complex, unsafe, or low confidence
//
// `needs_information` exists because the alternative is inventing the missing
// number. A move priced without a destination is not an estimate, it is a guess
// wearing one — and the customer cannot tell the difference.
// ─────────────────────────────────────────────────────────────────────────────

import type { MovingPhotoAnalysis } from '../ai/analysis-schema-moving'
import { priceMove, type MovingSettings, type MovingJobFacts, type MovingQuote } from './moving-quote'

export const MOVING_DECISION_VERSION = 'moving-decision-1'

export type MovingDecision = 'instant_quote' | 'estimate_range' | 'needs_information' | 'manual_review'

export type MovingThresholds = {
  instantConfidenceMin: number
  inventoryConfidenceMin: number
  maxInstantTruckFraction: number   // above this it is a multi-truck move → human
  maxInstantQuoteUsd: number
  reviewTruckFraction: number
}

export const DEFAULT_MOVING_THRESHOLDS: MovingThresholds = {
  instantConfidenceMin: 0.7,
  inventoryConfidenceMin: 0.65,
  maxInstantTruckFraction: 1,
  maxInstantQuoteUsd: 2500,
  reviewTruckFraction: 2,
}

export type MovingDecisionResult = {
  decision: MovingDecision
  quote: MovingQuote
  reviewReasons: string[]
  missingInformation: string[]
  recommendedUsd: number
  rangeUsd: { low: number; high: number }
  priced: boolean
  decisionVersion: string
}

/**
 * Facts that must be known before a move can be quoted as a number rather than a
 * range. Each is non-visual on purpose — no photo can supply it.
 */
export function missingRequiredFacts(facts: MovingJobFacts | undefined, analysis: MovingPhotoAnalysis): string[] {
  const f = facts ?? {}
  const missing: string[] = []
  if (!f.destinationKnown) missing.push('Destination address')
  if (f.travelMiles == null) missing.push('Travel distance between addresses')
  // Stairs matter enough to ask when the photos could not settle them. A visible
  // staircase answers the question; an indoor shot of a living room does not.
  if (f.originStairsFlights == null && f.destinationStairsFlights == null && !analysis.access.stairsVisible) {
    missing.push('Stairs or elevator at either address')
  }
  return missing
}

export function decideMovingQuote(opts: {
  analysis: MovingPhotoAnalysis
  settings: MovingSettings
  facts?: MovingJobFacts
  thresholds?: Partial<MovingThresholds>
}): MovingDecisionResult {
  const t: MovingThresholds = { ...DEFAULT_MOVING_THRESHOLDS, ...(opts.thresholds ?? {}) }
  const a = opts.analysis
  const quote = priceMove({ settings: opts.settings, analysis: a, facts: opts.facts })

  const reasons = new Set<string>(a.reviewReasons)
  // Anything the model itself could not resolve, plus the non-visual gaps.
  const missing = Array.from(new Set([...a.missingInformation, ...missingRequiredFacts(opts.facts, a)]))

  const noItems = a.normalizedItems.length === 0
  const unusable = a.photoObservations.length > 0 && a.photoObservations.every(p => p.imageQuality === 'unusable')
  const fraction = a.estimatedTruckSpaceFraction.likely
  const oversized = a.access.oversizedItemPresent

  if (noItems) reasons.add('No movable items could be identified from the photos.')
  if (unusable) reasons.add('Photos were unusable.')
  if (fraction > t.reviewTruckFraction) reasons.add(`This move may need ${Math.ceil(fraction)} truckloads.`)
  if (oversized) reasons.add('An oversized item (piano, safe, or similar) needs a person to plan the handling.')
  if (a.reviewRequired) reasons.add('The photo analysis flagged this move for review.')

  const mustReview =
    noItems || unusable || a.reviewRequired || oversized ||
    fraction > t.reviewTruckFraction ||
    quote.recommendedUsd > t.maxInstantQuoteUsd * 1.5

  const rangeOnly =
    a.confidence.overall < t.instantConfidenceMin ||
    a.confidence.inventory < t.inventoryConfidenceMin ||
    fraction > t.maxInstantTruckFraction ||
    quote.recommendedUsd > t.maxInstantQuoteUsd

  // Order matters. Review beats everything (safety and complexity), then a missing
  // non-visual fact, then ordinary uncertainty. Asking for a destination is more
  // useful to the customer than a range built without one.
  let decision: MovingDecision
  if (mustReview) decision = 'manual_review'
  else if (missing.length > 0) decision = 'needs_information'
  else if (rangeOnly) decision = 'estimate_range'
  else decision = 'instant_quote'

  // A move we cannot commit to is shown as a bounded range, never as a single
  // confident number — and never as $0, which would read as "free".
  const priced = decision === 'instant_quote' || decision === 'estimate_range' || decision === 'needs_information'

  return {
    decision,
    quote,
    reviewReasons: Array.from(reasons),
    missingInformation: missing,
    recommendedUsd: decision === 'instant_quote' ? quote.recommendedUsd : 0,
    rangeUsd: priced && !mustReview ? { low: quote.low, high: quote.high } : { low: 0, high: 0 },
    priced: priced && !mustReview,
    decisionVersion: MOVING_DECISION_VERSION,
  }
}
