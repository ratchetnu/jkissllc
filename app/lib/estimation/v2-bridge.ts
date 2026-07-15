// ─────────────────────────────────────────────────────────────────────────────
// V2 BRIDGE — from the multi-pass vision analysis to the deterministic engine.
//
// estimateFromV2(v2, opts) converts a normalized JunkPhotoAnalysisV2 (OBSERVATIONS
// + a deduplicated inventory + operational factors — never a price) into a full
// EstimationResultV2. The bridge:
//   1. maps V2 unifiedInventory → the governed InventoryItem[] the engine speaks
//      (category via taxonomy, quantity min/likely/max → a countConfidence that
//       widens the volume band, hazard/specialty flags carried through),
//   2. REUSES the deterministic engine pieces — volume-engine, weight-engine,
//      complexity — so volume / weight / crew all come from governed math,
//   3. derives the truck-fill fraction from the DETERMINISTIC volume (never the
//      model's volumeHint) and prices it through decideQuote → priceJob →
//      explainPricing. The model NEVER sets the final price.
//   4. labels the deterministic fill with a load tier (load-tier.ts) and gates the
//      whole thing with computeConfidence (confidence.ts).
//
// The model's volumeHint is used ONLY as an advisory sanity cross-check (surfaced
// for audit + fed to confidence) — it can never override the deterministic volume.
//
// Pure + deterministic (no I/O, no Date.now, no randomness — all timestamps/ids are
// passed in) and FAIL-SAFE: malformed input returns a manual-review shell, never a
// throw and never a completed-but-wrong estimate. Only ever invoked under the shadow
// flag by the orchestrator, so it is byte-inert until then.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  JunkPhotoAnalysisV2,
  UnifiedObject,
  LaborAssessment,
  DisposalAssessment,
  VolumeHint,
  ConfidenceBand as V2ConfidenceBand,
  DisposalCategory,
} from '../ai/analysis-schema-v2'
import type { JunkPhotoAnalysis, DetectedJunkItem, DetectedConditions, ImageQuality } from '../ai/analysis-schema'
import { ANALYSIS_SCHEMA_VERSION } from '../ai/analysis-schema'
import {
  taxonomyEntry,
  classifyFreeText,
  normalizeToInventoryCategory,
  INVENTORY_TAXONOMY_VERSION,
  TRUCK_CUBIC_YARDS,
  type InventoryCategory,
} from '../ai/inventory-taxonomy'
import {
  decideQuote,
  PRICING_DECISION_VERSION,
  type QuoteThresholds,
  type QuoteDecision,
} from '../pricing/quote-decision'
import { DEFAULT_DISPOSAL, type DisposalSettings, type CalibrationBias } from '../disposal'
import {
  ESTIMATION_ENGINE_VERSION,
  type EstimationResult,
  type InventoryItem,
  type RiskLevel,
  type Band,
} from './types'
import { estimateVolume } from './volume-engine'
import { estimateWeight, densityForEntry } from './weight-engine'
import { estimateComplexity, type EstimationIntake } from './complexity'
import { explainPricing } from './pricing-explain'
import { loadTierFor, LOAD_TIER_VERSION, type LoadTier, type LoadTierConfig } from './load-tier'
import { computeConfidence, CONFIDENCE_VERSION, type ConfidenceResult, type ConfidenceThresholds } from './confidence'

export const V2_BRIDGE_VERSION = 1

// ── The V2-specific superset result ──────────────────────────────────────────
export type EstimationResultV2 = EstimationResult & {
  v2: {
    bridgeVersion: number
    analysisVersion: number
    loadTier: LoadTier
    loadTierVersion: number
    truckFraction: Band            // deterministic fraction of one box truck
    confidence: ConfidenceResult
    confidenceVersion: number
    volumeHint: VolumeHint         // model hint — advisory only, echoed for audit
    volumeHintCubicYards: number | null
    volumeHintDivergence: number | null   // |det − hint| / max(det, hint)
    laborAssessment: LaborAssessment
    disposalAssessment: DisposalAssessment
    surchargeItems: string[]
    specialtyItems: string[]
    decision: QuoteDecision
    sourceObjectCount: number
  }
}

