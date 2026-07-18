// ── Operion release — production-promotion state projection (PURE) ────────────
//
// Increment 3B.1. The RELEASE-level (external, calm) lifecycle for a production
// promotion, projected from the EXISTING internal automation job statuses
// (automation/types.ts) — NOT a second state store. state.ts owns the ReleaseStatus
// union + resolver; this module owns the promotion-only phase vocabulary, the
// automation→release mapping, and the documented+testable transition table.
//
// 3B.1 is inert: nothing here initiates GitHub/Vercel execution. These states are
// reachable only once later increments create promotion runs; until then they only
// appear in tests. When no promotion phase is present, resolveReleaseState is
// byte-identical to Increment 3A.

import type { ReleaseStatus, PrimaryAction } from './state'

/** The promotion-only phases (a superset projection of the awaiting_owner_review→…
 *  →completed / rollback_* automation statuses). Distinct from the preview phases. */
export type PromotionPhase =
  | 'awaiting_approval'      // owner approved; queued for execution (automation: approved_for_production)
  | 'publishing'            // merging the verified candidate (automation: merging)
  | 'verifying_production'  // production deploy + health checks (automation: production_deploying | verifying)
  | 'published'            // live + verified (automation: completed, promotion job)
  | 'publish_failed'       // failed before going live (automation: failed, promotion job)
  | 'rolling_back'         // restoring the prior production (automation: rollback_required | rolling_back)
  | 'rolled_back'          // prior production restored (automation: rolled_back)
  | 'rollback_failed'      // rollback itself failed — terminal, alert-only

/** Map an internal automation status to a release promotion phase, or null when the
 *  status is not part of the promotion pipeline. `isPromotionJob` disambiguates the
 *  shared terminal statuses (completed/failed) that also occur for preview-only runs. */
export function promotionPhaseOf(status: string, opts: { isPromotionJob?: boolean; rollbackFailed?: boolean } = {}): PromotionPhase | null {
  switch (status) {
    case 'approved_for_production': return 'awaiting_approval'
    case 'merging': return 'publishing'
    case 'production_deploying':
    case 'verifying': return 'verifying_production'
    case 'rollback_required':
    case 'rolling_back': return opts.rollbackFailed ? 'rollback_failed' : 'rolling_back'
    case 'rolled_back': return 'rolled_back'
    case 'completed': return opts.isPromotionJob ? 'published' : null
    case 'failed': return opts.isPromotionJob ? (opts.rollbackFailed ? 'rollback_failed' : 'publish_failed') : null
    default: return null
  }
}

/** Release status + primary action for each promotion phase. The action never triggers
 *  execution in 3B.1 — it is display intent the (future) UI/route will honour. */
export const PROMOTION_PHASE_TO_RELEASE: Record<PromotionPhase, { status: ReleaseStatus; action: PrimaryAction }> = {
  awaiting_approval: { status: 'awaiting_approval', action: 'view_publish_progress' },
  publishing: { status: 'publishing', action: 'view_publish_progress' },
  verifying_production: { status: 'verifying_production', action: 'view_publish_progress' },
  published: { status: 'published', action: 'check' },
  publish_failed: { status: 'publish_failed', action: 'retry' },
  rolling_back: { status: 'rolling_back', action: 'view_publish_progress' },
  rolled_back: { status: 'rolled_back', action: 'rollback' },
  rollback_failed: { status: 'rollback_failed', action: 'resolve' },
}

// ── Documented transition table (release-level; testable; NOT wired to execution) ──
// The ONLY door into the promotion pipeline is ready_to_publish → awaiting_approval,
// mirroring the automation invariant (awaiting_owner_review → approved_for_production).
export const RELEASE_PROMOTION_TRANSITIONS: Partial<Record<ReleaseStatus, ReleaseStatus[]>> = {
  ready_to_publish: ['awaiting_approval'],
  awaiting_approval: ['publishing', 'publish_failed'],
  publishing: ['verifying_production', 'publish_failed'],
  verifying_production: ['published', 'publish_failed'],
  publish_failed: ['rolling_back', 'awaiting_approval'],   // retry re-enters approval; or roll back
  published: ['rolling_back'],
  rolling_back: ['rolled_back', 'rollback_failed'],
  rolled_back: [],
  rollback_failed: [],
}

/** True when `to` is an allowed next release state from `from` in the promotion pipeline. */
export function canReleasePromotionTransition(from: ReleaseStatus, to: ReleaseStatus): boolean {
  return (RELEASE_PROMOTION_TRANSITIONS[from] ?? []).includes(to)
}

/** The release states that belong to the promotion pipeline (for UI/routing checks). */
export const PROMOTION_RELEASE_STATES: ReleaseStatus[] = [
  'awaiting_approval', 'publishing', 'verifying_production', 'published',
  'publish_failed', 'rolling_back', 'rolled_back', 'rollback_failed',
]
