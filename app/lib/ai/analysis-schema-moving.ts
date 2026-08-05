// ─────────────────────────────────────────────────────────────────────────────
// Structured MOVING-photo analysis schema + a dependency-free normalizer.
//
// A relocation inventory, NOT discard material. Every item here is going on a
// truck and coming back off it at the other end — so the operational questions
// are volume, fragility, disassembly, access and labor, and there is deliberately
// no representation of a landfill trip, a dump fee, a disposal category or a
// debris weight anywhere in this file. If a moving job ever needs one of those,
// something upstream has mis-routed.
//
// Same contract as the junk normalizer: the vision model is UNTRUSTED, this
// module clamps/defaults/range-checks every field, it NEVER throws, and it NEVER
// produces a price. When the output is too thin to act on it sets
// `reviewRequired` so a human takes the job rather than a confident guess going
// to a customer.
// ─────────────────────────────────────────────────────────────────────────────

export const MOVING_ANALYSIS_SCHEMA_VERSION = 1

export type MovingItemCategory =
  | 'furniture' | 'appliance' | 'electronics' | 'mattress' | 'box_container'
  | 'fragile' | 'artwork' | 'exercise_equipment' | 'outdoor_patio'
  | 'oversized_specialty' | 'unknown'

export const MOVING_ITEM_CATEGORIES: MovingItemCategory[] = [
  'furniture', 'appliance', 'electronics', 'mattress', 'box_container',
  'fragile', 'artwork', 'exercise_equipment', 'outdoor_patio',
  'oversized_specialty', 'unknown',
]

/** Size class drives crew and handling, independent of raw cubic volume. */
export type ItemSizeClass = 'small' | 'medium' | 'large' | 'oversized'
export const ITEM_SIZE_CLASSES: ItemSizeClass[] = ['small', 'medium', 'large', 'oversized']

export type ImageQuality = 'excellent' | 'good' | 'limited' | 'unusable'

/** A bounded estimate. A point value from a photo would be false precision. */
export type Range = { minimum: number; likely: number; maximum: number }

export type DetectedMovingItem = {
  category: MovingItemCategory
  label: string
  quantity: Range               // a range: stacked boxes are countable only approximately
  sizeClass: ItemSizeClass
  estimatedVolumeCubicFeet: number
  bulky: boolean
  fragile: boolean
  requiresDisassembly: boolean
  isAppliance: boolean
  confidence: number            // 0..1
  evidence: string
}

export type MovingPhotoObservation = {
  photoUrl: string
  visibleItems: DetectedMovingItem[]
  possibleDuplicateViewOfOtherPhoto: boolean
  duplicateGroupId?: string
  imageQuality: ImageQuality
}

/**
 * Access facts that change labor. Every one is `false` unless the model can SEE
 * it — absence of evidence is not evidence of absence, which is why the missing
 * ones are reported through `missingInformation` instead of being guessed.
 */
export type MovingAccessConditions = {
  stairsVisible: boolean
  elevatorVisible: boolean
  longCarryLikely: boolean
  narrowAccess: boolean
  disassemblyRequired: boolean
  applianceHandling: boolean
  fragileHandling: boolean
  oversizedItemPresent: boolean
}

export type MovingConfidence = {
  overall: number
  inventory: number       // did we see the whole inventory?
  volume: number          // is the cubic estimate sound?
  access: number          // stairs / carry / doorways
  labor: number           // crew + hours
}

export type MovingPhotoAnalysis = {
  analysisId: string
  bookingId: string
  schemaVersion: number
  modelProvider: string
  modelName: string
  analyzedAt: string

  normalizedItems: DetectedMovingItem[]
  photoObservations: MovingPhotoObservation[]
  boxCount: Range
  totalEstimatedVolumeCubicFeet: Range
  estimatedTruckSpaceFraction: Range     // fraction of ONE configured truck (0..6)
  recommendedCrewSize: Range
  estimatedLoadingHours: Range
  estimatedUnloadingHours: Range
  access: MovingAccessConditions
  confidence: MovingConfidence

  /**
   * Non-visual facts a photo CANNOT supply — destination, travel distance, floor
   * number, elevator reservation, parking. Populated by the caller from booking
   * data, not by the model. A non-empty list is what drives `needs_information`
   * rather than an invented number.
   */
  missingInformation: string[]
  additionalQuestions: string[]
  warnings: string[]
  reviewRequired: boolean
  reviewReasons: string[]
}

export type NormalizeMovingCtx = {
  analysisId: string
  bookingId: string
  photoUrls: string[]
  modelProvider: string
  modelName: string
  analyzedAt: string
}

// ── primitives ───────────────────────────────────────────────────────────────

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  return Number.isFinite(n) ? n : fallback
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '')
const bool = (v: unknown): boolean => v === true
const strList = (v: unknown, max = 8): string[] =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, max).map(s => s.slice(0, 240)) : []

