// ─────────────────────────────────────────────────────────────────────────────
// Autonomous dataset curation — roles, states and provenance.
//
// WHAT THIS CAN AND CANNOT ESTABLISH
//
// A second model family can independently check CLASSIFICATION: is this an
// operational scene, which lane, which category, is there a privacy or licence
// problem, is the schema valid, is a quantity grossly implausible. Two models
// disagreeing on those is real signal.
//
// It CANNOT establish VOLUME ACCURACY. Neither model measured the room. Two
// vision models agreeing on cubic yards measures correlated bias, not truth —
// they over-read cluttered scenes and under-read dense ones together. That is
// why Silver exists as a separate tier and why `TIER_CLAIMS` below names, in
// code, the metrics each tier may support. Volume calibration is Gold-only.
//
// The production estimator never participates in labelling. See ROLES.
// ─────────────────────────────────────────────────────────────────────────────

/** Every terminal state a candidate can reach. Nothing else is a valid outcome. */
export type CurationState =
  | 'auto_verified'
  | 'auto_rejected'
  | 'needs_human_review'
  | 'insufficient_evidence'
  | 'license_blocked'
  | 'privacy_blocked'
  | 'duplicate'
  | 'acquisition_required'

export const TERMINAL_STATES: CurationState[] = [
  'auto_verified', 'auto_rejected', 'needs_human_review', 'insufficient_evidence',
  'license_blocked', 'privacy_blocked', 'duplicate', 'acquisition_required',
]

/**
 * The four roles. `production_estimator` is listed so the independence check has
 * something to refuse: it is the system under test and must never label or judge.
 */
export type Role = 'classifier' | 'labeler' | 'verifier' | 'adjudicator' | 'production_estimator'

export type RoleAssignment = { role: Role; model: string; promptVersion: string }

/**
 * Independence rule, enforced rather than documented.
 *
 * - the production estimator's model may not be reused for labelling or judging;
 * - labeler and verifier may not be the same model;
 * - preferred (not required) is a different model FAMILY for the labeler.
 *
 * Returns the violations; empty means the assignment is admissible.
 */
export function independenceViolations(
  assignments: RoleAssignment[], productionModel: string,
): string[] {
  const out: string[] = []
  const by = (r: Role) => assignments.find(a => a.role === r)
  const family = (m: string) => m.split('/')[0]

  const labeler = by('labeler')
  const verifier = by('verifier')
  if (!labeler) out.push('no labeler assigned')
  if (!verifier) out.push('no verifier assigned')

  for (const r of ['labeler', 'verifier', 'adjudicator'] as Role[]) {
    const a = by(r)
    if (a && a.model === productionModel) {
      out.push(`${r} uses the production estimator's model (${a.model}) — it cannot grade itself`)
    }
  }
  if (labeler && verifier && labeler.model === verifier.model) {
    out.push(`labeler and verifier are the same model (${labeler.model}) — verification would not be independent`)
  }
  if (labeler && verifier && family(labeler.model) === family(verifier.model)) {
    out.push(`WARN same model family for labeler and verifier (${family(labeler.model)}) — correlated bias is likely`)
  }
  return out
}

/** Structured disagreement vocabulary. Free text is not an accepted verdict. */
export type DisagreementCode =
  | 'wrong_lane' | 'wrong_category' | 'non_operational_scene' | 'item_not_visible'
  | 'quantity_overstated' | 'quantity_understated' | 'volume_implausible'
  | 'truck_space_inconsistent' | 'handling_flag_unsupported' | 'access_not_visible'
  | 'privacy_risk' | 'license_risk' | 'insufficient_context' | 'confidence_too_high'

/**
 * Disagreements that block auto-verification outright. The rest lower confidence
 * but can still clear the gate if everything else is strong.
 */
export const CRITICAL_CODES: DisagreementCode[] = [
  'wrong_lane', 'non_operational_scene', 'privacy_risk', 'license_risk',
  'volume_implausible', 'truck_space_inconsistent', 'confidence_too_high',
]

/** Fields on which labeler and verifier must agree before auto-verification. */
export const CRITICAL_FIELDS = [
  'lane', 'operationalValidity', 'visibleInventory', 'quantityRange',
  'volumeRange', 'truckSpaceRange', 'hazardousIndicators', 'handlingFlags',
  'privacy', 'license',
] as const

export type DatasetTier = 'gold' | 'silver' | 'candidate'

/**
 * What each tier is ALLOWED to support. Encoded so a report cannot quietly cite
 * Silver for a claim Silver cannot carry.
 */
export const TIER_CLAIMS: Record<DatasetTier, string[]> = {
  gold: [
    'holdout accuracy', 'launch decisions', 'volume accuracy', 'truck-space accuracy',
    'catalog-disagreement calibration', 'threshold selection', 'coverage', 'lane accuracy',
    'category accuracy', 'screening precision',
  ],
  silver: [
    // Deliberately excludes every volume/threshold claim: two models agreeing on
    // cubic yards is correlated bias, not measurement.
    'coverage', 'lane accuracy', 'category accuracy', 'screening precision', 'schema validity',
  ],
  candidate: [],
}

export function tierSupportsClaim(tier: DatasetTier, claim: string): boolean {
  return TIER_CLAIMS[tier].includes(claim)
}

/** Immutable provenance. A change produces a NEW revision; history is never edited. */
export type LabelProvenance = {
  revision: number
  sourceImageId: string
  sourceUrl: string
  license: string
  roles: RoleAssignment[]
  schemaVersion: number
  catalogVersion: number
  createdAt: string
  confidence: Record<string, number>
  disagreements: DisagreementCode[]
  deterministicProblems: string[]
  state: CurationState
  decisionReason: string
  tier: DatasetTier
  humanReviewed: boolean
  humanReviewerId?: string
}

/** Append a revision. Returns a NEW array; the input is never mutated. */
export function appendRevision(
  history: LabelProvenance[], next: Omit<LabelProvenance, 'revision'>,
): LabelProvenance[] {
  const revision = history.length === 0 ? 1 : history[history.length - 1].revision + 1
  return [...history, { ...next, revision }]
}
