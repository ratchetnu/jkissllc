// ─────────────────────────────────────────────────────────────────────────────
// Vision benchmark — dataset schema and licensing policy.
//
// WHAT THIS DATASET IS FOR. Evaluating, calibrating and regression-testing OUR
// analyzer: the prompts, the response schema, the confidence thresholds and the
// deterministic pricing rules. Downloading images does not train or improve the
// underlying vision model and nothing here should be described as if it did.
//
// WHERE THE IMAGES LIVE. Outside this repository, always. The repo carries the
// tooling, the schemas and the manifests; the binaries live in the external store
// (VISION_BENCHMARK_DIR, default ~/jkiss-vision-benchmark). Benchmark images never
// enter Production storage and are never mixed with real customer uploads.
//
// LICENSING POSTURE — deliberately conservative. We are evaluating a COMMERCIAL
// product, so a NonCommercial licence is not a safe basis for automated download,
// whatever the intent. Only licences that permit commercial use AND modification
// are auto-accepted. Everything else is recorded in the rejected-source log with
// its reason and is never fetched. `licenseVerified` stays false until a human
// confirms it: an API's licence field is a strong signal, not a legal opinion.
// ─────────────────────────────────────────────────────────────────────────────

export type JobType = 'junk_removal' | 'moving'
export type Lighting = 'bright' | 'normal' | 'dim'
export type Clutter = 'low' | 'medium' | 'high'
export type ImageQuality = 'high' | 'medium' | 'low'
export type ReviewStatus = 'pending' | 'approved' | 'rejected'
/**
 * Label lifecycle, deliberately separate from `reviewStatus`. An image can be
 * APPROVED (licence + content cleared) yet carry no ground truth at all. Only
 * `verified` counts for accuracy — a draft is a human's work-in-progress and is
 * excluded from scoring exactly like a blank.
 */
export type LabelStatus = 'unlabelled' | 'draft' | 'verified'
export type LabelConfidence = 'high' | 'medium' | 'low'
/** How hard this case is for a human — drives the easy/normal/difficult mix. */
export type Difficulty = 'easy' | 'normal' | 'difficult'
/** Which slice of the dataset an image belongs to. Assigned once, never moved. */
export type Split = 'development' | 'holdout' | 'edge_case' | 'unassigned'

export type Range = { min: number; max: number }

/** One accepted (or pending) benchmark image. Mirrors the manifest entry exactly. */
export type ManifestEntry = {
  id: string
  jobType: JobType
  category: string
  sourcePageUrl: string
  sourceImageUrl: string
  sourceDomain: string
  license: string
  licenseVerified: boolean
  downloadPermitted: boolean
  searchQuery: string
  // ── Ground truth. EMPTY until a human labels it. Never inferred from a
  // filename, a search query or the model's own output — a benchmark whose
  // answers came from the thing under test measures nothing.
  expectedObjects: string[]
  expectedQuantityRange: Range | null
  expectedVolumeRangeCubicYards: Range | null
  expectedTruckSpaceRangePercent: Range | null
  expectedHandlingFlags: string[]
  lighting: Lighting | null
  clutter: Clutter | null
  imageQuality: ImageQuality | null
  containsPeople: boolean | null
  reviewStatus: ReviewStatus
  notes: string
  // ── Human ground truth (all optional; blank is honest, a guess is not) ──
  labelStatus: LabelStatus
  expectedCrewRange: Range | null
  expectedLaborHoursRange: Range | null
  disposalFlags: string[]
  accessConcerns: string[]
  labelConfidence: LabelConfidence | null
  difficulty: Difficulty | null
  verifiedAt?: string
  // ── Provenance + quality control (tooling-owned, not human-entered) ──
  storedPath: string          // relative to the external dataset root
  sha256: string              // exact-duplicate detection
  phash: string              // perceptual hash, near-duplicate detection
  widthPx: number
  heightPx: number
  bytes: number
  attribution: string         // the credit line the licence requires
  fetchedAt: string
  split: Split
  /** Set when this image is one photo of a multi-photo JOB. */
  jobGroupId?: string
}

/** A multi-photo job: several images that plausibly show ONE job. */
export type JobGroup = {
  id: string
  jobType: JobType
  category: string
  imageIds: string[]
  reviewStatus: ReviewStatus
  notes: string
  split: Split
}

