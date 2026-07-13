// ─────────────────────────────────────────────────────────────────────────────
// Structured junk-photo analysis schema + a dependency-free validator/normalizer.
//
// The vision model is UNTRUSTED. It returns free-form JSON; this module clamps,
// defaults, and range-checks every field into a well-formed `JunkPhotoAnalysis`.
// It NEVER throws and NEVER produces a price — pricing is the deterministic
// engine's job (lib/disposal.priceJob). If the model output is too thin/invalid,
// normalizeAnalysis marks `reviewRequired` so the flow falls back to a human,
// rather than emitting a confident-but-wrong instant quote.
//
// The project's existing schema validator (app/lib/ai/schema.ts) only handles
// flat scalar objects, so this richer nested shape gets its own normalizer here.
// ─────────────────────────────────────────────────────────────────────────────

export const ANALYSIS_SCHEMA_VERSION = 1

export type JunkCategory =
  | 'furniture' | 'appliance' | 'electronics' | 'yard_waste' | 'construction_debris'
  | 'household_junk' | 'mattress' | 'scrap_metal' | 'cardboard' | 'clothing'
  | 'office_equipment' | 'exercise_equipment' | 'hot_tub' | 'shed' | 'unknown'

export const JUNK_CATEGORIES: JunkCategory[] = [
  'furniture', 'appliance', 'electronics', 'yard_waste', 'construction_debris',
  'household_junk', 'mattress', 'scrap_metal', 'cardboard', 'clothing',
  'office_equipment', 'exercise_equipment', 'hot_tub', 'shed', 'unknown',
]

export type DisposalType = 'landfill' | 'recycling' | 'donation' | 'special_handling' | 'unknown'
export type ImageQuality = 'excellent' | 'good' | 'limited' | 'unusable'

export type Range = { minimum: number; likely: number; maximum: number }

export type DetectedJunkItem = {
  category: JunkCategory
  label: string
  estimatedQuantity: number
  estimatedVolumeCubicYards: number
  estimatedWeightPounds: Range
  bulky: boolean
  heavy: boolean
  requiresDisassembly: boolean
  likelyDisposalType: DisposalType
  confidence: number            // 0..1
  evidence: string
}

export type PhotoObservation = {
  photoUrl: string
  visibleItems: DetectedJunkItem[]
  estimatedPhotoVolumeCubicYards: number
  accessObservations: string[]
  possibleDuplicateViewOfOtherPhoto: boolean
  duplicateGroupId?: string
  imageQuality: ImageQuality
}

export type DetectedConditions = {
  stairs: boolean; elevator: boolean; longCarry: boolean; narrowAccess: boolean
  indoorRemoval: boolean; outdoorRemoval: boolean; disassemblyRequired: boolean
  heavyItemsPresent: boolean; hazardousMaterialPossible: boolean
  refrigerantAppliancePossible: boolean; concreteOrSoilPossible: boolean
  tiresPossible: boolean; paintOrChemicalPossible: boolean
}

export type AnalysisConfidence = {
  overall: number; volume: number; weight: number; itemClassification: number; accessDifficulty: number
}

export type JunkPhotoAnalysis = {
  analysisId: string
  bookingId: string
  modelProvider: string
  modelName: string
  analyzedAt: string
  schemaVersion: number
  photoObservations: PhotoObservation[]
  normalizedItems: DetectedJunkItem[]
  totalEstimatedVolumeCubicYards: Range
  totalEstimatedWeightPounds: Range
  estimatedTruckLoadFraction: Range   // fraction of a 24ft box truck (0.05..6) — feeds priceJob
  estimatedTruckLoads: Range
  laborEstimate: { crewSize: number; minimumMinutes: number; likelyMinutes: number; maximumMinutes: number }
  detectedConditions: DetectedConditions
  additionalQuestions: string[]
  confidence: AnalysisConfidence
  warnings: string[]
  reviewRequired: boolean
  reviewReasons: string[]
}

