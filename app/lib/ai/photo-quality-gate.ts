// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PHOTO-QUALITY GATE (Vision-Estimation, Phase 3).
//
// This module scores the SUBMISSION — the set of photos a customer uploaded —
// using only metadata available server-side WITHOUT pixel processing (content
// type, byte size, optional dimensions, plus any per-photo quality signals the
// analysis schema already surfaced). It answers ONE question: "is this photo set
// good enough to attempt an automated estimate, and if not, what should we ask
// the customer for?"
//
// It is DELIBERATELY NOT the same thing as `app/lib/ai/quality.ts` (which scores
// model RESPONSES) or `normalizeAnalysis`/`monitorAnalysis` (which score the AI's
// read of the photos). Those run AFTER the vision model. This gate runs BEFORE —
// or in shadow beside — that call, on cheap upload metadata, so we can bias a
// customer toward better photos instead of confidently guessing from unusable
// inputs.
//
// CONTRACT GUARANTEES:
//  • PURE + DETERMINISTIC + SIDE-EFFECT-FREE. No Date.now(), no randomness, no
//    I/O, no env reads. Same input → byte-identical output, always. Safe to
//    import and call anywhere (server, worker, test) regardless of any flag.
//  • The VISION_ESTIMATION_SHADOW flag governs whether callers SURFACE/USE this
//    output — this module never reads the flag. Computing it is always safe.
//  • NEVER throws. Malformed/empty inputs degrade to a conservative
//    manual_review / additional_photos result, never an exception.
//  • Guidance is emitted as DATA (typed string enums), not UI. Only the RELEVANT
//    strings for the detected gaps are returned.
//  • Bias toward `sufficient_with_warnings` over hard blocks. We only hard-block
//    (`additional_photos_required` / `manual_review_required`) when the set is
//    genuinely unusable, never merely imperfect.
// ─────────────────────────────────────────────────────────────────────────────

export const QUALITY_GATE_VERSION = 1

// Content types the upload route already accepts (see app/api/upload/route.ts:
// data:image/(jpeg|png|webp|heic|heif)). Kept in sync intentionally, but the
// gate is configurable so a caller can widen/narrow without editing this file.
export const DEFAULT_ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const

export type PhotoQualityClassification =
  | 'sufficient'
  | 'sufficient_with_warnings'
  | 'clarification_recommended'
  | 'additional_photos_required'
  | 'manual_review_required'

// Per-photo warning codes (stable, machine-readable — map to copy in UI later).
export type PhotoWarningCode =
  | 'unsupported_type'      // contentType not in allowedTypes
  | 'missing_type'         // no contentType at all → can't trust the file
  | 'too_small'            // bytes below minBytes → likely corrupt/thumbnail
  | 'too_large'            // bytes above maxBytes → over the upload cap
  | 'missing_bytes'        // no byte size → can't sanity-check the file
  | 'likely_duplicate'     // near-identical byte size to another photo
  | 'low_resolution'       // width/height present and below a usable floor
  | 'heic_source'          // HEIC/HEIF: accepted but advisory (often needs conversion)

// Submission-level warning codes.
export type SubmissionWarningCode =
  | 'below_recommended_count'   // usable photos < recommendedPhotos (but >= minPhotos)
  | 'duplicates_present'        // one or more likely-duplicate photos detected
  | 'possible_single_angle'     // effective usable count is low → probably one viewpoint
  | 'unusable_photos_ignored'   // some photos were dropped as unusable

// Coverage gaps we can only INFER (never pixel-detect here) — advisory.
export type MissingCoverageCode =
  | 'wide_shot'        // no clear "whole area" framing likely present
  | 'scale_reference'  // nothing to gauge size against
  | 'access_path'      // path from items to the truck not shown
  | 'hidden_items'     // stacked/obscured items not separately photographed
  | 'appliance_state'  // appliance disconnect/state not shown

// Customer-facing guidance strings, emitted as DATA keyed to the gap.
export type GuidanceCode =
  | 'add_wide_shot'
  | 'add_scale_reference'
  | 'show_access_path'
  | 'photograph_hidden_items'
  | 'show_appliance_state'
  | 'add_more_photos'
  | 'retake_unusable'
  | 'avoid_duplicates'

export const GUIDANCE_TEXT: Record<GuidanceCode, string> = {
  add_wide_shot: 'Add one wide photo showing the whole area.',
  add_scale_reference: 'Include a door or person for scale.',
  show_access_path: 'Show the path from the items to the truck.',
  photograph_hidden_items: 'Photograph stacked or hidden items separately.',
  show_appliance_state: 'Show whether the appliance is disconnected.',
  add_more_photos: 'Add a few more photos so we can estimate accurately.',
  retake_unusable: 'One or more photos could not be used — please retake them.',
  avoid_duplicates: 'Some photos look nearly identical — try different angles instead.',
}

