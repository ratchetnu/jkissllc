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
  /** Index of the photo the item was seen in — the compact contract's only evidence. */
  photoIndex?: number
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
  quantity: number        // are the counts right? (stacked boxes, occluded piles)
  volume: number          // is the cubic estimate sound?
  access: number          // stairs / carry / doorways
  labor: number           // crew + hours
}

/** The dimensions `overall` is not allowed to materially exceed. */
/** What an unparseable or absent confidence becomes: uncertain, not confident. */
export const UNKNOWN_CONFIDENCE = 0.3

export const CRITICAL_CONFIDENCE_DIMENSIONS = ['inventory', 'quantity', 'volume', 'access'] as const

/**
 * Parse ONE confidence value under a strict contract.
 *
 * Every live moving case came back 1.0 on all five dimensions, which put the whole
 * sample in the top calibration band with a 56% false-high rate. The old parser
 * took `num(v, 0.5)` and clamped to 0..1 — so a model answering in percent (85)
 * became a perfect 1.0, and a string or a missing field became 0.5 with no trace.
 * Clamping an out-of-contract value is what manufactured the confidence.
 *
 * Now: numbers only, finite only, 0..1 only. Anything else is REJECTED — reported
 * as invalid and treated as unknown, never silently rewritten to 1.0.
 */
export function parseConfidenceValue(v: unknown): { value: number | null; problem?: string } {
  if (v === undefined || v === null) return { value: null, problem: 'missing' }
  if (typeof v === 'string') return { value: null, problem: 'string' }
  if (typeof v !== 'number' || !Number.isFinite(v)) return { value: null, problem: 'not-a-number' }
  // 85 is a percentage, not a confidence. Clamping it to 1 is how "certain" was invented.
  if (v > 1) return { value: null, problem: 'above-1 (percentage?)' }
  if (v < 0) return { value: null, problem: 'negative' }
  return { value: v }
}

/** Evidence weaknesses that must pull confidence down, whatever the model claimed. */
export type ConfidencePenaltyInput = {
  incompleteCoverage: boolean     // limited/unusable photos, or a self-flagged partial read
  duplicateUncertainty: boolean   // the same room possibly counted twice
  uncertainVolume: boolean        // a wide volume range is not a confident one
  missingAccessInfo: boolean      // no access view, or access facts asked for in `miss`
}

/** Ceiling applied to a dimension when the evidence behind it is weak. */
const WEAK_EVIDENCE_CEILING = 0.6
/** `overall` may sit at most this far above the weakest critical dimension. */
const OVERALL_TOLERANCE = 0.05

/**
 * Bring a claimed confidence object back to what the evidence supports.
 *
 * The model is not asked to be humble and then trusted to be — the penalties are
 * applied here, from facts the normalizer can see for itself: photo quality, a
 * duplicate flag, the width of the volume range, whether access was ever visible.
 * A read with any of those weaknesses cannot come out all-1.0.
 */