/**
 * Coerce to an ordered range. Accepts a bare number (a model that ignored the
 * range instruction) by widening it to a degenerate range rather than discarding
 * the read — but the ordering min ≤ likely ≤ max is always enforced, because
 * downstream pricing indexes into it positionally.
 */
function range(v: unknown, lo: number, hi: number, fallback: Range): Range {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const n = clamp(v, lo, hi)
    return { minimum: n, likely: n, maximum: n }
  }
  if (!v || typeof v !== 'object') return { ...fallback }
  const o = v as Record<string, unknown>
  const likely = clamp(num(o.likely, fallback.likely), lo, hi)
  const minimum = clamp(num(o.minimum, likely), lo, hi)
  const maximum = clamp(num(o.maximum, likely), lo, hi)
  return {
    minimum: Math.min(minimum, likely, maximum),
    likely: clamp(likely, Math.min(minimum, maximum), Math.max(minimum, maximum)),
    maximum: Math.max(minimum, likely, maximum),
  }
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : fallback)

function item(raw: unknown): DetectedMovingItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const label = str(o.label, 80).trim()
  if (!label) return null
  const sizeClass = oneOf(o.sizeClass, ITEM_SIZE_CLASSES, 'medium')
  return {
    category: oneOf(o.category, MOVING_ITEM_CATEGORIES, 'unknown'),
    label,
    quantity: range(o.quantity ?? o.estimatedQuantity, 0, 500, { minimum: 1, likely: 1, maximum: 1 }),
    sizeClass,
    estimatedVolumeCubicFeet: clamp(num(o.estimatedVolumeCubicFeet, 0), 0, 2000),
    bulky: bool(o.bulky) || sizeClass === 'large' || sizeClass === 'oversized',
    fragile: bool(o.fragile),
    requiresDisassembly: bool(o.requiresDisassembly),
    isAppliance: bool(o.isAppliance) || o.category === 'appliance',
    confidence: clamp(num(o.confidence, 0.5), 0, 1),
    evidence: str(o.evidence, 240),
  }
}

function observation(raw: unknown, fallbackUrl: string): MovingPhotoObservation {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const visible = Array.isArray(o.visibleItems)
    ? o.visibleItems.map(item).filter((x): x is DetectedMovingItem => x !== null).slice(0, 40)
    : []
  return {
    photoUrl: str(o.photoUrl, 500) || fallbackUrl,
    visibleItems: visible,
    possibleDuplicateViewOfOtherPhoto: bool(o.possibleDuplicateViewOfOtherPhoto),
    duplicateGroupId: typeof o.duplicateGroupId === 'string' ? o.duplicateGroupId.slice(0, 40) : undefined,
    imageQuality: oneOf(o.imageQuality, ['excellent', 'good', 'limited', 'unusable'] as const, 'good'),
  }
}

function parse(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    const o = JSON.parse(s)
    return o && typeof o === 'object' ? o as Record<string, unknown> : null
  } catch {
    // Salvage the first balanced object — models occasionally prepend prose.
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        const o = JSON.parse(s.slice(start, end + 1))
        return o && typeof o === 'object' ? o as Record<string, unknown> : null
      } catch { return null }
    }
    return null
  }
}

/** The always-safe result: a real analysis object that routes to a human. */
export function reviewFallbackMovingAnalysis(ctx: NormalizeMovingCtx, reasons: string[]): MovingPhotoAnalysis {
  const zero: Range = { minimum: 0, likely: 0, maximum: 0 }
  return {
    analysisId: ctx.analysisId, bookingId: ctx.bookingId,
    schemaVersion: MOVING_ANALYSIS_SCHEMA_VERSION,
    modelProvider: ctx.modelProvider, modelName: ctx.modelName, analyzedAt: ctx.analyzedAt,
    normalizedItems: [],
    photoObservations: ctx.photoUrls.map(u => ({
      photoUrl: u, visibleItems: [], possibleDuplicateViewOfOtherPhoto: false, imageQuality: 'limited' as ImageQuality,
    })),
    boxCount: { ...zero },
    totalEstimatedVolumeCubicFeet: { ...zero },
    estimatedTruckSpaceFraction: { ...zero },
    recommendedCrewSize: { minimum: 2, likely: 2, maximum: 3 },
    estimatedLoadingHours: { ...zero },
    estimatedUnloadingHours: { ...zero },
    access: {
      stairsVisible: false, elevatorVisible: false, longCarryLikely: false, narrowAccess: false,
      disassemblyRequired: false, applianceHandling: false, fragileHandling: false, oversizedItemPresent: false,
    },
    confidence: { overall: 0, inventory: 0, volume: 0, access: 0, labor: 0 },
    missingInformation: [],
    additionalQuestions: [],
    warnings: [],
    reviewRequired: true,
    reviewReasons: reasons.slice(0, 8),
  }
}

