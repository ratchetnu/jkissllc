// ─────────────────────────────────────────────────────────────────────────────
// JunkPhotoAnalysisV2 — the versioned structured-output contract for the multi-pass
// junk-removal vision estimator (Phase 3/4).
//
// The AI produces OBSERVATIONS + a deduplicated inventory + operational factors ONLY.
// It NEVER produces the final price — deterministic code (estimation/* + priceJob)
// converts this into volume, load tier, and pricing. Provider-agnostic: runs on the
// existing Vercel AI Gateway (default Claude; switchable to openai/gpt-4o via AI_MODEL).
//
// Pure + dependency-free (no I/O, no Date.now) so it is unit-testable and reusable by
// both analysis passes and the deterministic engine. Every model field is validated +
// clamped by normalizeAnalysisV2 — raw model output is NEVER trusted.
// ─────────────────────────────────────────────────────────────────────────────

export const ANALYSIS_V2_VERSION = 2

// ── Shared vocabularies ──────────────────────────────────────────────────────
export type ConfidenceBand = 'high' | 'medium' | 'low'
export type ImageQuality = 'good' | 'fair' | 'poor' | 'unusable'
export type MaterialCategory =
  | 'wood' | 'metal' | 'plastic' | 'upholstered' | 'appliance' | 'electronic'
  | 'mattress' | 'construction' | 'yard' | 'mixed' | 'hazardous' | 'unknown'
export type DisposalCategory =
  | 'landfill' | 'recycling' | 'donation' | 'e-waste' | 'appliance-refrigerant'
  | 'tire' | 'mattress' | 'hazardous' | 'construction' | 'yard-waste' | 'unknown'
export type WeightClass = 'light' | 'medium' | 'heavy' | 'very_heavy'

// ── Pass A: per-image observation ────────────────────────────────────────────
export type PerImageItem = {
  name: string
  quantity: number          // visible count in THIS image (min 0)
  approxDimensions?: string  // free text, only when inferable
  material: MaterialCategory
  disposalCategory: DisposalCategory
  bulky: boolean
  heavy: boolean
  confidence: ConfidenceBand
}

export type PerImageObservation = {
  imageId: string
  sceneDescription: string
  locationType: string       // e.g. "garage", "curbside pile", "living room", "unknown"
  items: PerImageItem[]
  // Material/hazard flags (visible-evidence only — model flags "possible", never asserts):
  hazardousConcern: boolean
  electronicWaste: boolean
  refrigerantAppliance: boolean
  mattressOrBoxSpring: boolean
  tire: boolean
  paintOrChemical: boolean
  constructionDebris: boolean
  yardWaste: boolean
  looseDebris: boolean
  baggedMaterial: boolean
  // Access signals VISIBLE in the image (never inferred; unknowns stay false):
  stairsVisible: boolean
  elevatorVisible: boolean
  doorwayLimitation: boolean
  narrowHallway: boolean
  longCarryIndication: boolean
  disassemblyLikely: boolean
  uncertainObservations: string[]
  imageQuality: ImageQuality
  confidence: ConfidenceBand
}

// ── Pass B: unified (cross-image-reconciled) inventory ───────────────────────
export type UnifiedObject = {
  objectId: string           // stable internal id, e.g. "object_001"
  category: string           // normalized taxonomy-facing category
  description: string
  quantity: number           // likely
  minQuantity: number
  maxQuantity: number
  sourceImageIds: string[]   // which images this object was seen in (dedup evidence)
  duplicateReasoning?: string // why the same object across images was merged (or not)
  estimatedVolumeCubicFeetLow?: number
  estimatedVolumeCubicFeetHigh?: number
  weightClass: WeightClass
  disposalClass: DisposalCategory
  specialHandling: string[]  // e.g. "refrigerant recovery", "2-person lift", "disassembly"
  confidence: ConfidenceBand
}