export function normalizeConfidence(claimed: MovingConfidence, ev: ConfidencePenaltyInput): MovingConfidence {
  const out: MovingConfidence = { ...claimed }
  const cap = (k: keyof MovingConfidence) => { out[k] = Math.min(out[k], WEAK_EVIDENCE_CEILING) }

  if (ev.incompleteCoverage) { cap('inventory'); cap('quantity'); cap('volume'); cap('overall') }
  if (ev.duplicateUncertainty) { cap('quantity'); cap('overall') }
  if (ev.uncertainVolume) { cap('volume'); cap('overall') }
  if (ev.missingAccessInfo) { cap('access') }

  // `overall` is a summary, not an independent claim: it cannot outrun the weakest
  // thing it summarises. Without this, a model can report inventory 0.4 and overall
  // 1.0, and every downstream threshold reads the 1.0.
  const weakest = Math.min(...CRITICAL_CONFIDENCE_DIMENSIONS.map(k => out[k]))
  out.overall = Math.min(out.overall, weakest + OVERALL_TOLERANCE, 1)

  for (const k of Object.keys(out) as (keyof MovingConfidence)[]) {
    out[k] = Math.max(0, Math.min(1, Math.round(out[k] * 100) / 100))
  }
  return out
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


// ── Compact wire format ──────────────────────────────────────────────────────
// The model answers in short keys and enum codes, then this module expands it to
// the descriptive shape the rest of the lane already consumes. The compression is
// not cosmetic: at ~74 output tokens per item the verbose contract truncated a
// three-bedroom inventory mid-object, and a cut-off JSON is discarded entirely —
// the read fails not because the model could not see, but because it ran out of
// room to say so. Short keys, enum codes and no prose cost ~19 tokens per item.

const CAT_CODES: Record<string, MovingItemCategory> = {
  furn: 'furniture', appl: 'appliance', elec: 'electronics', matt: 'mattress',
  box: 'box_container', frag: 'fragile', art: 'artwork', exer: 'exercise_equipment',
  patio: 'outdoor_patio', over: 'oversized_specialty', unk: 'unknown',
}
const SIZE_CODES: Record<string, ItemSizeClass> = { s: 'small', m: 'medium', l: 'large', x: 'oversized' }
/** Access codes → the boolean field each one sets. */
const ACCESS_CODES: Record<string, keyof MovingAccessConditions> = {
  stairs: 'stairsVisible', elev: 'elevatorVisible', carry: 'longCarryLikely', narrow: 'narrowAccess',
}
/**
 * Missing-information codes → the customer-facing phrase. The model emits codes so
 * it cannot spend fifty tokens composing a sentence; the wording lives here, where
 * it is also identical to what missingRequiredFacts() produces from booking data.
 */
export const MISSING_CODES: Record<string, string> = {
  dest: 'Destination address',
  dist: 'Travel distance between addresses',
  stairs: 'Stairs or elevator at either address',
  park: 'Parking or truck access',
  pack: 'Packing services needed',
}

/** [min, likely, max] → Range. Accepts a bare number or a 2-element [min,max]. */
function tuple(v: unknown, lo: number, hi: number, fallback: Range): Range {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const n = clamp(v, lo, hi); return { minimum: n, likely: n, maximum: n }
  }
  if (!Array.isArray(v) || v.length === 0) return { ...fallback }
  const ns = v.map(x => clamp(num(x, 0), lo, hi)).filter(n => Number.isFinite(n))
  if (ns.length === 0) return { ...fallback }
  if (ns.length === 1) return { minimum: ns[0], likely: ns[0], maximum: ns[0] }
  if (ns.length === 2) return { minimum: Math.min(...ns), likely: (ns[0] + ns[1]) / 2, maximum: Math.max(...ns) }
  const [a, b, c] = ns
  return { minimum: Math.min(a, b, c), likely: clamp(b, Math.min(a, c), Math.max(a, c)), maximum: Math.max(a, b, c) }
}

function compactItem(raw: unknown): DetectedMovingItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const label = str(o.l ?? o.label, 80).trim()
  if (!label) return null
  const sizeClass = SIZE_CODES[str(o.s, 4)] ?? 'medium'
  // Only TRUE flags are transmitted; an absent key means false, not unknown.
  const fl = Array.isArray(o.fl) ? o.fl.map(x => String(x)) : []
  const cat = CAT_CODES[str(o.cat, 8)] ?? 'unknown'
  const p = Number.isFinite(num(o.p, NaN)) ? Math.max(0, Math.round(num(o.p, 0))) : undefined
  return {
    category: cat,
    label,
    quantity: tuple(o.q, 0, 500, { minimum: 1, likely: 1, maximum: 1 }),
    sizeClass,
    estimatedVolumeCubicFeet: clamp(num(o.v, 0), 0, 2000),
    bulky: fl.includes('b') || sizeClass === 'large' || sizeClass === 'oversized',
    fragile: fl.includes('f') || cat === 'fragile',
    requiresDisassembly: fl.includes('d'),
    isAppliance: fl.includes('a') || cat === 'appliance',
    confidence: clamp(num(o.c, 0.5), 0, 1),
    photoIndex: p,
    evidence: '',
  }
}

/** True when the payload speaks the compact contract rather than the legacy one. */
function isCompact(o: Record<string, unknown>): boolean {
  return Array.isArray(o.items) || Array.isArray(o.photos) || Array.isArray(o.truck)
}