// Reasons a submission is routed to a human instead of an automated estimate.
export type ManualReviewReason =
  | 'no_usable_photos'
  | 'all_photos_unusable'
  | 'empty_submission'

// ── Input types ──────────────────────────────────────────────────────────────

export type PhotoDescriptor = {
  id: string
  url?: string
  // Available at upload without pixel work (data-URL type). May be absent.
  contentType?: string | null
  // Byte size of the decoded image. May be absent (older uploads).
  bytes?: number | null
  // Optional — many uploads won't have these.
  width?: number | null
  height?: number | null
  // Optional per-photo signals IF the analysis schema/upstream already produced
  // them. Accepted opportunistically; absence is the common case and degrades
  // gracefully (no penalty for missing signals).
  imageQualityScore?: number | null   // 0..1, higher = better
  blurScore?: number | null           // 0..1, higher = blurrier
  brightnessScore?: number | null     // 0..1, 0=black 1=blown-out, ~0.5 ideal
  occlusionScore?: number | null      // 0..1, higher = more obstructed
}

// Optional hints a caller MAY pass (e.g. from the booking/service context) to
// sharpen coverage guidance. All optional; absence = advisory-only coverage.
export type SubmissionContext = {
  // Service involves an appliance (fridge/washer) → surface disconnect guidance.
  applianceLikely?: boolean
  // Access matters (stairs/long carry/narrow) → surface access-path guidance.
  accessMatters?: boolean
}

export type QualityGateThresholds = {
  minPhotos: number             // hard floor below which we can't estimate
  recommendedPhotos: number     // soft target for a confident estimate
  minBytes: number              // below this → likely corrupt/thumbnail
  maxBytes: number              // above this → over the upload cap
  allowedTypes: readonly string[]
  // A photo is a likely-duplicate of an earlier one when their byte sizes are
  // within this percentage of each other (near-identical-bytes heuristic).
  dupSimilarityBytesPct: number
  // Advisory: how many "wide" shots we'd like. Can't reliably detect framing
  // from metadata, so this only ever contributes advisory coverage/guidance.
  minWideShots: number
  // Optional resolution floor (px, min dimension) applied ONLY when width AND
  // height are present. Absent dimensions are never penalized.
  minDimensionPx: number
  // Per-photo signal cutoffs (applied ONLY when the signal is present).
  maxBlurScore: number          // above → count photo as unusable-quality
  maxOcclusionScore: number     // above → count photo as unusable-quality
  minImageQualityScore: number  // below → count photo as unusable-quality
}

export const DEFAULT_THRESHOLDS: QualityGateThresholds = {
  minPhotos: 2,
  recommendedPhotos: 4,
  minBytes: 12_000,          // ~12KB — smaller is almost certainly a thumbnail/corrupt
  maxBytes: 8_000_000,       // matches upload route's ~8MB data-URL cap
  allowedTypes: DEFAULT_ALLOWED_TYPES,
  dupSimilarityBytesPct: 0.5, // within 0.5% byte size → treat as near-identical
  minWideShots: 1,
  minDimensionPx: 200,
  maxBlurScore: 0.8,
  maxOcclusionScore: 0.85,
  minImageQualityScore: 0.15,
}

// ── Output types ─────────────────────────────────────────────────────────────

export type PerPhotoResult = {
  id: string
  usableForEstimate: boolean
  warnings: PhotoWarningCode[]
}

export type PhotoQualityGateResult = {
  classification: PhotoQualityClassification
  score: number                 // 0..100, higher = more estimable
  perPhoto: PerPhotoResult[]
  submissionWarnings: SubmissionWarningCode[]
  missingCoverage: MissingCoverageCode[]
  clarificationRecommendations: GuidanceCode[]
  manualReviewReasons: ManualReviewReason[]
  thresholdsVersion: number
}

// ── Helpers (pure) ───────────────────────────────────────────────────────────

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function normalizeType(t: string | null | undefined): string | null {
  if (typeof t !== 'string') return null
  const s = t.trim().toLowerCase()
  if (!s) return null
  // Accept a bare data-URL prefix or "image/jpeg;base64" style — take the mime.
  const m = s.match(/^(?:data:)?(image\/[a-z0-9.+-]+)/)
  return m ? m[1] : s
}

// ── The gate ─────────────────────────────────────────────────────────────────

