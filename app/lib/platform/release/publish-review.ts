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
  releaseStatus?: string    // the resolver status label (e.g. 'Ready to publish')
  testOnly?: boolean        // refused for promotion by default (sandbox etc.)
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
  verificationAgeMs?: number
  fresh: boolean
}

export interface PublishReviewFilesChanged {
  fileCount: number
  summary: string           // human one-liner (e.g. '1 file · lib/version.ts (+1 / −1)')
  migrations: boolean
  envChanges: boolean
  rollbackSupported: boolean
  diffUrl?: string          // external link (rendered, not fetched)
  // `available` is false until enriched (3B.2D) with a verified GitHub compare.
  available?: boolean
  additions?: number
  deletions?: number
  changedAreas?: string[]
  workflowChange?: boolean
  highRiskFiles?: boolean
  // ── 3B.2D enrichment (verified GitHub compare; all optional / backward-compatible) ──
  commitCount?: number
  changedFilePaths?: string[]
  /** Exact file evidence behind each high-risk indicator (verified path matches only). */
  highRiskDetails?: { category: string; file: string }[]
  /** Base…head resolved to the same commit — nothing changed. */
  identical?: boolean
  /** GitHub truncated the file list for a very large diff — counts may be partial. */
  truncated?: boolean
}

export type RollbackStrategy = 'instant_promote' | 'git_revert' | 'none'
export interface PublishReviewRollback {
  targetDeploymentId?: string
  targetVersion?: string
  strategy: RollbackStrategy
  ready: boolean            // true only when a known-good prior production deployment is captured
  warning?: string
  // ── 3B.2D enrichment — verified prior-production metadata (display-only) ──
  targetUrl?: string
  targetCommit?: string
  targetDeployedAt?: number
  /** True only when the rollback target has a deployment id + commit + timestamp. */
  metadataComplete?: boolean
  /** Sanitized, display-only readiness warnings (e.g. no git commit on the deploy). */
  warnings?: string[]
}

/** Eligibility as PRESENTATION data (decoupled from the 3B.1 engine). 3B.2B maps the
 *  engine's EligibilityResult into these checklist items. */
export interface PublishReviewEligibility {
  eligible: boolean
  passed: number
  warnings: number
  failed: number
  items: ChecklistItem[]
  blockingReasons?: { code: string; message: string }[]
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
