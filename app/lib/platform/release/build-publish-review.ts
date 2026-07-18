// ── Publish Review — builder (PURE) ──────────────────────────────────────────
//
// Increment 3B.2B. ONE centralized builder that converts the EXISTING release data
// (business + newest job + reconciliation + update + the 3B.1 eligibility result) into
// the 3B.2A PublishReview presentation model. No I/O, no mutation, no execution, no new
// source of truth — the caller (the read-only route) assembles the snapshot and runs the
// eligibility engine; this just maps. Data that cannot be assembled yet is returned as an
// explicit "Unavailable" state (never invented). It does NOT re-evaluate eligibility.

import type { EligibilityResult } from './promotion-eligibility'
import type {
  PublishReview, PublishReviewEligibility, PublishReviewRisk, PublishReviewVerification, VerificationCheckState,
} from './publish-review'
import type { ChecklistItem } from '../../../components/ui/deliberate-action-logic'
import { classifyReleaseType, normalizeVersion, isBehind } from './versions'

const DEFAULT_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000

export type BuildPublishReviewInput = {
  now: number
  ownerSub: string
  business: {
    id: string; name: string; status: string; edition?: string; role?: string
    repoName?: string; productionUrl?: string; currentVersion?: string
    latestVerifiedVersion?: string; latestVerifiedCommit?: string
  } | null
  releaseStatusLabel?: string
  testOnly: boolean
  job: {
    id: string; status: string; workBranch?: string; targetCommit?: string; approvedCommit?: string
    pullRequestNumber?: number; pullRequestUrl?: string; previewDeploymentId?: string; previewUrl?: string; updatedAt?: number
  } | null
  currentProduction?: { deploymentId?: string; deployedAt?: number; deployedCommit?: string; version?: string; readyState?: string; url?: string } | null
  candidate?: { version?: string; commit?: string; branch?: string } | null
  update?: {
    key?: string; title?: string; summary?: string; technicalImpact?: string
    migrationRequired?: boolean; environmentChangeRequired?: boolean; secretRequired?: boolean
    breakingChange?: boolean; rollbackSupported?: boolean
    validation?: Record<string, string>; approvedAt?: number
  } | null
  eligibility: EligibilityResult
  verificationTtlMs?: number
}

export type PublishReviewResult = {
  ok: boolean
  review?: PublishReview
  refusal?: { code: string; message: string }
  warnings: string[]
  assembledAt: number
  source: { business: boolean; job: boolean; update: boolean; production: boolean }
}

// EligibilityResult → checklist presentation (no re-evaluation; a faithful mapping).
function toEligibilityPresentation(e: EligibilityResult): PublishReviewEligibility {
  const items: ChecklistItem[] = e.requirements.map((r) => {
    const reason = e.reasons.find((x) => x.category === r.category && !r.ok)
    return { label: r.name, state: r.ok ? 'pass' : 'fail', detail: (!r.ok ? reason?.message : undefined) ?? r.detail }
  })
  for (const w of e.warnings) items.push({ label: w.message, state: 'warn' })
  return {
    eligible: e.eligible,
    passed: items.filter((i) => i.state === 'pass').length,
    warnings: items.filter((i) => i.state === 'warn').length,
    failed: items.filter((i) => i.state === 'fail').length,
    items,
    blockingReasons: e.reasons.map((r) => ({ code: r.code, message: r.message })),
  }
}

const CHECK_MAP: Record<string, VerificationCheckState> = { passed: 'pass', failed: 'fail', skipped: 'skip', not_applicable: 'skip', unknown: 'warn' }
function toVerification(input: BuildPublishReviewInput): PublishReviewVerification {
  const v = input.update?.validation ?? {}
  const checks = Object.entries(v).map(([name, state]) => ({ name, state: CHECK_MAP[state] ?? 'warn' as VerificationCheckState }))
  const verified = !!input.job && (input.job.status === 'awaiting_owner_review' || input.job.status === 'completed')
  const verifiedAt = verified ? (input.job?.updatedAt ?? input.update?.approvedAt) : undefined
  const ttl = input.verificationTtlMs ?? DEFAULT_VERIFICATION_TTL_MS
  const age = verifiedAt != null ? input.now - verifiedAt : undefined
  return { checks, verifiedAt, verificationAgeMs: age, fresh: age != null && age <= ttl }
}

