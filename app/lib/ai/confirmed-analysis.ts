// ─────────────────────────────────────────────────────────────────────────────
// Second (confirmed) analysis — merge the customer-confirmed inventory + answers
// with the FIRST AI read, then RE-PRICE deterministically (Part 7, 14).
//
//   original photo analysis + customer confirmation
//        → merged, GOVERNED analysis (volume/weight/fill from the taxonomy, not
//          from any customer-entered number)
//        → deterministic pricing (priceJob via decideQuote) — AI never prices
//        → photo-text consistency flags
//        → confidence-tier routing → quote_ready / owner_approval / manual_review
//
// Customer corrections can only ADD risk/conditions, never silently remove a
// photo-detected hazard or directly reduce the price: a reduction vs the photo
// read raises a material conflict → owner review (the revalidation). The ORIGINAL
// analysis is never mutated — the merge is a fresh object.
//
// `buildConfirmedEstimate` is PURE (settings/calibration/now injected) so it is
// directly unit-testable. `buildConfirmedPhotoEstimate` is the thin async wrapper
// that fetches governed settings, mirroring buildPhotoEstimate.
// ─────────────────────────────────────────────────────────────────────────────

import {
  type JunkPhotoAnalysis, type DetectedJunkItem, type DisposalType, type Range,
  ANALYSIS_SCHEMA_VERSION,
} from './analysis-schema'
import {
  taxonomyEntry, TRUCK_CUBIC_YARDS,
  type WeightClass, type DisposalClass,
} from './inventory-taxonomy'
import {
  activeItems, hasSensitiveItems, estateNeedsSiteVisit, sensitiveItems, type CustomerConfirmation,
} from './confirmation-schema'
import { detectPhotoTextConflicts } from './photo-text-consistency'
import {
  routeByConfidence, routingConfigFor,
  type ConfidenceRoutingConfig, type ConfidenceTier, type FinalWorkflowDecision,
} from '../pricing/confidence-routing'
import {
  decideQuote, PRICING_DECISION_VERSION,
  type PricingBreakdown, type QuoteThresholds,
} from '../pricing/quote-decision'
import { getDisposalSettings, type DisposalSettings, type CalibrationBias } from '../disposal'
import { getCalibration } from '../job-learning'
import { serviceFamily, type ServiceType } from '../bookings'

// Governed weight (lbs) per unit by weight class — feeds the merged weight range.
const WEIGHT_LBS: Record<WeightClass, number> = { light: 30, medium: 90, heavy: 200, very_heavy: 450 }
const DISPOSAL_MAP: Record<DisposalClass, DisposalType> = {
  landfill: 'landfill', recycling: 'recycling', donation: 'donation',
  special_handling: 'special_handling', hazardous: 'special_handling',
}

function rangeAround(likely: number): Range {
  return { minimum: Math.round(likely * 0.7), likely, maximum: Math.round(likely * 1.4) }
}

// Turn one confirmed row into a governed DetectedJunkItem (taxonomy-driven).
function itemFromConfirmed(c: ReturnType<typeof activeItems>[number]): DetectedJunkItem {
  const t = taxonomyEntry(c.category)
  const unitWeight = WEIGHT_LBS[t.weightClass]
  return {
    category: t.junkCategory,
    label: c.name || t.label,
    estimatedQuantity: c.quantity,
    estimatedVolumeCubicYards: t.perUnitVolumeCubicYards,
    estimatedWeightPounds: rangeAround(unitWeight),
    bulky: t.perUnitVolumeCubicYards >= 1,
    heavy: t.heavy,
    requiresDisassembly: t.requiresDisassembly,
    likelyDisposalType: DISPOSAL_MAP[t.disposalClass],
    confidence: c.uncertain ? 0.5 : c.aiDetected ? 0.9 : 0.8,
    evidence: c.aiDetected ? 'Confirmed by customer from photo detection.' : 'Added by customer.',
  }
}

