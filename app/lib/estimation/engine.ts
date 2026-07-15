// ─────────────────────────────────────────────────────────────────────────────
// Phase 2–6 orchestrator — the deterministic ESTIMATION ENGINE.
//
// runEstimationEngine(analysis, opts) → EstimationResult
//   1. extractInventory   — governed, deduped InventoryItem[]
//   2. estimateVolume     — cu-yd / cu-ft / truck bands
//   3. estimateWeight     — pounds band + heavy/dense flags
//   4. estimateComplexity — level, crew, time, equipment, PPE, access
//   5. decideQuote        — REUSES priceJob (no new pricing math)
//      explainPricing     — transforms that breakdown into a PricingExplanation
//   6. assemble           — version stamps, confidence, risk, restricted items,
//                            manual-review decision + reasons
//
// Pure, deterministic (no Date.now/random/IO — all inputs are passed in), and
// FAIL-SAFE: any malformed input returns a manual-review result instead of throwing.
// ─────────────────────────────────────────────────────────────────────────────

import type { JunkPhotoAnalysis } from '../ai/analysis-schema'
import { ANALYSIS_SCHEMA_VERSION } from '../ai/analysis-schema'
import { taxonomyEntry, INVENTORY_TAXONOMY_VERSION, TRUCK_CUBIC_YARDS } from '../ai/inventory-taxonomy'
import {
  decideQuote,
  PRICING_DECISION_VERSION,
  type QuoteThresholds,
} from '../pricing/quote-decision'
import { DEFAULT_DISPOSAL, type DisposalSettings, type CalibrationBias } from '../disposal'
import {
  ESTIMATION_ENGINE_VERSION,
  type EstimationResult,
  type InventoryItem,
  type RiskLevel,
} from './types'
import { extractInventory } from './inventory-extract'
import { estimateVolume } from './volume-engine'
import { estimateWeight } from './weight-engine'
import { estimateComplexity, type EstimationIntake } from './complexity'
import { explainPricing } from './pricing-explain'

