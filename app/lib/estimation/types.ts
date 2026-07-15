// ── Enterprise deterministic estimation — the shared contract ────────────────
//
// The estimation engine turns a structured inventory (from AI vision OBSERVATIONS)
// into deterministic operational + financial estimates. The AI never produces
// volume, weight, or price directly — it produces the itemized inventory, and
// THIS engine computes everything downstream from the governed taxonomy + the
// existing deterministic pricing engine (lib/pricing/quote-decision.ts).
//
// Everything here is types only — pure, dependency-free, so both the engine
// (lib/estimation/engine.ts) and the shadow/metrics/admin consumers share one
// vocabulary. Versioned so every estimate is attributable + auditable.

import type { InventoryCategory } from '../ai/inventory-taxonomy'

export const ESTIMATION_ENGINE_VERSION = 1

export type Confidence = number // 0..1

/** A low / expected / high band for any deterministic quantity. */
export type Band = { low: number; expected: number; high: number }

// ── Item-level structured inventory (Phase 2) ────────────────────────────────
export type InventoryItem = {
  taxonomyId: InventoryCategory
  category: InventoryCategory       // alias kept for readability at call sites
  itemName: string                  // human label, e.g. "Sofa", "Refrigerator"
  count: number
  countConfidence: Confidence
  estimatedDimensions?: string      // free text if the model offered it, else omitted
  dimensionConfidence?: Confidence
  estimatedVolumeCubicFeet?: number // per-unit, derived (taxonomy default unless refined)
  estimatedWeightPounds?: number    // per-unit, derived
  // Model-estimated TOTAL volume (cu yd) for this object — set for BULK/LOOSE piles
  // (brush, debris) where a "pile" is not one taxonomy unit. When present it overrides
  // count×taxonomy in the volume/weight engines (safety-additive: only set when it
  // EXCEEDS the taxonomy total, so it can only raise, never shrink, an estimate).
  explicitVolumeCubicYards?: number
  material?: string
  condition?: string
  disassemblyRequired?: boolean
  hazardousOrRestricted?: boolean
  donationCandidate?: boolean
  recyclable?: boolean
  uncertaintyNotes?: string
  sourceImageIds: string[]          // which photos this item was seen in (dedup evidence)
}

// ── Aggregate deterministic outputs (Phases 3–5) ─────────────────────────────
export type VolumeEstimate = {
  cubicFeet: Band
  cubicYards: Band
  truckFraction: Band               // of one governed box truck (TRUCK_CUBIC_YARDS)
  truckLoads: Band
  recommendedTruckType: string
}

export type WeightEstimate = {
  pounds: Band
  heavyItems: string[]              // item names flagged heavy/very_heavy
  denseDebrisPresent: boolean
}

export type ComplexityLevel = 'low' | 'medium' | 'high'
export type ComplexityEstimate = {
  level: ComplexityLevel
  recommendedCrewSize: number
  recommendedTruckType: string
  laborHours: Band
  loadMinutes: Band
  recommendedEquipment: string[]
  ppeRequirements: string[]
  accessFactors: string[]           // stairs / long-carry / narrow / backyard / elevator / parking …
  factors: { label: string; weight: number }[] // what drove the level (explainable)
}

// ── Pricing explanation (Phase 6) — built FROM the existing priceJob breakdown ─
export type PricingAdjustment = { label: string; cents: number; reason: string }
export type PricingExplanation = {
  pricingRuleVersion: string
  baseChargeCents: number
  adjustments: PricingAdjustment[]  // truck / labor / disposal / heavy / access / travel / minimum …
  minimumChargeApplied: boolean
  marginEstimateCents: number
  recommendedCents: number
  rangeCents: { low: number; high: number }
  assumptions: string[]
}

// ── Restricted / risk + clarification (Phases 5, 8) ──────────────────────────
export type RiskLevel = 'low' | 'medium' | 'high'
export type ClarificationQuestion = { id: string; question: string; reason: string }

// ── The full versioned estimation result (shadow output) ─────────────────────
export type EstimationResult = {
  engineVersion: number
  schemaVersion: number
  taxonomyVersion: number
  pricingRuleVersion: string
  promptVersion?: number
  analysisId?: string
  bookingId?: string
  tenantId?: string
  correlationId?: string
  imageCount: number
  inventory: InventoryItem[]
  volume: VolumeEstimate
  weight: WeightEstimate
  complexity: ComplexityEstimate
  pricing: PricingExplanation
  riskLevel: RiskLevel
  restrictedItems: string[]
  confidenceScore: Confidence
  confidenceByDimension: { inventory: Confidence; volume: Confidence; access: Confidence }
  clarificationRequired: boolean
  clarificationQuestions: ClarificationQuestion[]
  manualReviewRequired: boolean
  manualReviewReasons: string[]
}

// ── Shadow comparison (Phase 9) ──────────────────────────────────────────────
export type ShadowComparison = {
  bookingId?: string
  currentRecommendedCents?: number  // the live/authoritative estimate today
  newRecommendedCents: number       // the new engine (shadow) — NEVER shown to customers
  deltaCents: number
  deltaPct: number | null
  newDecision?: string
  currentDecision?: string
  volumeCubicYards: number
  truckLoads: number
  manualReviewRequired: boolean
  engineVersion: number
}
