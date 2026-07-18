// ── Release state resolver (internal, PURE) ──────────────────────────────────
//
// Projects a Business's already-computed signals (from Sync Status + the updates
// registry + any in-flight update job) into ONE human Status and ONE primary action.
// The operator sees a tiny vocabulary — Version, Status, Update — never drift categories,
// SHAs, migrations, or orchestration terms. Those live only in the optional details.
//
// The primary action is intentionally almost always "Update": one intelligent action that
// runs the whole flow (check → plan → validate → Preview → verify → present) and pauses
// only for the deliberate Production approval, which becomes "Publish to Production".

import type { PromotionPhase } from './promotion-state'
import { PROMOTION_PHASE_TO_RELEASE } from './promotion-state'

export type ReleaseStatus =
  | 'not_initialized'
  | 'up_to_date'
  | 'update_available'
  | 'updating'
  | 'preview_ready'
  | 'ready_to_publish'
  | 'action_required'
  | 'verification_failed'
  // ── Production-promotion states (Increment 3B.1; additive, inert until later increments).
  //    Reached ONLY when a promotion phase is present; otherwise the resolver is unchanged. ──
  | 'awaiting_approval'
  | 'publishing'
  | 'verifying_production'
  | 'published'
  | 'publish_failed'
  | 'rolling_back'
  | 'rolled_back'
  | 'rollback_failed'

export type PrimaryAction =
  | 'set_up'        // Set Up
  | 'check'         // Check for Updates (quiet, when up to date)
  | 'update'        // Update  ← the one intelligent action
  | 'view_progress' // View Progress (while the flow runs)
  | 'publish'       // Publish to Production (the approval gate)
  | 'resolve'       // Resolve
  | 'retry'         // Retry
  | 'view_publish_progress' // View Publishing (while a promotion runs)
  | 'rollback'      // Roll Back (restore prior production)

/** Human labels — the ENTIRE externally-visible status vocabulary. */
export const STATUS_LABEL: Record<ReleaseStatus, string> = {
  not_initialized: 'Not set up',
  up_to_date: 'Up to date',
  update_available: 'Update available',
  updating: 'Updating…',
  preview_ready: 'Preview ready',
  ready_to_publish: 'Ready to publish',
  action_required: 'Action required',
  verification_failed: 'Verification failed',
  awaiting_approval: 'Awaiting approval',
  publishing: 'Publishing…',
  verifying_production: 'Verifying production…',
  published: 'Published',
  publish_failed: 'Publish failed',
  rolling_back: 'Rolling back…',
  rolled_back: 'Rolled back',
  rollback_failed: 'Rollback failed',
}

export const ACTION_LABEL: Record<PrimaryAction, string> = {
  set_up: 'Set Up',
  check: 'Check for Updates',
  update: 'Update',
  view_progress: 'View Progress',
  publish: 'Publish to Production',
  resolve: 'Resolve',
  retry: 'Retry',
  view_publish_progress: 'View Publishing',
  rollback: 'Roll Back',
}

export type StatusTone = 'ok' | 'attention' | 'busy' | 'critical' | 'neutral'
export function statusTone(s: ReleaseStatus): StatusTone {
  switch (s) {
    case 'up_to_date': return 'ok'
    case 'ready_to_publish': case 'preview_ready': return 'ok'
    case 'published': return 'ok'
    case 'update_available': return 'attention'
    case 'awaiting_approval': return 'attention'
    case 'updating': return 'busy'
    case 'publishing': case 'verifying_production': case 'rolling_back': return 'busy'
    case 'action_required': case 'verification_failed': return 'critical'
    case 'publish_failed': case 'rollback_failed': return 'critical'
    case 'rolled_back': return 'attention'
    case 'not_initialized': return 'neutral'
  }
}

/** The guided flow the "Update" action runs — shown as a calm progress sequence. */
export const GUIDED_STEPS = ['Check', 'Review', 'Preview', 'Verify', 'Promote'] as const
export type GuidedStep = (typeof GUIDED_STEPS)[number]

/** Collapsed job phase from the (internal) automation machine. */
export type JobPhase =
  | 'none' | 'running' | 'preview_deploying' | 'preview_ready'
  | 'verifying' | 'awaiting_approval' | 'promoting' | 'failed'

/** Everything the resolver needs — assembled from existing systems, no new store. */
export type ReleaseSignals = {
  initialized: boolean
  installedVersion?: string
  latestVersion?: string
  health: 'healthy' | 'degraded' | 'down' | 'unknown'
  updateAvailable: boolean
  job: JobPhase
  previewVerified: boolean
  verificationFailed: boolean
  blocking: string[]      // hard blockers (details-only text)
  driftReasons: string[]  // collapsed drift notes (details-only text)
  lastUpdatedAt?: number
  /** Production-promotion phase (Increment 3B.1). Absent for every preview-only flow —
   *  when unset the resolver behaves EXACTLY as in Increment 3A. */
  promotion?: PromotionPhase
}

export type ReleaseState = {
  status: ReleaseStatus
  statusLabel: string
  tone: StatusTone
  action: PrimaryAction
  actionLabel: string
  installedVersion: string   // display-safe ('—' when unknown)
  latestVersion: string
  lastUpdatedAt?: number
  /** For the "View Details" panel only — never shown in the calm summary. */
  details: { blocking: string[]; driftReasons: string[] }
}

/**
 * The single source of truth for "what does this Business show, and what is its one
 * button". Deterministic precedence: safety/in-flight first, then the happy path.
 */
export function resolveReleaseState(s: ReleaseSignals): ReleaseState {
  const base = {
    installedVersion: s.installedVersion?.trim() || '—',
    latestVersion: s.latestVersion?.trim() || '—',
    lastUpdatedAt: s.lastUpdatedAt,
    details: { blocking: s.blocking, driftReasons: s.driftReasons },
  }
  const out = (status: ReleaseStatus, action: PrimaryAction): ReleaseState => ({
    status, statusLabel: STATUS_LABEL[status], tone: statusTone(status),
    action, actionLabel: ACTION_LABEL[action], ...base,
  })

  // Production-promotion phases dominate the display when present (Increment 3B.1). This
  // branch is inert for every preview-only flow (promotion undefined) — nothing below changes.
  if (s.promotion) {
    const m = PROMOTION_PHASE_TO_RELEASE[s.promotion]
    return out(m.status, m.action)
  }

  if (!s.initialized) return out('not_initialized', 'set_up')
  if (s.job === 'failed' || s.verificationFailed) return out('verification_failed', 'retry')
  if (s.job === 'running' || s.job === 'preview_deploying' || s.job === 'verifying' || s.job === 'promoting') {
    return out('updating', 'view_progress')
  }
  if (s.job === 'awaiting_approval' || s.previewVerified) return out('ready_to_publish', 'publish')
  if (s.job === 'preview_ready') return out('preview_ready', 'view_progress')
  if (s.blocking.length > 0) return out('action_required', 'resolve')
  if (s.health === 'down') return out('action_required', 'resolve')
  if (s.updateAvailable) return out('update_available', 'update')
  if (s.driftReasons.length > 0) return out('action_required', 'resolve')
  return out('up_to_date', 'check')
}
