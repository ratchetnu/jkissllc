// ── Operion production-promotion — eligibility evaluator (PURE) ──────────────
//
// Increment 3B.1. ONE centralized, deterministic, side-effect-free evaluator that
// answers "may this business be promoted to production right now?" across ten
// dimensions. It performs NO I/O and triggers NO execution — the caller assembles a
// snapshot from the existing stores/providers and passes it in; this returns a
// structured result with machine-readable refusal codes. Reuses the existing decision
// helpers (promotion.ts drift, versions.ts semver) and the hard guards (promotion-guards.ts).
//
// Server code is authoritative: a route/action must treat `eligible === false` as a
// hard stop. `eligible === true` here means only "the preconditions hold" — it never
// implies execution is wired (it is not, in 3B.1).

import { promotionDriftDetected } from '../automation/promotion'
import { isBehind, isSameVersion, normalizeVersion } from './versions'
import { isRepoAllowed, isVercelProjectAllowed, isTestOnlyBusiness, environmentAllowsEvaluation } from './promotion-guards'

export type EligibilityCategory =
  | 'authorization' | 'feature_flags' | 'environment' | 'business_safety'
  | 'preview_validation' | 'concurrency' | 'repository_safety' | 'vercel_safety'
  | 'change_integrity' | 'audit_readiness'

export type EligibilityRefusalCode =
  | 'PROMOTION_DISABLED' | 'OWNER_REQUIRED' | 'INVALID_ENVIRONMENT'
  | 'BUSINESS_NOT_FOUND' | 'BUSINESS_INACTIVE' | 'TEST_ONLY_BUSINESS'
  | 'PREVIEW_NOT_READY' | 'VERIFICATION_MISSING' | 'VERIFICATION_FAILED' | 'VERIFICATION_EXPIRED'
  | 'CANDIDATE_MISSING' | 'CANDIDATE_CHANGED' | 'VERSION_INVALID' | 'UPGRADE_PATH_INVALID'
  | 'ACTIVE_RUN_EXISTS' | 'DUPLICATE_PROMOTION' | 'PROMOTION_LOCKED' | 'ALREADY_PUBLISHED'
  | 'REPOSITORY_NOT_ALLOWED' | 'BRANCH_NOT_ALLOWED' | 'COMMIT_MISMATCH'
  | 'PRODUCTION_PROJECT_NOT_ALLOWED' | 'PRODUCTION_DEPLOYMENT_UNKNOWN' | 'ROLLBACK_TARGET_MISSING'
  | 'AUDIT_CONTEXT_MISSING'

export type RequirementCheck = { category: EligibilityCategory; name: string; ok: boolean; detail?: string }
export type EligibilityRefusal = { code: EligibilityRefusalCode; category: EligibilityCategory; message: string }
export type EligibilityWarning = { code: string; message: string }

// ── Types reused by later increments (defined here; NO store is created in 3B.1) ──
export type PromotionCandidate = {
  businessId?: string; branch?: string; commit?: string
  currentVersion?: string; candidateVersion?: string
  previewUrl?: string; previewDeploymentId?: string; pullRequestNumber?: number
}
export type EligibilitySnapshot = EligibilityResult & { correlationId?: string }
export type PromotionLock = { businessId: string; jobId: string; acquiredAt: number; acquiredBy: string }

export type EligibilityResult = {
  eligible: boolean
  reasons: EligibilityRefusal[]
  warnings: EligibilityWarning[]
  requirements: RequirementCheck[]
  evaluatedAt: number
  candidate: PromotionCandidate | null
}

const DEFAULT_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000 // 24h

export type EligibilityInput = {
  now: number
  env: { vercelEnv?: string }
  flags: { promotionEnabled: boolean }
  principal: { authenticated: boolean; isOwner: boolean }
  business?: {
    id: string; status: string; role?: string; edition?: string
    allowProductionPromotion?: boolean
    repoName?: string; defaultBranch?: string; githubInstallationId?: string
    productionProjectId?: string; deployProject?: string
    currentVersion?: string
  } | null
  job?: {
    id: string; status: string
    workBranch?: string; baseBranch?: string
    approvedCommit?: string; targetCommit?: string
    pullRequestNumber?: number
    previewDeploymentId?: string; previewUrl?: string; productionDeploymentId?: string
  } | null
  previewDeployment?: { id?: string; readyState?: string; commit?: string } | null
  currentProduction?: { deploymentId?: string; version?: string; commit?: string } | null
  candidateBranchHead?: string
  verification?: { passed?: boolean; at?: number } | null
  concurrency?: { activeUpdateRun?: boolean; activePromotionRun?: boolean; duplicateRequest?: boolean; lockHeld?: boolean; alreadyPublished?: boolean }
  candidateVersion?: string
  verificationTtlMs?: number
}