// ── coercion helpers ─────────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const numOr = (v: unknown, d: number): number => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : d }
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const clamp01 = (v: unknown): number => clamp(numOr(v, 0), 0, 1)
const nonNeg = (v: unknown, d = 0): number => Math.max(0, numOr(v, d))
const boolOr = (v: unknown, d = false): boolean => typeof v === 'boolean' ? v : d
const strOr = (v: unknown, d = '', max = 400): string => (typeof v === 'string' ? v : d).slice(0, max)
const strArr = (v: unknown, max = 12, len = 240): string[] =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, max).map(x => (x as string).slice(0, len)) : []

function asCategory(v: unknown): JunkCategory {
  const s = String(v ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  return (JUNK_CATEGORIES as string[]).includes(s) ? (s as JunkCategory) : 'unknown'
}
function asDisposal(v: unknown): DisposalType {
  const s = String(v ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  return (['landfill', 'recycling', 'donation', 'special_handling', 'unknown'] as string[]).includes(s) ? (s as DisposalType) : 'unknown'
}
function asQuality(v: unknown): ImageQuality {
  const s = String(v ?? '').toLowerCase()
  return (['excellent', 'good', 'limited', 'unusable'] as string[]).includes(s) ? (s as ImageQuality) : 'limited'
}

// Accept a {minimum,likely,maximum} object OR a bare number OR [lo,hi]; always
// return a sane ascending range with a positive default when the model gives junk.
function asRange(v: unknown, dLikely: number, floor = 0): Range {
  if (isObj(v)) {
    const likely = Math.max(floor, numOr(v.likely, dLikely))
    const minimum = clamp(numOr(v.minimum, likely * 0.7), floor, likely)
    const maximum = Math.max(likely, numOr(v.maximum, likely * 1.4))
    return { minimum, likely, maximum }
  }
  if (typeof v === 'number' && Number.isFinite(v)) { const l = Math.max(floor, v); return { minimum: l * 0.8, likely: l, maximum: l * 1.3 } }
  return { minimum: Math.max(floor, dLikely * 0.7), likely: Math.max(floor, dLikely), maximum: Math.max(floor, dLikely * 1.4) }
}

function normalizeItem(v: unknown): DetectedJunkItem | null {
  if (!isObj(v)) return null
  const label = strOr(v.label, '', 120).trim()
  const category = asCategory(v.category)
  if (!label && category === 'unknown') return null
  return {
    category,
    label: label || category.replace(/_/g, ' '),
    estimatedQuantity: clamp(Math.round(nonNeg(v.estimatedQuantity, 1)), 1, 999),
    estimatedVolumeCubicYards: clamp(nonNeg(v.estimatedVolumeCubicYards, 0.5), 0, 200),
    estimatedWeightPounds: asRange(v.estimatedWeightPounds, 40, 0),
    bulky: boolOr(v.bulky),
    heavy: boolOr(v.heavy),
    requiresDisassembly: boolOr(v.requiresDisassembly),
    likelyDisposalType: asDisposal(v.likelyDisposalType),
    confidence: clamp01(v.confidence),
    evidence: strOr(v.evidence, '', 240),
  }
}

export type NormalizeCtx = {
  analysisId: string
  bookingId: string
  photoUrls: string[]
  modelProvider: string
  modelName: string
  analyzedAt: string   // ISO — pass in (Date.now() is unavailable in some contexts)
}

// 24 ft box truck ≈ 1,200 cu ft ≈ 44 cu yd. Used to derive a fill fraction when the
// model gave volume but not fraction (defensive — the prompt asks for fraction).
const TRUCK_CUBIC_YARDS = 44

// Turn a raw model object into a well-formed analysis. Never throws. Sets
// reviewRequired when the read is too thin to price confidently.
export function normalizeAnalysis(raw: unknown, ctx: NormalizeCtx): JunkPhotoAnalysis {
  const root = isObj(raw) ? raw : {}
  const reasons: string[] = []

  const itemsRaw = Array.isArray(root.normalizedItems) ? root.normalizedItems
    : Array.isArray(root.items) ? root.items : []
  const normalizedItems = itemsRaw.map(normalizeItem).filter((x): x is DetectedJunkItem => x !== null)

  const conditionsRaw = isObj(root.detectedConditions) ? root.detectedConditions : {}
  const detectedConditions: DetectedConditions = {
    stairs: boolOr(conditionsRaw.stairs), elevator: boolOr(conditionsRaw.elevator),
    longCarry: boolOr(conditionsRaw.longCarry), narrowAccess: boolOr(conditionsRaw.narrowAccess),
    indoorRemoval: boolOr(conditionsRaw.indoorRemoval), outdoorRemoval: boolOr(conditionsRaw.outdoorRemoval),
    disassemblyRequired: boolOr(conditionsRaw.disassemblyRequired) || normalizedItems.some(i => i.requiresDisassembly),
    heavyItemsPresent: boolOr(conditionsRaw.heavyItemsPresent) || normalizedItems.some(i => i.heavy),
    hazardousMaterialPossible: boolOr(conditionsRaw.hazardousMaterialPossible),
    refrigerantAppliancePossible: boolOr(conditionsRaw.refrigerantAppliancePossible),
    concreteOrSoilPossible: boolOr(conditionsRaw.concreteOrSoilPossible),
    tiresPossible: boolOr(conditionsRaw.tiresPossible),
    paintOrChemicalPossible: boolOr(conditionsRaw.paintOrChemicalPossible),
  }

  const cRaw = isObj(root.confidence) ? root.confidence : {}
  const overall = clamp01(cRaw.overall ?? root.confidenceOverall)
  const confidence: AnalysisConfidence = {
    overall,
    volume: clamp01(cRaw.volume ?? overall),
    weight: clamp01(cRaw.weight ?? overall),
    itemClassification: clamp01(cRaw.itemClassification ?? overall),
    accessDifficulty: clamp01(cRaw.accessDifficulty ?? overall),
  }

  // Fraction of a truck. Prefer the model's fraction; else derive from volume.
  const volume = asRange(root.totalEstimatedVolumeCubicYards, Math.max(1, normalizedItems.reduce((s, i) => s + i.estimatedVolumeCubicYards * i.estimatedQuantity, 0)), 0)
  let fraction = asRange(root.estimatedTruckLoadFraction, volume.likely / TRUCK_CUBIC_YARDS, 0.02)
  // Keep fraction inside priceJob's supported band.
  fraction = { minimum: clamp(fraction.minimum, 0.02, 6), likely: clamp(fraction.likely, 0.05, 6), maximum: clamp(fraction.maximum, 0.05, 6) }
  const loads = asRange(root.estimatedTruckLoads, Math.max(1, Math.ceil(fraction.likely - 1e-9)), 0)

  const weight = asRange(root.totalEstimatedWeightPounds, Math.max(50, normalizedItems.reduce((s, i) => s + i.estimatedWeightPounds.likely * i.estimatedQuantity, 0)), 0)

  const laborRaw = isObj(root.laborEstimate) ? root.laborEstimate : {}
  const likelyMinutes = clamp(Math.round(nonNeg(laborRaw.likelyMinutes, 60 + fraction.likely * 90)), 15, 2400)
  const laborEstimate = {
    crewSize: clamp(Math.round(nonNeg(laborRaw.crewSize, 2)), 1, 6),
    minimumMinutes: clamp(Math.round(nonNeg(laborRaw.minimumMinutes, likelyMinutes * 0.7)), 10, likelyMinutes),
    likelyMinutes,
    maximumMinutes: Math.max(likelyMinutes, Math.round(nonNeg(laborRaw.maximumMinutes, likelyMinutes * 1.4))),
  }

  // Per-photo observations (optional; default one bucket per input photo).
  const obsRaw = Array.isArray(root.photoObservations) ? root.photoObservations : []
  const photoObservations: PhotoObservation[] = (obsRaw.length ? obsRaw : ctx.photoUrls).map((o, i) => {
    const ob = isObj(o) ? o : {}
    return {
      photoUrl: strOr(ob.photoUrl, ctx.photoUrls[i] ?? '', 1000) || (ctx.photoUrls[i] ?? ''),
      visibleItems: (Array.isArray(ob.visibleItems) ? ob.visibleItems.map(normalizeItem).filter((x): x is DetectedJunkItem => x !== null) : []),
      estimatedPhotoVolumeCubicYards: nonNeg(ob.estimatedPhotoVolumeCubicYards, 0),
      accessObservations: strArr(ob.accessObservations, 6),
      possibleDuplicateViewOfOtherPhoto: boolOr(ob.possibleDuplicateViewOfOtherPhoto),
      duplicateGroupId: typeof ob.duplicateGroupId === 'string' ? ob.duplicateGroupId.slice(0, 60) : undefined,
      imageQuality: asQuality(ob.imageQuality),
    }
  })

  const warnings = strArr(root.warnings, 10)
  const additionalQuestions = strArr(root.additionalQuestions, 8)

  // ── Review triggers (Phase 7 Outcome C). We OR the model's own reviewRequired
  // with our safety rules so a rosy model can't force an instant quote.
  const unusable = photoObservations.every(p => p.imageQuality === 'unusable') && photoObservations.length > 0
  if (normalizedItems.length === 0) reasons.push('No items could be identified from the photos.')
  if (unusable) reasons.push('Photos were unusable (too dark, blurry, or obstructed).')
  if (confidence.overall < 0.55) reasons.push('Overall confidence is below the instant-quote threshold.')
  if (confidence.volume < 0.5) reasons.push('Volume estimate is uncertain.')
  if (detectedConditions.hazardousMaterialPossible || detectedConditions.paintOrChemicalPossible) reasons.push('Possible hazardous materials — needs human confirmation.')
  if (detectedConditions.concreteOrSoilPossible) reasons.push('Possible dense debris (concrete/soil) — weight risk.')
  if (fraction.likely > 1.1) reasons.push('Job may need more than one truckload.')
  if (boolOr(root.reviewRequired)) reasons.push(...strArr(root.reviewReasons, 6))

  const reviewReasons = Array.from(new Set(reasons))
  return {
    analysisId: ctx.analysisId,
    bookingId: ctx.bookingId,
    modelProvider: ctx.modelProvider,
    modelName: ctx.modelName,
    analyzedAt: ctx.analyzedAt,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    photoObservations,
    normalizedItems,
    totalEstimatedVolumeCubicYards: volume,
    totalEstimatedWeightPounds: weight,
    estimatedTruckLoadFraction: fraction,
    estimatedTruckLoads: loads,
    laborEstimate,
    detectedConditions,
    additionalQuestions,
    confidence,
    warnings,
    reviewRequired: reviewReasons.length > 0,
    reviewReasons,
  }
}

// A guaranteed review-required analysis for when the AI call itself fails or is
// unavailable — so the booking is never lost (Phase 7 Outcome C / Phase 14).
export function reviewFallbackAnalysis(ctx: NormalizeCtx, reasons: string[]): JunkPhotoAnalysis {
  const zero: Range = { minimum: 0, likely: 0, maximum: 0 }
  return {
    analysisId: ctx.analysisId, bookingId: ctx.bookingId,
    modelProvider: ctx.modelProvider, modelName: ctx.modelName, analyzedAt: ctx.analyzedAt,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    photoObservations: ctx.photoUrls.map(u => ({
      photoUrl: u, visibleItems: [], estimatedPhotoVolumeCubicYards: 0,
      accessObservations: [], possibleDuplicateViewOfOtherPhoto: false, imageQuality: 'limited' as ImageQuality,
    })),
    normalizedItems: [],
    totalEstimatedVolumeCubicYards: zero,
    totalEstimatedWeightPounds: zero,
    estimatedTruckLoadFraction: { minimum: 0, likely: 0.5, maximum: 1 },
    estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
    laborEstimate: { crewSize: 2, minimumMinutes: 60, likelyMinutes: 90, maximumMinutes: 150 },
    detectedConditions: {
      stairs: false, elevator: false, longCarry: false, narrowAccess: false,
      indoorRemoval: false, outdoorRemoval: false, disassemblyRequired: false, heavyItemsPresent: false,
      hazardousMaterialPossible: false, refrigerantAppliancePossible: false, concreteOrSoilPossible: false,
      tiresPossible: false, paintOrChemicalPossible: false,
    },
    additionalQuestions: [],
    confidence: { overall: 0, volume: 0, weight: 0, itemClassification: 0, accessDifficulty: 0 },
    warnings: [],
    reviewRequired: true,
    reviewReasons: reasons.length ? reasons : ['Automated analysis was not available.'],
  }
}
