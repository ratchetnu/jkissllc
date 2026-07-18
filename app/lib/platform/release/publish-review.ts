// ── Publish Review — data model (TYPES ONLY) ─────────────────────────────────
//
// Increment 3B.2A. The shape of the owner review payload for a production promotion,
// as designed in docs/operations/operion-3b2-design-review.md. This file declares
// INTERFACES ONLY — no functions, no API, no network, no store. The builder that
// assembles this from the business/job/eligibility snapshot lands in 3B.2B; the
// execution pipeline lands in 3B.3+. Self-contained: it references the design-system
// ChecklistItem (presentation), not the eligibility engine internals.

import type { ChecklistItem, RiskLevel } from '../../../components/ui/deliberate-action-logic'

export interface PublishReviewBusiness {
  id: string
  name: string
  edition?: string
  productionUrl?: string
}

export interface PublishReviewVersion {
  current?: string          // current production version ('—' when unknown at render)
  candidate?: string        // the version that would go live
  releaseType?: string      // major | minor | patch | … (from versions.ts, mapped in 3B.2B)
  candidateCommit?: string
  sourceBranch?: string
}

export interface PublishReviewPreview {
  deploymentId?: string
  url?: string
  verified: boolean
  readyState?: string       // e.g. 'READY'
}

export type VerificationCheckState = 'pass' | 'warn' | 'fail' | 'skip'
export interface PublishReviewVerification {
  checks: { name: string; state: VerificationCheckState }[]
  verifiedAt?: number
  fresh: boolean
}

export interface PublishReviewFilesChanged {
  fileCount: number
  summary: string           // human one-liner (e.g. '1 file · lib/version.ts (+1 / −1)')
  migrations: boolean
  envChanges: boolean
  rollbackSupported: boolean
  diffUrl?: string          // external link (rendered, not fetched)
}

export type RollbackStrategy = 'instant_promote' | 'git_revert' | 'none'
export interface PublishReviewRollback {
  targetDeploymentId?: string
  targetVersion?: string
  strategy: RollbackStrategy
}

/** Eligibility as PRESENTATION data (decoupled from the 3B.1 engine). 3B.2B maps the
 *  engine's EligibilityResult into these checklist items. */
export interface PublishReviewEligibility {
  eligible: boolean
  passed: number
  warnings: number
  failed: number
  items: ChecklistItem[]
}

export interface PublishReviewRisk {
  level: RiskLevel
  title: string
  detail?: string
}

export interface PublishReviewAuditPreview {
  /** Plain-language list of what will be permanently recorded on approval. */
  willRecord: string[]
  correlationId?: string
}

/** The complete owner-review payload for a single business's production promotion. */
export interface PublishReview {
  business: PublishReviewBusiness
  version: PublishReviewVersion
  preview: PublishReviewPreview
  verification: PublishReviewVerification
  filesChanged: PublishReviewFilesChanged
  rollback: PublishReviewRollback
  eligibility: PublishReviewEligibility
  risk: PublishReviewRisk
  audit: PublishReviewAuditPreview
  evaluatedAt: number
}