function normalizeCompact(o: Record<string, unknown>, ctx: NormalizeMovingCtx): MovingPhotoAnalysis {
  const items = (Array.isArray(o.items) ? o.items : [])
    .map(compactItem).filter((x): x is DetectedMovingItem => x !== null).slice(0, 60)

  const photos = Array.isArray(o.photos) ? o.photos : []
  const observations: MovingPhotoObservation[] = ctx.photoUrls.map((url, i) => {
    const raw = (photos.find(x => x && typeof x === 'object' && num((x as Record<string, unknown>).p, -1) === i)
      ?? photos[i] ?? {}) as Record<string, unknown>
    const dup = num(raw.dup, -1)
    return {
      photoUrl: url,
      visibleItems: items.filter(it => it.photoIndex === i),
      possibleDuplicateViewOfOtherPhoto: dup >= 0 && dup !== i,
      duplicateGroupId: dup >= 0 && dup !== i ? `g${Math.min(dup, i)}` : undefined,
      imageQuality: oneOf(raw.iq, ['excellent', 'good', 'limited', 'unusable'] as const, 'good'),
    }
  })

  const accCodes = Array.isArray(o.acc) ? o.acc.map(x => String(x)) : []
  const access: MovingAccessConditions = {
    stairsVisible: false, elevatorVisible: false, longCarryLikely: false, narrowAccess: false,
    disassemblyRequired: items.some(i => i.requiresDisassembly),
    applianceHandling: items.some(i => i.isAppliance),
    fragileHandling: items.some(i => i.fragile),
    oversizedItemPresent: items.some(i => i.sizeClass === 'oversized'),
  }
  for (const code of accCodes) {
    const field = ACCESS_CODES[code]
    if (field) access[field] = true
  }

  const rawConf = (o.conf && typeof o.conf === 'object' ? o.conf : {}) as Record<string, unknown>
  // Strict: an invalid or missing value is NOT quietly turned into a number the
  // model never gave. It lands at UNKNOWN_CONFIDENCE and is named in the warnings,
  // so a run full of unparseable confidence looks like a defect rather than like
  // an unusually sure model.
  const confProblems: string[] = []
  const cf = (k: string, label: string) => {
    const r = parseConfidenceValue(rawConf[k])
    if (r.value === null) { confProblems.push(`${label} confidence ${r.problem}`); return UNKNOWN_CONFIDENCE }
    return r.value
  }

  const volFromItems = items.reduce((sum, i) => sum + i.estimatedVolumeCubicFeet * Math.max(1, i.quantity.likely), 0)
  const volRange = tuple(o.vol, 0, 12000, {
    minimum: volFromItems * 0.8, likely: volFromItems, maximum: volFromItems * 1.25,
  })
  const missCodes = (Array.isArray(o.miss) ? o.miss : []).map(x => String(x))
  const missing = missCodes.map(x => MISSING_CODES[x] ?? x.slice(0, 80)).slice(0, 10)

  const reviewReasons = (Array.isArray(o.why) ? o.why.map(x => String(x).slice(0, 120)) : [])
  const unusable = observations.length > 0 && observations.every(p => p.imageQuality === 'unusable')
  if (items.length === 0) reviewReasons.push('No movable items could be identified from the photos.')
  if (unusable) reviewReasons.push('Photos were unusable.')

  return {
    analysisId: ctx.analysisId, bookingId: ctx.bookingId,
    schemaVersion: MOVING_ANALYSIS_SCHEMA_VERSION,
    modelProvider: ctx.modelProvider, modelName: ctx.modelName, analyzedAt: ctx.analyzedAt,
    normalizedItems: items,
    photoObservations: observations,
    boxCount: tuple(o.box, 0, 1000, { minimum: 0, likely: 0, maximum: 0 }),
    totalEstimatedVolumeCubicFeet: volRange,
    estimatedTruckSpaceFraction: tuple(o.truck, 0, 6, { minimum: 0, likely: 0, maximum: 0 }),
    recommendedCrewSize: tuple(o.crew, 1, 8, { minimum: 2, likely: 2, maximum: 3 }),
    estimatedLoadingHours: tuple(o.load, 0, 40, { minimum: 0, likely: 0, maximum: 0 }),
    estimatedUnloadingHours: tuple(o.unload, 0, 40, { minimum: 0, likely: 0, maximum: 0 }),
    access,
    confidence: normalizeConfidence(
      {
        overall: cf('o', 'overall'), inventory: cf('i', 'inventory'), quantity: cf('q', 'quantity'),
        volume: cf('v', 'volume'), access: cf('a', 'access'), labor: cf('l', 'labour'),
      },
      {
        // Every signal below is observed here, not taken on trust from the model.
        incompleteCoverage: observations.some(p => p.imageQuality === 'limited' || p.imageQuality === 'unusable')
          || o.rev === true || items.length === 0,
        duplicateUncertainty: observations.some(p => p.possibleDuplicateViewOfOtherPhoto),
        // A volume range wider than 1.5x from end to end is an uncertain one.
        uncertainVolume: volRange.minimum > 0 && volRange.maximum / volRange.minimum > 1.5,
        // Access was never seen, or the model itself asked for it.
        missingAccessInfo: accCodes.length === 0
          || missCodes.includes('stairs') || missCodes.includes('park'),
      },
    ),
    missingInformation: missing,
    additionalQuestions: [],
    warnings: confProblems.slice(0, 6),
    reviewRequired: o.rev === true || items.length === 0 || unusable,
    reviewReasons: Array.from(new Set(reviewReasons)).slice(0, 8),
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
    confidence: { overall: 0, inventory: 0, quantity: 0, volume: 0, access: 0, labor: 0 },
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
  // The compact contract is what the prompt asks for; the verbose path below is
  // kept so a stored or replayed legacy response still normalizes.
  if (isCompact(o)) return normalizeCompact(o, ctx)

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
    overall: conf('overall'), inventory: conf('inventory'), quantity: conf('quantity'),
    volume: conf('volume'), access: conf('access'), labor: conf('labor'),
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