export type RunEstimationOpts = {
  settings?: DisposalSettings
  calibration?: CalibrationBias
  serviceType?: string
  debris?: string
  thresholds?: Partial<QuoteThresholds>
  forceReview?: boolean
  imageIds?: string[]
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

// Access intake from the analysis' detectedConditions, overlaid with any explicit
// structured intake the caller passed (caller wins).
function intakeFromAnalysis(analysis: JunkPhotoAnalysis, override?: EstimationIntake): EstimationIntake {
  const c = analysis?.detectedConditions ?? ({} as JunkPhotoAnalysis['detectedConditions'])
  return {
    stairs: c?.stairs,
    elevator: c?.elevator,
    longCarry: c?.longCarry,
    narrowAccess: c?.narrowAccess,
    indoorRemoval: c?.indoorRemoval,
    ...(override ?? {}),
  }
}

export function runEstimationEngine(analysis: JunkPhotoAnalysis, opts: RunEstimationOpts = {}): EstimationResult {
  const settings = opts.settings ?? DEFAULT_DISPOSAL
  const serviceType = opts.serviceType ?? 'junk-removal'

  try {
    const inventory = extractInventory(analysis, { imageIds: opts.imageIds })
    const volume = estimateVolume(inventory)
    const weight = estimateWeight(inventory)
    const intake = intakeFromAnalysis(analysis, opts.intake)
    const complexity = estimateComplexity(inventory, intake)

    // Pricing — REUSE the existing deterministic decision/priceJob path.
    const decision = decideQuote({
      analysis,
      settings,
      calibration: opts.calibration,
      serviceType,
      debris: opts.debris,
      thresholds: opts.thresholds,
      forceReview: opts.forceReview,
    })
    const pricing = explainPricing(volume, weight, complexity, decision)

    // ── Restricted / risk ──────────────────────────────────────────────────────
    const hazardousItems = inventory.filter((i) => taxonomyEntry(i.taxonomyId).hazardous)
    const sensitiveItems = inventory.filter((i) => {
      const e = taxonomyEntry(i.taxonomyId)
      return !!e.sensitive && !e.hazardous
    })
    const restrictedItems = inventory
      .filter((i) => i.hazardousOrRestricted)
      .map((i) => i.itemName)

    // ── Confidence ─────────────────────────────────────────────────────────────
    const overall = clamp01(analysis?.confidence?.overall ?? 0)
    const meanItemConf = inventory.length
      ? inventory.reduce((s, i) => s + clamp01(i.countConfidence), 0) / inventory.length
      : 0
    const confidenceScore = round2(inventory.length ? overall * 0.5 + meanItemConf * 0.5 : overall)
    const confidenceByDimension = {
      inventory: round2(clamp01(analysis?.confidence?.itemClassification ?? meanItemConf)),
      volume: round2(clamp01(analysis?.confidence?.volume ?? overall)),
      access: round2(clamp01(analysis?.confidence?.accessDifficulty ?? overall)),
    }

    const hugeVolume = volume.cubicYards.expected > TRUCK_CUBIC_YARDS * 1.5

    const riskLevel: RiskLevel =
      hazardousItems.length > 0 ||
      sensitiveItems.length > 0 ||
      (weight.denseDebrisPresent && confidenceScore < 0.55) ||
      (volume.truckLoads.expected >= 2 && confidenceScore < 0.5)
        ? 'high'
        : weight.denseDebrisPresent || weight.heavyItems.length > 0 || confidenceScore < 0.6 || complexity.level === 'high'
          ? 'medium'
          : 'low'

    // ── Manual-review decision + reasons ─────────────────────────────────────────
    const reasons = new Set<string>()
    if (decision.decision === 'manual_review') decision.reviewReasons.forEach((r) => reasons.add(r))
    if (hazardousItems.length > 0) reasons.add('Restricted/hazardous items present (paint, chemicals, firearms, or medications) — human review required.')
    if (sensitiveItems.length > 0) reasons.add('Sensitive/estate items present (valuables, documents, keepsakes) — owner review required.')
    if (confidenceScore < 0.4) reasons.add('Very low confidence in the photo read.')
    if (hugeVolume) reasons.add('Very large volume — likely a multi-load job.')
    const manualReviewRequired = decision.decision === 'manual_review' || reasons.size > 0
    const manualReviewReasons = Array.from(reasons)

    return {
      engineVersion: ESTIMATION_ENGINE_VERSION,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      taxonomyVersion: INVENTORY_TAXONOMY_VERSION,
      pricingRuleVersion: PRICING_DECISION_VERSION,
      promptVersion: opts.promptVersion,
      analysisId: opts.analysisId ?? analysis?.analysisId,
      bookingId: opts.bookingId ?? analysis?.bookingId,
      tenantId: opts.tenantId,
      correlationId: opts.correlationId,
      imageCount: Array.isArray(analysis?.photoObservations) ? analysis.photoObservations.length : (opts.imageIds?.length ?? 0),
      inventory,
      volume,
      weight,
      complexity,
      pricing,
      riskLevel,
      restrictedItems,
      confidenceScore,
      confidenceByDimension,
      clarificationRequired: false,
      clarificationQuestions: [], // filled by a separate clarification module (Phase 8)
      manualReviewRequired,
      manualReviewReasons,
    }
  } catch (err) {
    return failsafeResult(analysis, opts, settings, serviceType, err)
  }
}

// A guaranteed manual-review result for when orchestration hits malformed input —
// the booking/lead is never lost. Still tries to price via the existing engine,
// but never re-throws.
function failsafeResult(
  analysis: JunkPhotoAnalysis,
  opts: RunEstimationOpts,
  settings: DisposalSettings,
  serviceType: string,
  err: unknown,
): EstimationResult {
  const inventory: InventoryItem[] = []
  const volume = estimateVolume(inventory)
  const weight = estimateWeight(inventory)
  const complexity = estimateComplexity(inventory)

  let pricing
  try {
    const decision = decideQuote({ analysis, settings, serviceType, debris: opts.debris, forceReview: true })
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

  const reason = err instanceof Error ? err.message : 'Malformed analysis input.'
  return {
    engineVersion: ESTIMATION_ENGINE_VERSION,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    taxonomyVersion: INVENTORY_TAXONOMY_VERSION,
    pricingRuleVersion: PRICING_DECISION_VERSION,
    promptVersion: opts.promptVersion,
    analysisId: opts.analysisId ?? analysis?.analysisId,
    bookingId: opts.bookingId ?? analysis?.bookingId,
    tenantId: opts.tenantId,
    correlationId: opts.correlationId,
    imageCount: opts.imageIds?.length ?? 0,
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
  }
}