// ── Scene / access / labor / disposal assessments ────────────────────────────
export type AccessAssessment = {
  stairs: boolean | 'unknown'
  elevator: boolean | 'unknown'
  longCarry: boolean | 'unknown'
  narrowAccess: boolean | 'unknown'
  parkingRestricted: boolean | 'unknown'
  outdoorDistance: boolean | 'unknown'
  multipleRoomsOrAreas: boolean
  notes: string[]
}
export type LaborAssessment = {
  estimatedCrewSize: number
  disassemblyRequired: boolean
  heavyLifting: boolean
  oversizedItems: boolean
  applianceHandling: boolean
  ppeRequired: string[]
  potentialSecondTrip: boolean
}
export type DisposalAssessment = {
  surchargeItems: string[]   // tires, mattresses, appliances w/ refrigerant, e-waste, hazardous
  hazardousPossible: boolean
  specialtyItems: string[]   // piano, safe, hot tub, etc.
}

// ── Volume estimate (deterministic engine fills the authoritative numbers; the
//    model may supply bounded hints, which the normalizer keeps as hints only) ──
export type VolumeHint = {
  minCubicYards?: number
  likelyCubicYards?: number
  maxCubicYards?: number
}

// ── The full versioned V2 result ─────────────────────────────────────────────
export type JunkPhotoAnalysisV2 = {
  schemaVersion: number
  bookingId: string
  analyzedAt: string
  model: string
  promptVersion: string
  imageCountReceived: number
  imageCountUsable: number
  imageQualityResults: { imageId: string; quality: ImageQuality; warnings: string[] }[]
  perImageObservations: PerImageObservation[]
  unifiedInventory: UnifiedObject[]
  sceneSummary: string
  accessAssessment: AccessAssessment
  laborAssessment: LaborAssessment
  disposalAssessment: DisposalAssessment
  volumeHint: VolumeHint     // model hint only — NOT authoritative
  confidence: ConfidenceBand
  confidenceScore: number    // 0..1 internal (never shown as false precision)
  uncertaintyReasons: string[]
  missingInformation: string[]
  recommendedCustomerQuestions: string[]
  manualReviewRequired: boolean
  manualReviewReasons: string[]
  customerSafeSummary: string   // concise, customer-facing language
  internalOwnerSummary: string  // detailed owner reasoning
}

// ── Normalizer — validates + clamps untrusted model output; NEVER throws, NEVER
//    prices. On junk input returns a manual-review shell so the booking is preserved. ─
const BANDS: ConfidenceBand[] = ['high', 'medium', 'low']
const QUALS: ImageQuality[] = ['good', 'fair', 'poor', 'unusable']
const s = (v: unknown, max = 400): string => (typeof v === 'string' ? v.slice(0, max) : '')
const n = (v: unknown, min = 0, max = 1e6): number => {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : Number(v)
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : min
}
const b = (v: unknown): boolean => v === true
const band = (v: unknown): ConfidenceBand => (BANDS.includes(v as ConfidenceBand) ? (v as ConfidenceBand) : 'low')
const qual = (v: unknown): ImageQuality => (QUALS.includes(v as ImageQuality) ? (v as ImageQuality) : 'unusable')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strList = (v: unknown, cap = 12): string[] => arr(v).map((x) => s(x, 200)).filter(Boolean).slice(0, cap)

export type NormalizeV2Ctx = {
  bookingId: string; analyzedAt: string; model: string; promptVersion: string
  imageIds: string[]
}

/** Build a manual-review shell (preserves the booking when analysis is unusable). */
export function reviewFallbackV2(ctx: NormalizeV2Ctx, reasons: string[]): JunkPhotoAnalysisV2 {
  return {
    schemaVersion: ANALYSIS_V2_VERSION, bookingId: ctx.bookingId, analyzedAt: ctx.analyzedAt,
    model: ctx.model, promptVersion: ctx.promptVersion,
    imageCountReceived: ctx.imageIds.length, imageCountUsable: 0,
    imageQualityResults: ctx.imageIds.map((id) => ({ imageId: id, quality: 'unusable' as const, warnings: ['not analyzed'] })),
    perImageObservations: [], unifiedInventory: [], sceneSummary: '',
    accessAssessment: { stairs: 'unknown', elevator: 'unknown', longCarry: 'unknown', narrowAccess: 'unknown', parkingRestricted: 'unknown', outdoorDistance: 'unknown', multipleRoomsOrAreas: false, notes: [] },
    laborAssessment: { estimatedCrewSize: 2, disassemblyRequired: false, heavyLifting: false, oversizedItems: false, applianceHandling: false, ppeRequired: [], potentialSecondTrip: false },
    disposalAssessment: { surchargeItems: [], hazardousPossible: false, specialtyItems: [] },
    volumeHint: {}, confidence: 'low', confidenceScore: 0,
    uncertaintyReasons: reasons, missingInformation: reasons,
    recommendedCustomerQuestions: [], manualReviewRequired: true, manualReviewReasons: reasons,
    customerSafeSummary: 'Your photos need a quick human review before we can quote accurately.',
    internalOwnerSummary: `Automated V2 analysis unavailable: ${reasons.join('; ')}`,
  }
}