export type EstimateFromV2Opts = {
  settings?: DisposalSettings
  calibration?: CalibrationBias
  serviceType?: string
  debris?: string
  thresholds?: Partial<QuoteThresholds>
  confidenceThresholds?: Partial<ConfidenceThresholds>
  loadTierConfig?: LoadTierConfig
  forceReview?: boolean
  intake?: EstimationIntake
  // Passthrough identity/attribution:
  analysisId?: string
  bookingId?: string
  tenantId?: string
  correlationId?: string
  promptVersion?: number
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
const round2 = (n: number) => Math.round(n * 100) / 100

// ── V2 confidence band → a 0..1 baseline for countConfidence ─────────────────
const BAND_BASE: Record<V2ConfidenceBand, number> = { high: 0.9, medium: 0.65, low: 0.4 }

// ── V2 DisposalCategory → the governed InventoryCategory it implies (restrictive
// or specialty routing only). Missing/plain classes (landfill/recycling/donation/
// unknown) return undefined so the base classification stands. ────────────────
const DISPOSAL_CLASS_TO_INVENTORY: Partial<Record<DisposalCategory, InventoryCategory>> = {
  hazardous: 'hazardous',
  'appliance-refrigerant': 'appliance',
  'e-waste': 'electronics',
  tire: 'tires',
  mattress: 'mattress',
  construction: 'construction_debris',
  'yard-waste': 'yard_debris',
}

/**
 * Map one V2 unified object to a governed InventoryCategory. Free-text
 * classification of the category/description is the base; disposalClass and
 * specialHandling can only UPGRADE it to a more restrictive/specialty category
 * (never downgrade a hazardous/sensitive read). Mirrors inventory-extract's
 * safety-additive philosophy.
 */
export function inventoryCategoryForV2(obj: UnifiedObject): InventoryCategory {
  let cat = normalizeToInventoryCategory(obj.category, obj.description)
  const baseE = taxonomyEntry(cat)

  // Disposal-class upgrade — apply when the class implies hazard/specialty the base
  // missed, or when the base fell through to the generic catch-all.
  const dispCat = DISPOSAL_CLASS_TO_INVENTORY[obj.disposalClass]
  if (dispCat && !baseE.hazardous && !baseE.sensitive) {
    const de = taxonomyEntry(dispCat)
    if (de.hazardous || de.sensitive || de.specialHandling || cat === 'other') {
      cat = dispCat
    }
  }

  // Specialty-handling upgrade — piano / hot tub / safe called out in specialHandling.
  const cur = taxonomyEntry(cat)
  if (!cur.hazardous && !cur.sensitive) {
    const specialText = [...(obj.specialHandling ?? []), obj.description].join(' ')
    const bySpecial = classifyFreeText(specialText)
    if ((bySpecial === 'piano' || bySpecial === 'hot_tub' || bySpecial === 'safe_dense_object')) {
      cat = bySpecial
    }
  }
  return cat
}

/** One V2 object → one governed InventoryItem. Quantity spread widens the band. */
function toInventoryItem(obj: UnifiedObject): InventoryItem {
  const cat = inventoryCategoryForV2(obj)
  const e = taxonomyEntry(cat)
  const perUnitCuYd = e.perUnitVolumeCubicYards

  const likely = Math.max(1, Math.round(Number.isFinite(obj.quantity) && obj.quantity > 0 ? obj.quantity : (obj.maxQuantity || 1)))
  const minQ = Math.max(0, Math.round(obj.minQuantity || 0))
  const maxQ = Math.max(likely, Math.round(obj.maxQuantity || likely))
  // Carry min/likely/max quantity into the volume band: a wide spread lowers the
  // countConfidence, and the volume engine's widthFor() widens the band in turn.
  const spreadPenalty = Math.min(0.5, (maxQ - minQ) / Math.max(1, likely) * 0.5)
  const countConfidence = clamp01(BAND_BASE[obj.confidence] - spreadPenalty)

  // Bulk/loose piles: a "pile" object is NOT one taxonomy unit. When the model sized
  // the object's volume (estimatedVolumeCubicFeet low/high) LARGER than the taxonomy
  // default × count, use that as the object's total volume — otherwise a big brush pile
  // reads as ~0.8 cu yd and the job is badly underquoted. Safety-additive: only ever
  // raises the estimate above the taxonomy floor, never shrinks it.
  const lo = obj.estimatedVolumeCubicFeetLow, hi = obj.estimatedVolumeCubicFeetHigh
  const modelCuFt = lo != null || hi != null ? ((lo ?? hi ?? 0) + (hi ?? lo ?? 0)) / 2 : 0
  const modelCuYd = modelCuFt / 27
  const taxonomyTotalCuYd = likely * perUnitCuYd
  const explicitVolumeCubicYards = modelCuYd > taxonomyTotalCuYd ? round2(modelCuYd) : undefined
  const usedPerObjectCuYd = explicitVolumeCubicYards ?? taxonomyTotalCuYd

  return {
    taxonomyId: cat,
    category: cat,
    itemName: (obj.description && obj.description.trim()) || (obj.category && obj.category.trim()) || e.label,
    count: likely,
    countConfidence,
    estimatedVolumeCubicFeet: round2(usedPerObjectCuYd * 27),
    estimatedWeightPounds: Math.round(usedPerObjectCuYd * densityForEntry(e)),
    explicitVolumeCubicYards,
    material: undefined,
    condition: undefined,
    disassemblyRequired: (obj.specialHandling ?? []).some((h) => /disassembl/i.test(h)) || e.requiresDisassembly,
    hazardousOrRestricted: !!(e.hazardous || e.sensitive) || obj.disposalClass === 'hazardous',
    donationCandidate: e.disposalClass === 'donation' || obj.disposalClass === 'donation',
    recyclable: e.disposalClass === 'recycling',
    uncertaintyNotes: obj.confidence === 'low' ? (obj.duplicateReasoning || 'Low-confidence identification') : undefined,
    sourceImageIds: Array.isArray(obj.sourceImageIds) ? [...obj.sourceImageIds] : [],
  }
}

/** Build the governed inventory from the V2 deduplicated list. */
export function inventoryFromV2(v2: JunkPhotoAnalysisV2): InventoryItem[] {
  const objs = Array.isArray(v2?.unifiedInventory) ? v2.unifiedInventory : []
  return objs.map(toInventoryItem)
}

// Tri-bool true → true, else undefined (unknown/false = no access penalty).
const yesOnly = (v: boolean | 'unknown'): boolean | undefined => (v === true ? true : undefined)

function intakeFromV2(v2: JunkPhotoAnalysisV2, override?: EstimationIntake): EstimationIntake {
  const a = v2.accessAssessment ?? ({} as JunkPhotoAnalysisV2['accessAssessment'])
  return {
    stairs: yesOnly(a.stairs),
    elevator: yesOnly(a.elevator),
    longCarry: yesOnly(a.longCarry),
    narrowAccess: yesOnly(a.narrowAccess),
    parkingDifficult: yesOnly(a.parkingRestricted),
    backyard: yesOnly(a.outdoorDistance),
    multipleAreas: a.multipleRoomsOrAreas === true ? true : undefined,
    ...(override ?? {}),
  }
}

const V2_QUALITY_TO_OLD: Record<string, ImageQuality> = {
  good: 'good', fair: 'limited', poor: 'limited', unusable: 'unusable',
}

// Build a synthetic OLD JunkPhotoAnalysis purely to drive decideQuote/priceJob.
// The one number that steers pricing — estimatedTruckLoadFraction — is seeded from
// the DETERMINISTIC volume, so the price traces to the engine, never to volumeHint.
function syntheticAnalysisForPricing(
  v2: JunkPhotoAnalysisV2,
  inventory: InventoryItem[],
  truckFraction: Band,
  hazard: boolean,
  dense: boolean,
  paintOrChemical: boolean,
): JunkPhotoAnalysis {
  const acc = v2.accessAssessment ?? ({} as JunkPhotoAnalysisV2['accessAssessment'])
  const lab = v2.laborAssessment ?? ({} as JunkPhotoAnalysisV2['laborAssessment'])

  const normalizedItems: DetectedJunkItem[] = inventory.map((i) => {
    const e = taxonomyEntry(i.taxonomyId)
    return {
      category: e.junkCategory,
      label: i.itemName,
      estimatedQuantity: i.count,
      estimatedVolumeCubicYards: e.perUnitVolumeCubicYards,
      estimatedWeightPounds: { minimum: 0, likely: 0, maximum: 0 },
      bulky: false,
      heavy: !!e.heavy,
      requiresDisassembly: !!i.disassemblyRequired,
      likelyDisposalType: 'unknown',
      confidence: i.countConfidence,
      evidence: '',
    }
  })

  const detectedConditions: DetectedConditions = {
    stairs: acc.stairs === true,
    elevator: acc.elevator === true,
    longCarry: acc.longCarry === true,
    narrowAccess: acc.narrowAccess === true,
    indoorRemoval: false,
    outdoorRemoval: acc.outdoorDistance === true,
    disassemblyRequired: !!lab.disassemblyRequired || inventory.some((i) => i.disassemblyRequired),
    heavyItemsPresent: !!lab.heavyLifting || inventory.some((i) => taxonomyEntry(i.taxonomyId).heavy),
    hazardousMaterialPossible: hazard,
    refrigerantAppliancePossible: inventory.some((i) => i.taxonomyId === 'appliance'),
    concreteOrSoilPossible: dense,
    tiresPossible: inventory.some((i) => i.taxonomyId === 'tires'),
    paintOrChemicalPossible: paintOrChemical,
  }

  const conf = clamp01(v2.confidenceScore)
  const photoObservations = (v2.imageQualityResults ?? []).map((q) => ({
    photoUrl: '',
    visibleItems: [],
    estimatedPhotoVolumeCubicYards: 0,
    accessObservations: [],
    possibleDuplicateViewOfOtherPhoto: false,
    imageQuality: V2_QUALITY_TO_OLD[q.quality] ?? 'limited',
  }))

  return {
    analysisId: v2.bookingId,
    bookingId: v2.bookingId,
    modelProvider: 'v2-bridge',
    modelName: v2.model,
    analyzedAt: v2.analyzedAt,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    photoObservations,
    normalizedItems,
    totalEstimatedVolumeCubicYards: { minimum: 0, likely: 0, maximum: 0 },
    totalEstimatedWeightPounds: { minimum: 0, likely: 0, maximum: 0 },
    // The authoritative deterministic fraction — this is what priceJob prices.
    estimatedTruckLoadFraction: { minimum: truckFraction.low, likely: truckFraction.expected, maximum: truckFraction.high },
    estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
    laborEstimate: { crewSize: Math.max(1, Math.round(lab.estimatedCrewSize || 2)), minimumMinutes: 60, likelyMinutes: 90, maximumMinutes: 150 },
    detectedConditions,
    additionalQuestions: [],
    confidence: { overall: conf, volume: conf, weight: conf, itemClassification: conf, accessDifficulty: conf },
    warnings: [],
    reviewRequired: !!v2.manualReviewRequired,
    reviewReasons: Array.isArray(v2.manualReviewReasons) ? v2.manualReviewReasons : [],
  }
}

/** Main entry — V2 analysis → deterministic, priced, gated EstimationResultV2. */
export function estimateFromV2(v2: JunkPhotoAnalysisV2, opts: EstimateFromV2Opts = {}): EstimationResultV2 {
  const settings = opts.settings ?? DEFAULT_DISPOSAL
  const serviceType = opts.serviceType ?? 'junk-removal'

  try {
    if (!v2 || typeof v2 !== 'object') throw new Error('missing V2 analysis')

    const inventory = inventoryFromV2(v2)
    const volume = estimateVolume(inventory)
    const weight = estimateWeight(inventory)
    const intake = intakeFromV2(v2, opts.intake)
    const complexity = estimateComplexity(inventory, intake)

    // ── Confidence gate (deterministic — reads the deterministic volume band) ───
    const confidence = computeConfidence(v2, volume, { thresholds: opts.confidenceThresholds })

    // ── Hazard / dense signals (drive the pricing decision's review path) ───────
    const disp = v2.disposalAssessment ?? ({ surchargeItems: [], hazardousPossible: false, specialtyItems: [] } as DisposalAssessment)
    const hazard = !!disp.hazardousPossible ||
      inventory.some((i) => taxonomyEntry(i.taxonomyId).hazardous) ||
      (v2.perImageObservations ?? []).some((p) => p.hazardousConcern)
    const paintOrChemical = (v2.perImageObservations ?? []).some((p) => p.paintOrChemical)
    const dense = inventory.some((i) => taxonomyEntry(i.taxonomyId).denseDebris) ||
      (v2.perImageObservations ?? []).some((p) => p.constructionDebris)

    // ── Pricing — REUSE decideQuote → priceJob, seeded with DETERMINISTIC fill ──
    const analysis = syntheticAnalysisForPricing(v2, inventory, volume.truckFraction, hazard, dense, paintOrChemical)
    const decision = decideQuote({
      analysis,
      settings,
      calibration: opts.calibration,
      serviceType,
      debris: opts.debris,
      thresholds: opts.thresholds,
      forceReview: !!opts.forceReview || confidence.manualReview,
    })
    const pricing = explainPricing(volume, weight, complexity, decision)

    // ── Load tier from the DETERMINISTIC expected fill ──────────────────────────
    const loadTier = loadTierFor(volume.truckFraction.expected, opts.loadTierConfig)

    // ── Restricted / risk ───────────────────────────────────────────────────────
    const hazardousItems = inventory.filter((i) => taxonomyEntry(i.taxonomyId).hazardous)
    const sensitiveItems = inventory.filter((i) => {
      const e = taxonomyEntry(i.taxonomyId)
      return !!e.sensitive && !e.hazardous
    })
    const restrictedItems = inventory.filter((i) => i.hazardousOrRestricted).map((i) => i.itemName)

    const hugeVolume = volume.cubicYards.expected > TRUCK_CUBIC_YARDS * 1.5
    const riskLevel: RiskLevel =
      hazardousItems.length > 0 ||
      sensitiveItems.length > 0 ||
      (weight.denseDebrisPresent && confidence.score < 0.55) ||
      (volume.truckLoads.expected >= 2 && confidence.score < 0.5)
        ? 'high'
        : weight.denseDebrisPresent || weight.heavyItems.length > 0 || confidence.score < 0.6 || complexity.level === 'high'
          ? 'medium'
          : 'low'

    // ── Volume-hint sanity cross-check (advisory; NEVER overrides volume) ────────
    const hintLikely = v2.volumeHint?.likelyCubicYards ?? null
    const detExp = volume.cubicYards.expected
    const volumeHintDivergence = hintLikely != null && hintLikely > 0 && detExp > 0
      ? round2(Math.abs(detExp - hintLikely) / Math.max(detExp, hintLikely))
      : null

    // ── Manual-review decision + reasons ────────────────────────────────────────
    const reasons = new Set<string>()
    if (decision.decision === 'manual_review') decision.reviewReasons.forEach((r) => reasons.add(r))
    confidence.manualReviewReasons.forEach((r) => reasons.add(r))
    if (hazardousItems.length > 0) reasons.add('Restricted/hazardous items present — human review required.')
    if (sensitiveItems.length > 0) reasons.add('Sensitive/estate items present — owner review required.')
    if (hugeVolume) reasons.add('Very large volume — likely a multi-load job.')
    if (inventory.length === 0) reasons.add('No items could be identified — manual review required.')
    const manualReviewRequired =
      decision.decision === 'manual_review' || confidence.manualReview || reasons.size > 0

    // ── Confidence-by-dimension (deterministic; no false precision) ─────────────
    const meanItemConf = inventory.length
      ? inventory.reduce((s, i) => s + clamp01(i.countConfidence), 0) / inventory.length
      : 0
    const volSpread = detExp > 0 ? (volume.cubicYards.high - volume.cubicYards.low) / detExp : 1
    const acc = v2.accessAssessment ?? ({} as JunkPhotoAnalysisV2['accessAssessment'])
    const accessKnown = [acc.stairs, acc.elevator, acc.longCarry, acc.narrowAccess, acc.parkingRestricted, acc.outdoorDistance]
      .filter((v) => v !== 'unknown').length / 6

    return {
      engineVersion: ESTIMATION_ENGINE_VERSION,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      taxonomyVersion: INVENTORY_TAXONOMY_VERSION,
      pricingRuleVersion: PRICING_DECISION_VERSION,
      promptVersion: opts.promptVersion,
      analysisId: opts.analysisId ?? v2.bookingId,
      bookingId: opts.bookingId ?? v2.bookingId,
      tenantId: opts.tenantId,
      correlationId: opts.correlationId,
      imageCount: v2.imageCountReceived ?? 0,
      inventory,
      volume,
      weight,
      complexity,
      pricing,
      riskLevel,
      restrictedItems,
      confidenceScore: confidence.score,
      confidenceByDimension: {
        inventory: round2(clamp01(meanItemConf)),
        volume: round2(clamp01(1 - Math.min(1, volSpread))),
        access: round2(clamp01(accessKnown)),
      },
      clarificationRequired: (v2.recommendedCustomerQuestions?.length ?? 0) > 0,
      clarificationQuestions: (v2.recommendedCustomerQuestions ?? []).map((q, i) => ({
        id: `q_${i + 1}`, question: q, reason: 'Needed to firm up the estimate.',
      })),
      manualReviewRequired,
      manualReviewReasons: Array.from(reasons),
      v2: {
        bridgeVersion: V2_BRIDGE_VERSION,
        analysisVersion: v2.schemaVersion,
        loadTier,
        loadTierVersion: LOAD_TIER_VERSION,
        truckFraction: volume.truckFraction,
        confidence,
        confidenceVersion: CONFIDENCE_VERSION,
        volumeHint: v2.volumeHint ?? {},
        volumeHintCubicYards: hintLikely,
        volumeHintDivergence,
        laborAssessment: v2.laborAssessment,
        disposalAssessment: disp,
        surchargeItems: Array.isArray(disp.surchargeItems) ? [...disp.surchargeItems] : [],
        specialtyItems: Array.isArray(disp.specialtyItems) ? [...disp.specialtyItems] : [],
        decision: decision.decision,
        sourceObjectCount: Array.isArray(v2.unifiedInventory) ? v2.unifiedInventory.length : 0,
      },
    }
  } catch (err) {
    return failsafeResultV2(v2, opts, settings, serviceType, err)
  }
}

// A guaranteed manual-review result for malformed input — the booking is never
// lost. Still tries to price the empty job through the existing engine, never throws.
function failsafeResultV2(
  v2: JunkPhotoAnalysisV2 | undefined,
  opts: EstimateFromV2Opts,
  settings: DisposalSettings,
  serviceType: string,
  err: unknown,
): EstimationResultV2 {
  const inventory: InventoryItem[] = []
  const volume = estimateVolume(inventory)
  const weight = estimateWeight(inventory)
  const complexity = estimateComplexity(inventory)

  let pricing
  let decisionKind: QuoteDecision = 'manual_review'
  try {
    const analysis = syntheticAnalysisForPricing(
      (v2 ?? {} as JunkPhotoAnalysisV2), inventory, volume.truckFraction, false, false, false,
    )
    const decision = decideQuote({ analysis, settings, serviceType, debris: opts.debris, forceReview: true })
    decisionKind = decision.decision
    pricing = explainPricing(volume, weight, complexity, decision)
  } catch {
    pricing = {
      pricingRuleVersion: PRICING_DECISION_VERSION,
      baseChargeCents: 0,
      adjustments: [],
      minimumChargeApplied: false,
      marginEstimateCents: 0,
      recommendedCents: 0,
      rangeCents: { low: 0, high: 0 },
      assumptions: ['Estimation failed — manual review required.'],
    }
  }

  const reason = err instanceof Error ? err.message : 'Malformed V2 analysis input.'
  return {
    engineVersion: ESTIMATION_ENGINE_VERSION,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    taxonomyVersion: INVENTORY_TAXONOMY_VERSION,
    pricingRuleVersion: PRICING_DECISION_VERSION,
    promptVersion: opts.promptVersion,
    analysisId: opts.analysisId ?? v2?.bookingId,
    bookingId: opts.bookingId ?? v2?.bookingId,
    tenantId: opts.tenantId,
    correlationId: opts.correlationId,
    imageCount: v2?.imageCountReceived ?? 0,
    inventory,
    volume,
    weight,
    complexity,
    pricing,
    riskLevel: 'high',
    restrictedItems: [],
    confidenceScore: 0,
    confidenceByDimension: { inventory: 0, volume: 0, access: 0 },
    clarificationRequired: false,
    clarificationQuestions: [],
    manualReviewRequired: true,
    manualReviewReasons: [`Estimation could not be completed automatically (${reason}).`],
    v2: {
      bridgeVersion: V2_BRIDGE_VERSION,
      analysisVersion: v2?.schemaVersion ?? 0,
      loadTier: loadTierFor(0, opts.loadTierConfig),
      loadTierVersion: LOAD_TIER_VERSION,
      truckFraction: volume.truckFraction,
      confidence: { band: 'low', score: 0, reasons: [reason], manualReview: true, manualReviewReasons: [reason] },
      confidenceVersion: CONFIDENCE_VERSION,
      volumeHint: {},
      volumeHintCubicYards: null,
      volumeHintDivergence: null,
      laborAssessment: v2?.laborAssessment ?? { estimatedCrewSize: 2, disassemblyRequired: false, heavyLifting: false, oversizedItems: false, applianceHandling: false, ppeRequired: [], potentialSecondTrip: false },
      disposalAssessment: v2?.disposalAssessment ?? { surchargeItems: [], hazardousPossible: false, specialtyItems: [] },
      surchargeItems: [],
      specialtyItems: [],
      decision: decisionKind,
      sourceObjectCount: 0,
    },
  }
}