export type RejectedSource = {
  sourcePageUrl: string
  sourceImageUrl: string
  sourceDomain: string
  license: string
  reason: string
  searchQuery: string
  at: string
}

// ── Licence policy ───────────────────────────────────────────────────────────

/**
 * Licences we auto-accept: commercial use AND modification permitted, with no
 * further negotiation. Everything else needs a human, including every NC and ND
 * variant — those are the ones most likely to be waved through by accident.
 */
export const AUTO_ACCEPT_LICENSES = new Set(['cc0', 'pdm', 'by', 'by-sa'])

/** Licences we explicitly refuse to fetch automatically, with the reason logged. */
export const AUTO_REJECT_REASONS: Record<string, string> = {
  'by-nc': 'NonCommercial — we are evaluating a commercial product',
  'by-nc-sa': 'NonCommercial — we are evaluating a commercial product',
  'by-nc-nd': 'NonCommercial + NoDerivatives',
  'by-nd': 'NoDerivatives — resizing/cropping for model input is a derivative',
  'nc-sampling+': 'NonCommercial sampling licence',
  'sampling+': 'Sampling licence — reuse terms are not general',
}

export type LicenseDecision =
  | { permitted: true; license: string }
  | { permitted: false; license: string; reason: string }

/** Decide whether a discovered image may be fetched automatically. Pure. */
export function licenseDecision(rawLicense: string | undefined | null): LicenseDecision {
  const license = String(rawLicense ?? '').trim().toLowerCase()
  if (!license) return { permitted: false, license: '', reason: 'no licence reported by the source' }
  if (AUTO_ACCEPT_LICENSES.has(license)) return { permitted: true, license }
  const known = AUTO_REJECT_REASONS[license]
  return { permitted: false, license, reason: known ?? `unrecognised licence "${license}" — needs human review` }
}

// ── Personal-information screen ──────────────────────────────────────────────

/**
 * Terms in a title/description that suggest the image centres on a person, a
 * child, a document, a plate or an address. A text screen cannot see a photo, so
 * this only DEMOTES a candidate to human review — it never certifies an image as
 * clean. The visual check is a human step by design.
 */
const PII_TERMS = [
  'portrait', 'selfie', 'child', 'children', 'kid', 'baby', 'toddler', 'family',
  'face', 'headshot', 'passport', 'licence plate', 'license plate', 'number plate',
  'id card', 'identity card', 'driver', 'invoice', 'receipt', 'document', 'letter',
  'mugshot', 'wedding', 'birthday', 'school',
]

