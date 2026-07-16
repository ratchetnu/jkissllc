// ── Operion production promotion (PURE decision core) ────────────────────────
// Sprint 2: owner-approved production promotion. This is the deterministic decision logic —
// who may promote, the commit-drift guard, and the friendly production stages. No I/O; the
// orchestrator performs the merge/deploy behind the OPERION_PRODUCTION_PROMOTION_ENABLED flag.
// The ONE hard invariant: production is reachable ONLY via awaiting_owner_review →
// approved_for_production, and NOTHING promotes without the owner + the flag + business setting.

export type PromotionGateResult = { ok: boolean; reason?: string }

/** May this job be promoted to production right now? Owner-gated + flag-gated + drift-guarded. */
export function canPromote(input: {
  status: string
  approvedCommit?: string
  targetCommit?: string
  pullRequestNumber?: number
  flagEnabled: boolean
  businessAllows: boolean
}): PromotionGateResult {
  if (!input.flagEnabled) return { ok: false, reason: 'production promotion is disabled (OPERION_PRODUCTION_PROMOTION_ENABLED off)' }
  if (!input.businessAllows) return { ok: false, reason: 'this business does not allow production promotion' }
  if (input.status !== 'awaiting_owner_review') return { ok: false, reason: `job is ${input.status}, not awaiting_owner_review` }
  if (!input.pullRequestNumber) return { ok: false, reason: 'no pull request to merge' }
  // Commit-drift guard: never promote a commit different from the reviewed one.
  if (input.approvedCommit && input.targetCommit && input.approvedCommit !== input.targetCommit) return { ok: false, reason: 'commit drifted from the reviewed head' }
  return { ok: true }
}

/** True when the reviewed commit no longer matches the PR head — abort the merge. */
export function promotionDriftDetected(approvedCommit: string | undefined, headCommit: string | undefined): boolean {
  return !!approvedCommit && !!headCommit && approvedCommit !== headCommit
}

/** May the reconciler auto-roll-back a failed production promotion? Flag-gated + bounded +
 *  requires a captured known-good production deployment to promote back. */
export function canAutoRollback(input: { status: string; flagEnabled: boolean; rollbackTargetDeploymentId?: string; attemptCount?: number; maxAttempts?: number }): PromotionGateResult {
  if (input.status !== 'rollback_required') return { ok: false, reason: `job is ${input.status}, not rollback_required` }
  if (!input.flagEnabled) return { ok: false, reason: 'automatic rollback disabled (OPERION_AUTOMATIC_ROLLBACK_ENABLED off)' }
  if (!input.rollbackTargetDeploymentId) return { ok: false, reason: 'no known-good production deployment to roll back to' }
  if ((input.attemptCount ?? 0) >= (input.maxAttempts ?? 2)) return { ok: false, reason: 'rollback attempts exhausted' }
  return { ok: true }
}

// Friendly production-promotion stages for the owner UI.
export const PROMOTION_STAGES = ['Approved', 'Merging', 'Deploying to production', 'Verifying', 'Live'] as const

export function promotionStage(status: string): { reached: number; failedAt: number | null } {
  switch (status) {
    case 'approved_for_production': return { reached: 0, failedAt: null }
    case 'merging': return { reached: 1, failedAt: null }
    case 'production_deploying': return { reached: 2, failedAt: null }
    case 'verifying': return { reached: 3, failedAt: null }
    case 'completed': return { reached: 4, failedAt: null }
    case 'rollback_required': case 'rolling_back': return { reached: 3, failedAt: 3 }
    case 'rolled_back': return { reached: 3, failedAt: 3 }
    case 'failed': return { reached: 1, failedAt: 1 }
    default: return { reached: -1, failedAt: null }
  }
}

/** Whether the job is in the production-promotion pipeline (for UI/reconciler routing). */
export const PROMOTION_ACTIVE = new Set(['approved_for_production', 'merging', 'production_deploying', 'verifying'])