export function evaluatePhotoQuality(
  photos: readonly PhotoDescriptor[] | null | undefined,
  ctx: SubmissionContext = {},
  overrides: Partial<QualityGateThresholds> = {},
): PhotoQualityGateResult {
  const t: QualityGateThresholds = { ...DEFAULT_THRESHOLDS, ...overrides }
  const list = Array.isArray(photos) ? photos : []

  // Empty submission → conservative manual review, ask for photos.
  if (list.length === 0) {
    return {
      classification: 'additional_photos_required',
      score: 0,
      perPhoto: [],
      submissionWarnings: [],
      missingCoverage: inferCoverage(0, ctx, t),
      clarificationRecommendations: ['add_more_photos'],
      manualReviewReasons: [],
      thresholdsVersion: QUALITY_GATE_VERSION,
    }
  }

  const allowed = new Set(t.allowedTypes.map(x => x.toLowerCase()))

  // First pass: per-photo intrinsic checks (type/bytes/dims/signals).
  type Work = { id: string; bytes: number | null; warnings: PhotoWarningCode[]; usable: boolean }
  const work: Work[] = list.map((p, idx) => {
    const id = typeof p?.id === 'string' && p.id ? p.id : `photo_${idx}`
    const warnings: PhotoWarningCode[] = []
    let usable = true

    const type = normalizeType(p?.contentType)
    if (type === null) {
      warnings.push('missing_type')
      // Missing type alone is not fatal (older uploads) — stays usable.
    } else if (!allowed.has(type)) {
      warnings.push('unsupported_type')
      usable = false
    } else if (type === 'image/heic' || type === 'image/heif') {
      warnings.push('heic_source') // advisory — accepted, but often needs conversion
    }

    const bytes = isFiniteNum(p?.bytes) ? (p!.bytes as number) : null
    if (bytes === null) {
      warnings.push('missing_bytes')
    } else if (bytes < t.minBytes) {
      warnings.push('too_small')
      usable = false
    } else if (bytes > t.maxBytes) {
      warnings.push('too_large')
      usable = false
    }

    // Resolution floor — ONLY when both dims present.
    if (isFiniteNum(p?.width) && isFiniteNum(p?.height)) {
      const minDim = Math.min(p!.width as number, p!.height as number)
      if (minDim > 0 && minDim < t.minDimensionPx) {
        warnings.push('low_resolution')
        usable = false
      }
    }

    // Optional per-photo pixel signals — penalize ONLY when present.
    if (isFiniteNum(p?.blurScore) && (p!.blurScore as number) > t.maxBlurScore) usable = false
    if (isFiniteNum(p?.occlusionScore) && (p!.occlusionScore as number) > t.maxOcclusionScore) usable = false
    if (isFiniteNum(p?.imageQualityScore) && (p!.imageQualityScore as number) < t.minImageQualityScore) usable = false

    return { id, bytes, warnings, usable }
  })

  // Second pass: duplicate detection by near-identical byte size. First
  // occurrence in a near-size group is the "keeper"; later ones are flagged.
  // Deterministic: input order is the tie-break.
  let duplicateCount = 0
  for (let i = 0; i < work.length; i++) {
    const a = work[i]
    if (a.bytes === null) continue
    for (let j = 0; j < i; j++) {
      const b = work[j]
      if (b.bytes === null) continue
      if (b.warnings.includes('likely_duplicate')) continue // don't chain off a dup
      const larger = Math.max(a.bytes, b.bytes)
      if (larger === 0) continue
      const pct = (Math.abs(a.bytes - b.bytes) / larger) * 100
      if (pct <= t.dupSimilarityBytesPct) {
        if (!a.warnings.includes('likely_duplicate')) {
          a.warnings.push('likely_duplicate')
          duplicateCount++
        }
        break
      }
    }
  }

  const perPhoto: PerPhotoResult[] = work.map(w => ({
    id: w.id,
    usableForEstimate: w.usable,
    warnings: w.warnings,
  }))

  const usable = work.filter(w => w.usable)
  const usableCount = usable.length
  const unusableCount = work.length - usableCount

  // "Effective" count discounts likely-duplicates among the usable set — they
  // still count, but as fractional coverage (a dup adds little new information).
  const usableDuplicates = usable.filter(w => w.warnings.includes('likely_duplicate')).length
  const effectiveCount = usableCount - usableDuplicates * 0.5

  // ── Assemble submission warnings ──
  const submissionWarnings: SubmissionWarningCode[] = []
  if (duplicateCount > 0) submissionWarnings.push('duplicates_present')
  if (unusableCount > 0) submissionWarnings.push('unusable_photos_ignored')
  if (usableCount >= t.minPhotos && usableCount < t.recommendedPhotos) {
    submissionWarnings.push('below_recommended_count')
  }
  if (usableCount >= t.minPhotos && effectiveCount < t.minPhotos + 0.5) {
    submissionWarnings.push('possible_single_angle')
  }

  // ── Coverage (advisory, inferred from effective count + context) ──
  const missingCoverage = inferCoverage(effectiveCount, ctx, t)

  // ── Manual-review reasons ──
  const manualReviewReasons: ManualReviewReason[] = []
  if (usableCount === 0) {
    // Every photo was unusable (vs. an empty submission handled earlier).
    manualReviewReasons.push(unusableCount === work.length ? 'all_photos_unusable' : 'no_usable_photos')
  }

  // ── Classification (deterministic decision tree) ──
  // Order matters: hardest signals first, then soften.
  let classification: PhotoQualityClassification
  if (usableCount === 0) {
    classification = 'manual_review_required'
  } else if (usableCount < t.minPhotos) {
    classification = 'additional_photos_required'
  } else {
    // We have enough usable photos. Decide how much to nudge.
    const minorOnly =
      submissionWarnings.length === 0 &&
      missingCoverage.length === 0
    if (minorOnly) {
      classification = 'sufficient'
    } else if (usableCount < t.recommendedPhotos || effectiveCount < t.minPhotos + 0.5) {
      // Enough to try, but thin — recommend clarification rather than block.
      classification = 'clarification_recommended'
    } else {
      // Plenty of usable photos; the remaining flags are minor (e.g. a dup or an
      // advisory coverage hint). Warn, don't block.
      classification = 'sufficient_with_warnings'
    }
  }

  // ── Guidance (only the relevant strings) ──
  const clarificationRecommendations = buildGuidance({
    classification,
    usableCount,
    minPhotos: t.minPhotos,
    duplicateCount,
    unusableCount,
    missingCoverage,
  })

  // ── Score (0..100) — a transparent, monotonic composite. Advisory only. ──
  const score = computeScore({
    usableCount,
    effectiveCount,
    total: work.length,
    recommended: t.recommendedPhotos,
    minPhotos: t.minPhotos,
    duplicateCount,
    unusableCount,
    coverageGaps: missingCoverage.length,
  })

  return {
    classification,
    score,
    perPhoto,
    submissionWarnings,
    missingCoverage,
    clarificationRecommendations,
    manualReviewReasons,
    thresholdsVersion: QUALITY_GATE_VERSION,
  }
}

