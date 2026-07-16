// ── Operion one-click deploy view model (PURE) ───────────────────────────────
// Turns raw automation-job state into the owner-facing "Deploy Preview" experience: the ONE
// primary action, the friendly 6-stage progress, and the retry classification (which
// failures are transient/auto-retryable vs owner-actionable). No I/O — fully testable.

export type DeployActionKind = 'deploy' | 'fix' | 'running' | 'retry' | 'regenerate' | 'finalize' | 'review' | 'approved' | 'none'

// A review-ready job isn't truly ready until its required artifacts (PR + Preview) exist.
export function artifactsComplete(job: { pullRequestUrl?: string | null; previewUrl?: string | null }, opts: { requirePr?: boolean; requirePreview?: boolean }): boolean {
  if (opts.requirePr !== false && !job.pullRequestUrl) return false
  if (opts.requirePreview !== false && !job.previewUrl) return false
  return true
}

// Transient categories the reconciler may AUTO-retry (bounded). Everything else is an
// owner decision — code/transfer/security failures are never silently retried.
export const TRANSIENT_FAILURES = new Set(['timeout', 'provider_error', 'internal_error'])
export function isTransientFailure(category?: string | null): boolean {
  return !!category && TRANSIENT_FAILURES.has(category)
}

// Failures the OWNER may retry with one click (the workflow/config may have been fixed).
// commit_drift is excluded — it needs a fresh manifest, not a retry.
export const OWNER_RETRYABLE = new Set(['apply_failed', 'tests_failed', 'build_failed', 'preview_failed', 'branch_failed', 'health_failed', 'smoke_failed', 'timeout', 'provider_error', 'internal_error'])
export function isOwnerRetryable(status: string, category?: string | null): boolean {
  if (!FAILED.has(status)) return false
  if (category === 'commit_drift' || category === 'merge_conflict') return false
  return !category || OWNER_RETRYABLE.has(category)
}

const ACTIVE = new Set(['queued', 'creating_branch', 'dispatched', 'running', 'applying', 'preview_deploying'])
const FAILED = new Set(['failed', 'tests_failed', 'build_failed', 'preview_failed', 'blocked'])
const REVIEW = new Set(['preview_ready', 'awaiting_owner_review'])

// Friendly, owner-facing stages (backend states map onto these).
export const DEPLOY_STAGES = ['Preparing', 'Applying update', 'Verifying code', 'Creating pull request', 'Building Preview', 'Ready for review'] as const

type JobLike = { status: string; failureCategory?: string | null; failureSummary?: string | null; result?: { lintPassed?: boolean; testsPassed?: boolean; buildPassed?: boolean } | null }

/** Which friendly stage the job reached, and which one failed (if any). */
export function deployStage(job: JobLike): { reached: number; failedAt: number | null } {
  const s = job.status
  const codeFailed = !!job.result && (job.result.lintPassed === false || job.result.testsPassed === false || job.result.buildPassed === false)
  if (s === 'queued') return { reached: 0, failedAt: null }
  if (s === 'blocked') return { reached: 0, failedAt: 0 }
  if (s === 'creating_branch') return { reached: 1, failedAt: null }
  if (s === 'dispatched' || s === 'running' || s === 'applying') return { reached: 2, failedAt: null }
  if (s === 'preview_deploying') return { reached: 4, failedAt: null }
  if (REVIEW.has(s) || s === 'approved_for_production' || s === 'completed') return { reached: 5, failedAt: null }
  if (FAILED.has(s)) {
    const f = job.failureCategory === 'branch_failed' ? 0
      : job.failureCategory === 'apply_failed' ? 1
        : job.failureCategory === 'tests_failed' || job.failureCategory === 'build_failed' ? 2
          : job.failureCategory === 'preview_failed' ? (codeFailed ? 2 : 4)
            : codeFailed ? 2 : 1
    return { reached: f, failedAt: f }
  }
  return { reached: 0, failedAt: null }  // cancelled / unknown
}

/** The single primary action the owner sees, computed from job + readiness + artifacts.
 *  `artifactsOk` = required PR/Preview exist; a review-ready job missing them shows
 *  "Complete Preview" instead of a review it can't actually perform. */
export function deployPrimary(job: JobLike | null, ready: boolean, artifactsOk = true): { kind: DeployActionKind; label: string } {
  if (!job) return ready ? { kind: 'deploy', label: 'Deploy Preview' } : { kind: 'fix', label: 'Fix configuration' }
  const s = job.status
  if (ACTIVE.has(s)) return { kind: 'running', label: 'Deploying…' }
  if (REVIEW.has(s)) return artifactsOk ? { kind: 'review', label: 'Review Preview' } : { kind: 'finalize', label: 'Complete Preview' }
  if (s === 'approved_for_production') return { kind: 'approved', label: 'Approved for production' }
  if (s === 'cancelled') return ready ? { kind: 'deploy', label: 'Deploy Preview' } : { kind: 'fix', label: 'Fix configuration' }
  if (job.failureCategory === 'commit_drift') return { kind: 'regenerate', label: 'Regenerate manifest' }
  if (FAILED.has(s)) return { kind: 'retry', label: 'Retry Preview' }
  return { kind: 'none', label: '—' }
}

/** Plain-English one-liner for a failed job (owner-facing; no raw field names). */
export function failureExplanation(job: JobLike): string {
  switch (job.failureCategory) {
    case 'apply_failed': return 'The approved files could not be applied to the target (a hash or path check failed).'
    case 'tests_failed': return 'The transferred change did not pass the target’s tests.'
    case 'build_failed': return 'The target’s production build failed with the transferred change.'
    case 'preview_failed': return job.result?.lintPassed === false ? 'The transferred file did not pass lint.' : 'The Preview build did not complete.'
    case 'commit_drift': return 'The update no longer matches its source commit — regenerate the manifest.'
    case 'merge_conflict': return 'The work branch conflicts with the target — a fresh branch is needed.'
    case 'timeout': case 'provider_error': case 'internal_error': return 'A temporary infrastructure error interrupted the run — retrying is safe.'
    default: return job.failureSummary?.slice(0, 200) ?? 'The Preview could not be created.'
  }
}