export function evaluatePromotionEligibility(i: EligibilityInput): EligibilityResult {
  const reqs: RequirementCheck[] = []
  const reasons: EligibilityRefusal[] = []
  const warnings: EligibilityWarning[] = []
  const require = (category: EligibilityCategory, name: string, ok: boolean, code: EligibilityRefusalCode, message: string, detail?: string) => {
    reqs.push({ category, name, ok, detail })
    if (!ok) reasons.push({ code, category, message })
  }

  // 1. AUTHORIZATION
  require('authorization', 'Authenticated', i.principal.authenticated, 'OWNER_REQUIRED', 'a signed-in owner is required')
  require('authorization', 'Owner permission', i.principal.isOwner, 'OWNER_REQUIRED', 'platform-owner permission is required')

  // 2. FEATURE FLAGS (missing/empty/invalid resolve false at the caller; here it is a boolean)
  require('feature_flags', 'Promotion flag enabled', i.flags.promotionEnabled === true, 'PROMOTION_DISABLED', 'OPERION_PRODUCTION_PROMOTION_ENABLED is off')

  // 3. ENVIRONMENT — evaluation allowed in preview/production only; preview cannot EXECUTE.
  require('environment', 'Trusted environment', environmentAllowsEvaluation(i.env.vercelEnv), 'INVALID_ENVIRONMENT', `environment "${i.env.vercelEnv ?? 'unknown'}" cannot reason about production promotion`)
  if ((i.env.vercelEnv ?? '').toLowerCase() === 'preview') warnings.push({ code: 'PREVIEW_EVALUATION_ONLY', message: 'Preview may evaluate eligibility but production execution runs only from Production.' })

  // 4. BUSINESS SAFETY
  const b = i.business
  require('business_safety', 'Business exists', !!b, 'BUSINESS_NOT_FOUND', 'business not found')
  require('business_safety', 'Business active', !!b && b.status === 'active', 'BUSINESS_INACTIVE', 'business is not active')
  require('business_safety', 'Promotion allowed by business', !!b && b.allowProductionPromotion === true && !isTestOnlyBusiness(b), 'TEST_ONLY_BUSINESS', 'business is test-only or does not allow production promotion')

  // 5. PREVIEW VALIDATION
  const job = i.job
  require('preview_validation', 'Preview deployment exists', !!i.previewDeployment?.id || !!job?.previewDeploymentId, 'PREVIEW_NOT_READY', 'no preview deployment recorded')
  require('preview_validation', 'Preview deployment READY', (i.previewDeployment?.readyState ?? '').toUpperCase() === 'READY', 'PREVIEW_NOT_READY', 'preview deployment is not READY')
  require('preview_validation', 'Verification present', !!i.verification, 'VERIFICATION_MISSING', 'no automated verification record')
  require('preview_validation', 'Verification passed', i.verification?.passed === true, 'VERIFICATION_FAILED', 'automated verification did not pass')
  const ttl = i.verificationTtlMs ?? DEFAULT_VERIFICATION_TTL_MS
  const fresh = !!i.verification?.at && (i.now - i.verification.at) <= ttl
  require('preview_validation', 'Verification fresh', fresh, 'VERIFICATION_EXPIRED', 'verification is older than the freshness window')

  // 6. CONCURRENCY & IDEMPOTENCY
  const c = i.concurrency ?? {}
  require('concurrency', 'No active update run', !c.activeUpdateRun, 'ACTIVE_RUN_EXISTS', 'an update run is already active')
  require('concurrency', 'No active promotion run', !c.activePromotionRun, 'ACTIVE_RUN_EXISTS', 'a promotion run is already active')
  require('concurrency', 'No duplicate request', !c.duplicateRequest, 'DUPLICATE_PROMOTION', 'a duplicate promotion request is in flight')
  require('concurrency', 'Not already published', !c.alreadyPublished, 'ALREADY_PUBLISHED', 'this candidate has already been published')
  require('concurrency', 'Promotion lock free', !c.lockHeld, 'PROMOTION_LOCKED', 'a promotion lock is held')

  // 7. REPOSITORY SAFETY
  require('repository_safety', 'Repository present', !!b?.repoName, 'CANDIDATE_MISSING', 'repository is not configured')
  require('repository_safety', 'Repository allowlisted', isRepoAllowed(b?.repoName), 'REPOSITORY_NOT_ALLOWED', 'repository is not on the promotion allowlist')
  require('repository_safety', 'Candidate branch known', !!job?.workBranch, 'CANDIDATE_MISSING', 'candidate work branch is unknown')
  require('repository_safety', 'Target branch is default/main', !!b?.defaultBranch && (job?.baseBranch === b.defaultBranch), 'BRANCH_NOT_ALLOWED', 'target branch is not the business default branch')
  require('repository_safety', 'GitHub integration configured', !!b?.githubInstallationId, 'CANDIDATE_MISSING', 'GitHub App installation id is missing')
  require('repository_safety', 'Candidate commit known', !!job?.targetCommit || !!job?.approvedCommit, 'CANDIDATE_MISSING', 'candidate commit SHA is unknown')

  // 8. VERCEL SAFETY
  const prodProject = b?.productionProjectId || b?.deployProject
  require('vercel_safety', 'Production project present', !!prodProject, 'PRODUCTION_PROJECT_NOT_ALLOWED', 'production Vercel project is not configured')
  require('vercel_safety', 'Production project allowlisted', isVercelProjectAllowed(prodProject), 'PRODUCTION_PROJECT_NOT_ALLOWED', 'production Vercel project is not on the allowlist')
  require('vercel_safety', 'Current production deployment known', !!i.currentProduction?.deploymentId, 'PRODUCTION_DEPLOYMENT_UNKNOWN', 'current production deployment is unknown')
  require('vercel_safety', 'Rollback target available', !!i.currentProduction?.deploymentId, 'ROLLBACK_TARGET_MISSING', 'no known-good production deployment to capture as rollback target')

  // 9. CHANGE INTEGRITY
  const approved = job?.approvedCommit
  const head = i.candidateBranchHead
  require('change_integrity', 'Candidate unchanged since verification', !promotionDriftDetected(approved, head), 'CANDIDATE_CHANGED', 'candidate branch head drifted from the verified commit')
  const commitMatch = !approved || !job?.targetCommit || approved === job.targetCommit
  require('change_integrity', 'Approved commit matches candidate', commitMatch, 'COMMIT_MISMATCH', 'approved commit does not match the candidate commit')
  const cand = i.candidateVersion
  const curr = i.currentProduction?.version || b?.currentVersion
  require('change_integrity', 'Candidate version known', !!cand && !!normalizeVersion(cand), 'VERSION_INVALID', 'candidate version is unknown or invalid')
  require('change_integrity', 'Candidate differs from production', !!cand && !!curr && !isSameVersion(cand, curr), 'UPGRADE_PATH_INVALID', 'candidate version equals the current production version')
  require('change_integrity', 'Valid upgrade path', !!cand && !!curr && isBehind(curr, cand), 'UPGRADE_PATH_INVALID', 'candidate is not strictly newer than production')

  // 10. AUDIT READINESS
  const auditReady = i.principal.isOwner && !!b?.id && (!!i.previewDeployment?.id || !!job?.previewDeploymentId) && !!i.currentProduction?.deploymentId
  require('audit_readiness', 'Audit context recordable', auditReady, 'AUDIT_CONTEXT_MISSING', 'owner / candidate / preview / prior-production identifiers are not all recordable')

  const candidate: PromotionCandidate | null = b ? {
    businessId: b.id, branch: job?.workBranch, commit: job?.targetCommit || job?.approvedCommit,
    currentVersion: curr, candidateVersion: cand,
    previewUrl: i.previewDeployment ? job?.previewUrl : job?.previewUrl,
    previewDeploymentId: i.previewDeployment?.id || job?.previewDeploymentId,
    pullRequestNumber: job?.pullRequestNumber,
  } : null

  return { eligible: reasons.length === 0, reasons, warnings, requirements: reqs, evaluatedAt: i.now, candidate }
}