export function normalizeAnalysisV2(raw: unknown, ctx: NormalizeV2Ctx): JunkPhotoAnalysisV2 {
  if (!raw || typeof raw !== 'object') return reviewFallbackV2(ctx, ['model returned no structured object'])
  const r = raw as Record<string, unknown>

  const perImage: PerImageObservation[] = arr(r.perImageObservations).slice(0, 12).map((o, i) => {
    const ob = (o ?? {}) as Record<string, unknown>
    return {
      imageId: s(ob.imageId, 80) || ctx.imageIds[i] || `img_${i + 1}`,
      sceneDescription: s(ob.sceneDescription), locationType: s(ob.locationType, 80) || 'unknown',
      items: arr(ob.items).slice(0, 40).map((it) => {
        const t = (it ?? {}) as Record<string, unknown>
        return {
          name: s(t.name, 120) || 'unknown item', quantity: Math.round(n(t.quantity, 0, 999)),
          approxDimensions: s(t.approxDimensions, 120) || undefined,
          material: (['wood', 'metal', 'plastic', 'upholstered', 'appliance', 'electronic', 'mattress', 'construction', 'yard', 'mixed', 'hazardous', 'unknown'].includes(s(t.material)) ? s(t.material) : 'unknown') as MaterialCategory,
          disposalCategory: (['landfill', 'recycling', 'donation', 'e-waste', 'appliance-refrigerant', 'tire', 'mattress', 'hazardous', 'construction', 'yard-waste', 'unknown'].includes(s(t.disposalCategory)) ? s(t.disposalCategory) : 'unknown') as DisposalCategory,
          bulky: b(t.bulky), heavy: b(t.heavy), confidence: band(t.confidence),
        }
      }),
      hazardousConcern: b(ob.hazardousConcern), electronicWaste: b(ob.electronicWaste),
      refrigerantAppliance: b(ob.refrigerantAppliance), mattressOrBoxSpring: b(ob.mattressOrBoxSpring),
      tire: b(ob.tire), paintOrChemical: b(ob.paintOrChemical), constructionDebris: b(ob.constructionDebris),
      yardWaste: b(ob.yardWaste), looseDebris: b(ob.looseDebris), baggedMaterial: b(ob.baggedMaterial),
      stairsVisible: b(ob.stairsVisible), elevatorVisible: b(ob.elevatorVisible),
      doorwayLimitation: b(ob.doorwayLimitation), narrowHallway: b(ob.narrowHallway),
      longCarryIndication: b(ob.longCarryIndication), disassemblyLikely: b(ob.disassemblyLikely),
      uncertainObservations: strList(ob.uncertainObservations), imageQuality: qual(ob.imageQuality),
      confidence: band(ob.confidence),
    }
  })

  const unified: UnifiedObject[] = arr(r.unifiedInventory).slice(0, 60).map((o, i) => {
    const ob = (o ?? {}) as Record<string, unknown>
    return {
      objectId: s(ob.objectId, 40) || `object_${String(i + 1).padStart(3, '0')}`,
      category: s(ob.category, 80) || 'unknown', description: s(ob.description, 200),
      quantity: Math.round(n(ob.quantity, 0, 999)), minQuantity: Math.round(n(ob.minQuantity, 0, 999)), maxQuantity: Math.round(n(ob.maxQuantity, 0, 999)),
      sourceImageIds: strList(ob.sourceImageIds, 12), duplicateReasoning: s(ob.duplicateReasoning, 200) || undefined,
      estimatedVolumeCubicFeetLow: ob.estimatedVolumeCubicFeetLow != null ? n(ob.estimatedVolumeCubicFeetLow, 0, 5000) : undefined,
      estimatedVolumeCubicFeetHigh: ob.estimatedVolumeCubicFeetHigh != null ? n(ob.estimatedVolumeCubicFeetHigh, 0, 5000) : undefined,
      weightClass: (['light', 'medium', 'heavy', 'very_heavy'].includes(s(ob.weightClass)) ? s(ob.weightClass) : 'medium') as WeightClass,
      disposalClass: (['landfill', 'recycling', 'donation', 'e-waste', 'appliance-refrigerant', 'tire', 'mattress', 'hazardous', 'construction', 'yard-waste', 'unknown'].includes(s(ob.disposalClass)) ? s(ob.disposalClass) : 'unknown') as DisposalCategory,
      specialHandling: strList(ob.specialHandling, 8), confidence: band(ob.confidence),
    }
  })

  const acc = (r.accessAssessment ?? {}) as Record<string, unknown>
  const triBool = (v: unknown): boolean | 'unknown' => (v === true ? true : v === false ? false : 'unknown')
  const lab = (r.laborAssessment ?? {}) as Record<string, unknown>
  const disp = (r.disposalAssessment ?? {}) as Record<string, unknown>
  const vh = (r.volumeHint ?? {}) as Record<string, unknown>
  const usable = perImage.filter((p) => p.imageQuality !== 'unusable').length

  return {
    schemaVersion: ANALYSIS_V2_VERSION, bookingId: ctx.bookingId, analyzedAt: ctx.analyzedAt,
    model: ctx.model, promptVersion: ctx.promptVersion,
    imageCountReceived: ctx.imageIds.length, imageCountUsable: usable,
    imageQualityResults: (arr(r.imageQualityResults).length ? arr(r.imageQualityResults) : perImage).slice(0, 12).map((q, i) => {
      const qo = (q ?? {}) as Record<string, unknown>
      return { imageId: s(qo.imageId, 80) || ctx.imageIds[i] || `img_${i + 1}`, quality: qual(qo.quality ?? qo.imageQuality), warnings: strList(qo.warnings) }
    }),
    perImageObservations: perImage, unifiedInventory: unified, sceneSummary: s(r.sceneSummary, 600),
    accessAssessment: {
      stairs: triBool(acc.stairs), elevator: triBool(acc.elevator), longCarry: triBool(acc.longCarry),
      narrowAccess: triBool(acc.narrowAccess), parkingRestricted: triBool(acc.parkingRestricted),
      outdoorDistance: triBool(acc.outdoorDistance), multipleRoomsOrAreas: b(acc.multipleRoomsOrAreas), notes: strList(acc.notes),
    },
    laborAssessment: {
      estimatedCrewSize: Math.round(n(lab.estimatedCrewSize, 1, 6)) || 2, disassemblyRequired: b(lab.disassemblyRequired),
      heavyLifting: b(lab.heavyLifting), oversizedItems: b(lab.oversizedItems), applianceHandling: b(lab.applianceHandling),
      ppeRequired: strList(lab.ppeRequired), potentialSecondTrip: b(lab.potentialSecondTrip),
    },
    disposalAssessment: { surchargeItems: strList(disp.surchargeItems), hazardousPossible: b(disp.hazardousPossible), specialtyItems: strList(disp.specialtyItems) },
    volumeHint: {
      minCubicYards: vh.minCubicYards != null ? n(vh.minCubicYards, 0, 500) : undefined,
      likelyCubicYards: vh.likelyCubicYards != null ? n(vh.likelyCubicYards, 0, 500) : undefined,
      maxCubicYards: vh.maxCubicYards != null ? n(vh.maxCubicYards, 0, 500) : undefined,
    },
    confidence: band(r.confidence), confidenceScore: n(r.confidenceScore, 0, 1),
    uncertaintyReasons: strList(r.uncertaintyReasons), missingInformation: strList(r.missingInformation),
    recommendedCustomerQuestions: strList(r.recommendedCustomerQuestions, 4),
    manualReviewRequired: b(r.manualReviewRequired) || usable === 0,
    manualReviewReasons: strList(r.manualReviewReasons),
    customerSafeSummary: s(r.customerSafeSummary, 400) || 'Thanks — we received your photos and are preparing your estimate.',
    internalOwnerSummary: s(r.internalOwnerSummary, 1200),
  }
}