export function piiRisk(text: string): { risky: boolean; matched: string[] } {
  const hay = String(text ?? '').toLowerCase()
  const matched = PII_TERMS.filter(t => hay.includes(t))
  return { risky: matched.length > 0, matched }
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Structural validation of a manifest entry. Returns the problems, empty = valid. */
export function validateEntry(e: Partial<ManifestEntry>): string[] {
  const problems: string[] = []
  const req: Array<keyof ManifestEntry> = [
    'id', 'jobType', 'category', 'sourcePageUrl', 'sourceImageUrl', 'sourceDomain',
    'license', 'searchQuery', 'storedPath', 'sha256', 'phash',
  ]
  for (const k of req) if (!e[k]) problems.push(`missing ${String(k)}`)
  if (e.jobType && e.jobType !== 'junk_removal' && e.jobType !== 'moving') problems.push(`bad jobType ${e.jobType}`)
  if (e.downloadPermitted === false) problems.push('downloadPermitted is false — it should not be in the manifest at all')
  if (e.license && !licenseDecision(e.license).permitted) problems.push(`licence ${e.license} is not auto-acceptable`)
  // Ground truth must be absent or a coherent range — never a single invented number.
  for (const k of ['expectedQuantityRange', 'expectedVolumeRangeCubicYards', 'expectedTruckSpaceRangePercent'] as const) {
    const r = e[k]
    if (r && (typeof r.min !== 'number' || typeof r.max !== 'number' || r.min > r.max)) problems.push(`bad range in ${k}`)
  }
  if (e.reviewStatus === 'approved' && !e.licenseVerified) problems.push('approved without licenceVerified')
  return problems
}

/**
 * A 24 ft box truck is ~44 cubic yards. Anything above ~6 truckloads is either a
 * mis-keyed label or a job nobody quotes from a photo, so it is refused rather
 * than silently accepted into the accuracy maths.
 */
export const MAX_PLAUSIBLE_CUBIC_YARDS = 264
export const TRUCK_CUBIC_YARDS = 44

/** Flags a labeller may attach. Free text is not accepted — it cannot be aggregated. */
export const DISPOSAL_FLAGS = [
  'appliance_fee', 'refrigerant', 'mattress_fee', 'tire_fee', 'electronics',
  'construction_debris', 'concrete_dense', 'yard_waste', 'hazardous_suspected',
] as const
export const ACCESS_CONCERNS = [
  'stairs', 'elevator', 'long_carry', 'narrow_access', 'indoor', 'outdoor',
  'curbside', 'disassembly_required', 'obstructed_view',
] as const

/** Range sanity, shared by every numeric ground-truth field. */
function rangeProblems(label: string, r: Range | null, opts: { min?: number; max?: number } = {}): string[] {
  if (!r) return []
  const out: string[] = []
  if (typeof r.min !== 'number' || typeof r.max !== 'number' || !Number.isFinite(r.min) || !Number.isFinite(r.max)) {
    return [`${label}: not a number`]
  }
  if (r.min > r.max) out.push(`${label}: min (${r.min}) is greater than max (${r.max})`)
  if (r.min < 0 || r.max < 0) out.push(`${label}: cannot be negative`)
  if (opts.min != null && r.min < opts.min) out.push(`${label}: below the allowed minimum ${opts.min}`)
  if (opts.max != null && r.max > opts.max) out.push(`${label}: above the allowed maximum ${opts.max}`)
  return out
}

/**
 * Validate the human label. Returns the problems that BLOCK verification —
 * empty means the entry may be marked verified. Drafts are never blocked; a
 * labeller can save partial work and come back to it.
 */
export function validateLabel(e: Partial<ManifestEntry>): string[] {
  const problems: string[] = []
  problems.push(...rangeProblems('quantity', e.expectedQuantityRange ?? null))
  problems.push(...rangeProblems('cubic yards', e.expectedVolumeRangeCubicYards ?? null, { max: MAX_PLAUSIBLE_CUBIC_YARDS }))
  problems.push(...rangeProblems('truck space %', e.expectedTruckSpaceRangePercent ?? null, { max: 100 }))
  problems.push(...rangeProblems('crew size', e.expectedCrewRange ?? null, { max: 12 }))
  problems.push(...rangeProblems('labor hours', e.expectedLaborHoursRange ?? null, { max: 80 }))

  // Cross-check: truck-space % and cubic yards describe the SAME quantity
  // (% = cuYd / 44). A large disagreement means one of them was mis-keyed, and
  // the pair would then be scored as if both were true. Tolerance is generous —
  // these are eyeballed estimates, not measurements — but a 3x gap is an error.
  const vol = e.expectedVolumeRangeCubicYards
  const truck = e.expectedTruckSpaceRangePercent
  if (vol && truck) {
    const volMid = (vol.min + vol.max) / 2
    const truckMid = (truck.min + truck.max) / 2
    const impliedPct = (volMid / TRUCK_CUBIC_YARDS) * 100
    if (volMid > 0 && truckMid > 0) {
      const ratio = Math.max(impliedPct / truckMid, truckMid / impliedPct)
      if (ratio > 3) {
        problems.push(
          `cubic yards and truck space disagree: ${volMid} cu yd implies ~${impliedPct.toFixed(0)}% ` +
          `of a ${TRUCK_CUBIC_YARDS} cu yd truck, but ${truckMid}% was entered`,
        )
      }
    }
  }

  // Required only to VERIFY. A draft may be as incomplete as the labeller likes.
  if (e.labelStatus === 'verified') {
    if (e.reviewStatus !== 'approved') problems.push('only an approved image can be verified')
    if (!e.expectedObjects?.length) problems.push('visible objects are required')
    if (!e.expectedVolumeRangeCubicYards) problems.push('cubic-yard range is required')
    if (!e.expectedTruckSpaceRangePercent) problems.push('truck-space range is required')
    if (!e.labelConfidence) problems.push('label confidence is required')
    if (!e.difficulty) problems.push('difficulty is required')
  }
  return problems
}

/** True when an entry carries enough VERIFIED human ground truth to score against. */
export function hasGroundTruth(e: ManifestEntry): boolean {
  return e.reviewStatus === 'approved'
    && e.labelStatus === 'verified'
    && e.expectedObjects.length > 0
    && e.expectedVolumeRangeCubicYards != null
}