/**
 * Merge the confirmed inventory + disclosures into a fresh, governed analysis.
 * The original `initial` is NOT mutated. Conditions are OR-merged (risk can only be
 * added). Volume/weight/fill are recomputed from the governed taxonomy.
 */
export function mergeConfirmedInventory(
  initial: JunkPhotoAnalysis | undefined,
  confirmation: CustomerConfirmation,
  ctx: { analysisId: string; bookingId: string; now: string; modelProvider?: string; modelName?: string },
): JunkPhotoAnalysis {
  const rows = activeItems(confirmation)
  const items = rows.map(itemFromConfirmed)

  const totalVolume = items.reduce((s, i) => s + i.estimatedVolumeCubicYards * i.estimatedQuantity, 0)
  const totalWeight = items.reduce((s, i) => s + i.estimatedWeightPounds.likely * i.estimatedQuantity, 0)
  const fillLikely = Math.min(6, Math.max(0.05, totalVolume / TRUCK_CUBIC_YARDS))

  const base = initial?.detectedConditions
  const ac = confirmation.accessConditions
  const d = confirmation.disclosures
  const anyItemDisassembly = items.some(i => i.requiresDisassembly)
  const anyItemHeavy = items.some(i => i.heavy)

  // OR-merge: customer answers can ADD a condition, never clear a photo-detected one.
  const detectedConditions: JunkPhotoAnalysis['detectedConditions'] = {
    stairs: !!base?.stairs || ac.itemsUpstairs === true || ac.itemsDownstairs === true || ac.stairsAtPickup === true || ac.stairsAtDelivery === true,
    elevator: !!base?.elevator || ac.elevatorAvailable === true,
    longCarry: !!base?.longCarry || ac.longCarry === true || ac.walkingDistanceLong === true,
    narrowAccess: !!base?.narrowAccess || (ac.accessRestrictions?.length ?? 0) > 0,
    indoorRemoval: !!base?.indoorRemoval,
    outdoorRemoval: !!base?.outdoorRemoval,
    disassemblyRequired: !!base?.disassemblyRequired || ac.requiresDisassembly === true || ac.assemblyDisassembly === true || anyItemDisassembly,
    heavyItemsPresent: !!base?.heavyItemsPresent || d.excessivelyHeavyItems === true || ac.excessivelyHeavy === true || anyItemHeavy,
    hazardousMaterialPossible: !!base?.hazardousMaterialPossible || d.containsHazardous === true || rows.some(r => taxonomyEntry(r.category).hazardous),
    refrigerantAppliancePossible: !!base?.refrigerantAppliancePossible || (ac.appliancesConnected === true && items.some(i => i.category === 'appliance')),
    concreteOrSoilPossible: !!base?.concreteOrSoilPossible || d.containsDenseDebris === true || items.some(i => i.category === 'construction_debris'),
    tiresPossible: !!base?.tiresPossible || rows.some(r => r.category === 'tires'),
    paintOrChemicalPossible: !!base?.paintOrChemicalPossible || d.containsHazardous === true,
  }

  // Confidence: customer confirmation RAISES item-classification confidence, but a
  // material conflict / disclosure will still route to review downstream.
  const initialConf = initial?.confidence
  const overall = rows.length === 0 ? 0 : Math.min(1, (initialConf?.overall ?? 0.6) * 0.4 + 0.55)
  const confidence: JunkPhotoAnalysis['confidence'] = {
    overall,
    volume: rows.length === 0 ? 0 : 0.7,
    weight: rows.length === 0 ? 0 : 0.65,
    itemClassification: rows.length === 0 ? 0 : 0.9,
    accessDifficulty: 0.7,
  }

  const crewSize = detectedConditions.heavyItemsPresent || fillLikely > 1 ? 3 : 2
  const likelyMinutes = Math.round(60 + fillLikely * 90)

  return {
    analysisId: ctx.analysisId,
    bookingId: ctx.bookingId,
    modelProvider: ctx.modelProvider ?? initial?.modelProvider ?? 'governed-merge',
    modelName: ctx.modelName ?? initial?.modelName ?? 'confirmed-merge-1',
    analyzedAt: ctx.now,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    photoObservations: initial?.photoObservations ?? [],
    normalizedItems: items,
    totalEstimatedVolumeCubicYards: rangeAround(Math.max(0, totalVolume)),
    totalEstimatedWeightPounds: rangeAround(Math.max(0, totalWeight)),
    estimatedTruckLoadFraction: { minimum: Math.max(0.02, fillLikely * 0.8), likely: fillLikely, maximum: Math.min(6, fillLikely * 1.3) },
    estimatedTruckLoads: rangeAround(Math.max(1, Math.ceil(fillLikely - 1e-9))),
    laborEstimate: {
      crewSize,
      minimumMinutes: Math.round(likelyMinutes * 0.7),
      likelyMinutes,
      maximumMinutes: Math.round(likelyMinutes * 1.4),
    },
    detectedConditions,
    additionalQuestions: [],
    confidence,
    warnings: initial?.warnings ?? [],
    reviewRequired: false,           // decided by decideQuote + routing, not here
    reviewReasons: [],
  }
}