/**
 * Normalize untrusted model output into a MovingPhotoAnalysis. Never throws.
 * An unparseable or empty read returns the review fallback — NOT a zero-volume
 * "successful" analysis, which would price as a free move.
 */
export function normalizeMovingAnalysis(raw: unknown, ctx: NormalizeMovingCtx): MovingPhotoAnalysis {
  const o = parse(raw)
  if (!o) return reviewFallbackMovingAnalysis(ctx, ['The photo analysis could not be read.'])

  const observations = Array.isArray(o.photoObservations)
    ? o.photoObservations.map((r, i) => observation(r, ctx.photoUrls[i] ?? ctx.photoUrls[0] ?? ''))
    : ctx.photoUrls.map(u => observation(null, u))

  const declared = Array.isArray(o.normalizedItems)
    ? o.normalizedItems.map(item).filter((x): x is DetectedMovingItem => x !== null)
    : []
  // Fall back to the per-photo items when the model filled only the observations.
  const items = (declared.length > 0
    ? declared
    : observations.flatMap(p => p.visibleItems)).slice(0, 60)

  const rawAccess = (o.access && typeof o.access === 'object' ? o.access : {}) as Record<string, unknown>
  const access: MovingAccessConditions = {
    stairsVisible: bool(rawAccess.stairsVisible),
    elevatorVisible: bool(rawAccess.elevatorVisible),
    longCarryLikely: bool(rawAccess.longCarryLikely),
    narrowAccess: bool(rawAccess.narrowAccess),
    // Derived floors: an item the model itself flagged forces the condition on,
    // so a self-contradicting read (fragile item, fragileHandling false) resolves
    // toward more care rather than less.
    disassemblyRequired: bool(rawAccess.disassemblyRequired) || items.some(i => i.requiresDisassembly),
    applianceHandling: bool(rawAccess.applianceHandling) || items.some(i => i.isAppliance),
    fragileHandling: bool(rawAccess.fragileHandling) || items.some(i => i.fragile),
    oversizedItemPresent: bool(rawAccess.oversizedItemPresent) || items.some(i => i.sizeClass === 'oversized'),
  }

  const rawConf = (o.confidence && typeof o.confidence === 'object' ? o.confidence : {}) as Record<string, unknown>
  const conf = (k: string, d = 0.5) => clamp(num(rawConf[k], d), 0, 1)
  const confidence: MovingConfidence = {
    overall: conf('overall'), inventory: conf('inventory'), volume: conf('volume'),
    access: conf('access'), labor: conf('labor'),
  }

  const volumeFromItems = items.reduce((sum, i) => sum + i.estimatedVolumeCubicFeet * Math.max(1, i.quantity.likely), 0)
  const totalVolume = range(o.totalEstimatedVolumeCubicFeet, 0, 12000, {
    minimum: volumeFromItems * 0.8, likely: volumeFromItems, maximum: volumeFromItems * 1.25,
  })

  const warnings = strList(o.warnings)
  const reviewReasons = strList(o.reviewReasons)
  const unusable = observations.length > 0 && observations.every(p => p.imageQuality === 'unusable')
  const noItems = items.length === 0

  if (noItems) reviewReasons.push('No movable items could be identified from the photos.')
  if (unusable) reviewReasons.push('Photos were unusable.')

  return {
    analysisId: ctx.analysisId, bookingId: ctx.bookingId,
    schemaVersion: MOVING_ANALYSIS_SCHEMA_VERSION,
    modelProvider: ctx.modelProvider, modelName: ctx.modelName, analyzedAt: ctx.analyzedAt,
    normalizedItems: items,
    photoObservations: observations,
    boxCount: range(o.boxCount, 0, 1000, { minimum: 0, likely: 0, maximum: 0 }),
    totalEstimatedVolumeCubicFeet: totalVolume,
    estimatedTruckSpaceFraction: range(o.estimatedTruckSpaceFraction, 0, 6, { minimum: 0, likely: 0, maximum: 0 }),
    recommendedCrewSize: range(o.recommendedCrewSize, 1, 8, { minimum: 2, likely: 2, maximum: 3 }),
    estimatedLoadingHours: range(o.estimatedLoadingHours, 0, 40, { minimum: 0, likely: 0, maximum: 0 }),
    estimatedUnloadingHours: range(o.estimatedUnloadingHours, 0, 40, { minimum: 0, likely: 0, maximum: 0 }),
    access,
    confidence,
    missingInformation: strList(o.missingInformation),
    additionalQuestions: strList(o.additionalQuestions, 6),
    warnings,
    reviewRequired: bool(o.reviewRequired) || noItems || unusable,
    reviewReasons: Array.from(new Set(reviewReasons)).slice(0, 8),
  }
}