// Coverage is INFERRED, never pixel-detected. We surface advisory gaps based on
// how many effective viewpoints we have plus optional context hints.
function inferCoverage(
  effectiveCount: number,
  ctx: SubmissionContext,
  t: QualityGateThresholds,
): MissingCoverageCode[] {
  const out: MissingCoverageCode[] = []
  // With few viewpoints we likely lack a wide framing and scale reference.
  if (effectiveCount < Math.max(t.minWideShots + 1, t.recommendedPhotos - 1)) {
    out.push('wide_shot')
  }
  if (effectiveCount < t.recommendedPhotos - 1) {
    out.push('scale_reference')
  }
  if (ctx.accessMatters) out.push('access_path')
  if (effectiveCount > 0 && effectiveCount < t.minPhotos + 1) out.push('hidden_items')
  if (ctx.applianceLikely) out.push('appliance_state')
  return out
}

function buildGuidance(input: {
  classification: PhotoQualityClassification
  usableCount: number
  minPhotos: number
  duplicateCount: number
  unusableCount: number
  missingCoverage: MissingCoverageCode[]
}): GuidanceCode[] {
  const out = new Set<GuidanceCode>()

  if (input.classification === 'additional_photos_required' || input.usableCount < input.minPhotos) {
    out.add('add_more_photos')
  }
  if (input.unusableCount > 0) out.add('retake_unusable')
  if (input.duplicateCount > 0) out.add('avoid_duplicates')

  for (const c of input.missingCoverage) {
    switch (c) {
      case 'wide_shot': out.add('add_wide_shot'); break
      case 'scale_reference': out.add('add_scale_reference'); break
      case 'access_path': out.add('show_access_path'); break
      case 'hidden_items': out.add('photograph_hidden_items'); break
      case 'appliance_state': out.add('show_appliance_state'); break
    }
  }
  return Array.from(out)
}

function computeScore(input: {
  usableCount: number
  effectiveCount: number
  total: number
  recommended: number
  minPhotos: number
  duplicateCount: number
  unusableCount: number
  coverageGaps: number
}): number {
  if (input.usableCount === 0) return 0
  // Base: how close effective usable coverage is to the recommended target.
  const target = Math.max(1, input.recommended)
  const coverage = clamp(input.effectiveCount / target, 0, 1) // 0..1
  let s = 40 + coverage * 55 // 40..95 for having any usable coverage
  // Penalties (bounded, deterministic).
  s -= input.duplicateCount * 4
  s -= input.unusableCount * 6
  s -= input.coverageGaps * 3
  // Below the hard floor never scores as "estimable".
  if (input.usableCount < input.minPhotos) s = Math.min(s, 35)
  return Math.round(clamp(s, 0, 100))
}