// The final combined-analysis output (Part 7 completion fields).
export type FinalAnalysisResult = {
  analysisId: string
  createdAt: string
  confirmationVersion: number
  policyVersion: string
  routingTier: ConfidenceTier
  finalDecision: FinalWorkflowDecision
  mergedAnalysis: JunkPhotoAnalysis
  pricing: { recommendedUsd: number; lowUsd: number; highUsd: number; breakdown: PricingBreakdown }
  conflicts: CustomerConfirmation['conflicts']
  reviewReasons: string[]
  routingReasons: string[]
  evidenceSummary: string[]
  missingInfo: string[]
  // Operational inputs (governed pricing produces these; the model never does):
  truckLoadMin: number
  truckLoadMax: number
  laborHours: number
  crewSize: number
  disposalUsd: number
  expectedTrips: number
  specialHandling: boolean
  // Estate/cleanout: sensitive property names + estate subtype (for OpsPilot warnings).
  sensitiveItems: string[]
  estateSubtype?: string
}

function buildEvidenceSummary(a: JunkPhotoAnalysis, c: CustomerConfirmation): string[] {
  const out: string[] = []
  const rows = activeItems(c)
  out.push(`${rows.length} confirmed item type${rows.length === 1 ? '' : 's'} (${rows.reduce((s, r) => s + r.quantity, 0)} units).`)
  out.push(`Estimated ${Math.round(a.estimatedTruckLoadFraction.likely * 100)}% of a truck (${a.estimatedTruckLoads.likely} load${a.estimatedTruckLoads.likely > 1 ? 's' : ''}).`)
  if (a.detectedConditions.heavyItemsPresent) out.push('Heavy items present.')
  if (a.detectedConditions.concreteOrSoilPossible) out.push('Possible dense/heavy debris.')
  if (a.detectedConditions.hazardousMaterialPossible) out.push('Possible hazardous/special-disposal material.')
  if (c.accessConditions.rooms) out.push(`${c.accessConditions.rooms} room(s)/area(s).`)
  return out
}

function buildMissingInfo(c: CustomerConfirmation): string[] {
  const out: string[] = []
  if (!c.attestation) out.push('Customer attestation not yet recorded.')
  else {
    if (!c.attestation.representsEverything) out.push('Customer has not confirmed the list represents everything.')
    if (!c.attestation.hazardousDisclosed) out.push('Hazardous-material disclosure not confirmed.')
    if (!c.attestation.accessDisclosed) out.push('Access-condition disclosure not confirmed.')
  }
  if (c.disclosures.additionalItemsNotPictured && !c.disclosures.additionalItemsNote) out.push('Additional items reported but not described.')
  return out
}