function deriveRisk(u: BuildPublishReviewInput['update'], releaseType: string): PublishReviewRisk {
  if (u?.breakingChange || (u?.migrationRequired && !u?.rollbackSupported)) {
    return { level: 'destructive', title: 'High-risk change', detail: u?.breakingChange ? 'Contains a breaking change.' : 'Migration without a verified rollback path.' }
  }
  if (u?.migrationRequired || u?.environmentChangeRequired || u?.secretRequired) {
    return { level: 'warning', title: 'Needs attention', detail: 'Requires a migration, environment, or secret change.' }
  }
  if (releaseType === 'major') return { level: 'warning', title: 'Major release', detail: 'A major version bump.' }
  return { level: 'info', title: 'Low risk', detail: u?.rollbackSupported ? 'Reversible; no migration.' : 'No migration or breaking change detected.' }
}

export function buildPublishReview(input: BuildPublishReviewInput): PublishReviewResult {
  const warnings: string[] = []
  const source = { business: !!input.business, job: !!input.job, update: !!input.update, production: !!input.currentProduction?.deploymentId }
  const b = input.business
  if (!b) return { ok: false, refusal: { code: 'BUSINESS_NOT_FOUND', message: 'business not found' }, warnings, assembledAt: input.now, source }

  const currentVersion = input.currentProduction?.version || b.currentVersion || b.latestVerifiedVersion
  const candidateVersion = input.candidate?.version
  const candidateCommit = input.candidate?.commit || input.job?.targetCommit || input.job?.approvedCommit
  const candidateBranch = input.candidate?.branch || input.job?.workBranch
  const releaseType = classifyReleaseType(currentVersion, candidateVersion)

  if (!candidateVersion || !normalizeVersion(candidateVersion)) warnings.push('candidate version unavailable')
  if (!candidateCommit) warnings.push('candidate commit unavailable')
  if (!input.currentProduction?.deploymentId) warnings.push('current production deployment id unavailable (captured at execution time)')

  const rollbackReady = !!input.currentProduction?.deploymentId
  const correlationId = candidateCommit ? `rel-${b.id}-${candidateCommit.slice(0, 7)}` : `rel-${b.id}-pending`

  const review: PublishReview = {
    business: { id: b.id, name: b.name, edition: b.edition, productionUrl: b.productionUrl, releaseStatus: input.releaseStatusLabel, testOnly: input.testOnly },
    version: { current: currentVersion, candidate: candidateVersion, releaseType, candidateCommit, sourceBranch: candidateBranch },
    preview: {
      deploymentId: input.job?.previewDeploymentId, url: input.job?.previewUrl,
      verified: !!input.job && (input.job.status === 'awaiting_owner_review' || input.job.status === 'completed'),
      readyState: input.job?.previewDeploymentId ? (input.job.status === 'awaiting_owner_review' || input.job.status === 'completed' ? 'READY' : undefined) : undefined,
    },
    verification: toVerification(input),
    filesChanged: {
      fileCount: 0, available: false,
      summary: 'Change details are read from the verified diff at execution time (not fetched in this review).',
      migrations: !!input.update?.migrationRequired,
      envChanges: !!input.update?.environmentChangeRequired,
      rollbackSupported: !!input.update?.rollbackSupported,
      workflowChange: undefined, highRiskFiles: undefined,
      diffUrl: input.job?.pullRequestUrl,
    },
    rollback: {
      targetDeploymentId: input.currentProduction?.deploymentId,
      targetVersion: currentVersion,
      strategy: 'instant_promote',
      ready: rollbackReady,
      warning: rollbackReady ? undefined : 'No captured production deployment yet — the rollback target is set when publishing begins.',
    },
    eligibility: toEligibilityPresentation(input.eligibility),
    risk: deriveRisk(input.update, releaseType),
    audit: {
      willRecord: [
        `Owner: ${input.ownerSub}`,
        `Business: ${b.name} (${b.id})`,
        `Version: ${currentVersion ?? '—'} → ${candidateVersion ?? '—'}`,
        `Candidate commit: ${candidateCommit ?? '—'}`,
        `Preview verification: ${input.job?.previewDeploymentId ? 'recorded' : 'unavailable'}`,
        `Prior production deployment: ${input.currentProduction?.deploymentId ?? 'unavailable'}`,
        `Correlation id: ${correlationId}`,
        `Reviewed at: ${input.now}`,
      ],
      correlationId,
    },
    evaluatedAt: input.now,
  }

  // sanity: candidate must be strictly newer than production (else the review flags it,
  // but the review is still returned so the owner can see WHY it is not publishable).
  if (currentVersion && candidateVersion && !isBehind(currentVersion, candidateVersion)) {
    warnings.push('candidate is not strictly newer than production')
  }

  return { ok: true, review, warnings, assembledAt: input.now, source }
}
