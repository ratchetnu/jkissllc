// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — PRICING EXPLANATION.
//
// This module invents NO prices. Every number here comes from the existing
// deterministic pricing engine: the engine runs `decideQuote` (which calls
// `priceJob`) and hands us the resulting `QuoteDecisionResult`. We TRANSFORM its
// itemized `breakdown.costLines` into human-readable adjustments, and pass through
// the base charge, minimum-charge flag, margin, recommended price, range, and
// assumptions verbatim from that breakdown. Pure — no I/O, no math beyond
// re-labeling and summation of the engine's own cents.
// ─────────────────────────────────────────────────────────────────────────────

import type { QuoteDecisionResult } from '../pricing/quote-decision'
import type { VolumeEstimate, WeightEstimate, ComplexityEstimate, PricingExplanation, PricingAdjustment } from './types'

// A human "why" for each of the engine's cost-line labels. Matched by keyword so a
// version bump to the exact label text still resolves a sensible reason.
function reasonFor(label: string): string {
  const l = label.toLowerCase()
  if (l.includes('on-site labor')) return 'Crew time to load the items on site.'
  if (l.includes('travel')) return 'Fuel and drive time to reach the job.'
  if (l.includes('equipment')) return 'Truck wear and operating cost for the load.'
  if (l.includes('disposal')) return 'Landfill tipping fees — charged for every dump trip.'
  if (l.includes('dump-trip labor')) return 'Crew time driving to and unloading at the landfill.'
  if (l.includes('dump-trip fuel')) return 'Fuel and tolls for the dump run(s).'
  return 'Component of the itemized job cost.'
}

export function explainPricing(
  volume: VolumeEstimate,
  weight: WeightEstimate,
  complexity: ComplexityEstimate,
  decisionResult: QuoteDecisionResult,
): PricingExplanation {
  const b = decisionResult.breakdown
  const lines = Array.isArray(b.costLines) ? b.costLines : []

  // Base charge = the on-site loading labor line (the structural floor of the job);
  // every other engine cost line becomes an explained adjustment on top of it.
  const baseLine = lines.find((l) => l.label.toLowerCase().includes('on-site labor'))
  const baseChargeCents = baseLine ? baseLine.cents : 0

  const adjustments: PricingAdjustment[] = lines
    .filter((l) => l !== baseLine)
    .map((l) => ({ label: l.label, cents: l.cents, reason: reasonFor(l.label) }))

  // Margin the engine builds in = selling price floor − summed cost basis.
  const marginEstimateCents = Math.max(0, b.sellingPriceCents - b.costBasisCents)

  return {
    pricingRuleVersion: b.pricingVersion,
    baseChargeCents,
    adjustments,
    minimumChargeApplied: b.minimumPriceApplied,
    marginEstimateCents,
    recommendedCents: Math.round(b.estimateRange.recommendedUsd * 100),
    rangeCents: {
      low: Math.round(b.estimateRange.minimumUsd * 100),
      high: Math.round(b.estimateRange.maximumUsd * 100),
    },
    assumptions: Array.isArray(b.assumptions) ? [...b.assumptions] : [],
  }
}