/**
 * Pure second-pass estimate. Merges, prices deterministically, flags conflicts, and
 * routes by confidence. Settings/calibration/config/now are injected (no I/O).
 */
export function buildConfirmedEstimate(opts: {
  initial: JunkPhotoAnalysis | undefined
  confirmation: CustomerConfirmation
  serviceType: ServiceType
  settings: DisposalSettings
  calibration?: CalibrationBias
  config?: ConfidenceRoutingConfig
  thresholds?: Partial<QuoteThresholds>
  debris?: string
  now: string
  analysisId: string
  bookingId: string
}): FinalAnalysisResult {
  const family = serviceFamily(opts.serviceType)
  const config = opts.config ?? routingConfigFor(family)
  const merged = mergeConfirmedInventory(opts.initial, opts.confirmation, {
    analysisId: opts.analysisId, bookingId: opts.bookingId, now: opts.now,
  })

  // Photo-text consistency BEFORE pricing so a material conflict forces review.
  const conflicts = detectPhotoTextConflicts(opts.initial, opts.confirmation)
  // Sensitive/estate property + material conflicts + hazards all force a human —
  // the deterministic engine never auto-prices these (Estate Cleanout safeguards).
  const forceReview = conflicts.some(f => f.severity === 'material')
    || merged.detectedConditions.hazardousMaterialPossible
    || hasSensitiveItems(opts.confirmation)
    || estateNeedsSiteVisit(opts.confirmation)

  const decision = decideQuote({
    analysis: merged,
    settings: opts.settings,
    calibration: opts.calibration,
    serviceType: opts.serviceType,
    debris: opts.debris,
    thresholds: opts.thresholds,
    forceReview,
  })

  const routing = routeByConfidence({ decision, conflicts, confirmation: opts.confirmation, config })

  const q = decision.quote
  return {
    analysisId: opts.analysisId,
    createdAt: opts.now,
    confirmationVersion: opts.confirmation.confirmationVersion,
    policyVersion: PRICING_DECISION_VERSION,
    routingTier: routing.tier,
    finalDecision: routing.finalDecision,
    mergedAnalysis: merged,
    pricing: {
      recommendedUsd: decision.recommendedUsd,
      lowUsd: decision.rangeUsd.low,
      highUsd: decision.rangeUsd.high,
      breakdown: decision.breakdown,
    },
    conflicts,
    reviewReasons: decision.reviewReasons,
    routingReasons: routing.reasons,
    evidenceSummary: buildEvidenceSummary(merged, opts.confirmation),
    missingInfo: buildMissingInfo(opts.confirmation),
    truckLoadMin: merged.estimatedTruckLoads.minimum,
    truckLoadMax: merged.estimatedTruckLoads.maximum,
    laborHours: Math.round((merged.laborEstimate.likelyMinutes / 60) * 10) / 10,
    crewSize: merged.laborEstimate.crewSize,
    disposalUsd: Math.round(q.disposalCents / 100),
    expectedTrips: q.landfillTrips,
    specialHandling: activeItems(opts.confirmation).some(i => taxonomyEntry(i.category).specialHandling),
    sensitiveItems: sensitiveItems(opts.confirmation).map(i => i.name),
    estateSubtype: opts.confirmation.estate?.subtype,
  }
}

/** Async wrapper: fetch governed settings + calibration, then run the pure engine. */
export async function buildConfirmedPhotoEstimate(opts: {
  initial: JunkPhotoAnalysis | undefined
  confirmation: CustomerConfirmation
  serviceType: ServiceType
  analysisId: string
  bookingId: string
  debris?: string
  config?: ConfidenceRoutingConfig
}): Promise<FinalAnalysisResult> {
  const [settings, calibration] = await Promise.all([getDisposalSettings(), getCalibration()])
  return buildConfirmedEstimate({
    ...opts,
    settings,
    calibration,
    now: new Date().toISOString(),
  })
}
