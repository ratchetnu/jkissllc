// ── Operion business-detail view model (PURE) ────────────────────────────────
// The read-only derivations behind the simplified business detail page: readiness,
// pending-update grouping, and the single "next step". No I/O, no React — so the owner-
// facing logic (what's ready, what to do next, how updates group) is unit-testable.

import type { PlatformBusiness, PlatformUpdate } from './types'
import { businessRepoRef } from '../automation/repo-identity'

export type UpdateBucket = 'Found automatically' | 'Ready for Preview' | 'Needs Review' | 'Queued' | 'Already Deployed'
export const BUCKET_ORDER: UpdateBucket[] = ['Found automatically', 'Ready for Preview', 'Needs Review', 'Queued', 'Already Deployed']

/**
 * One sentence per bucket, shown under its heading.
 *
 * "Found automatically" exists because `discovered` used to fall through to
 * "Queued" — which tells an owner the opposite of the truth. Queued means "on its
 * way out"; discovered means "this landed on main, nobody has looked at it, and it
 * is going nowhere until you do". Since automatic discovery now files a record for
 * EVERY merge to main, that bucket is where they all accumulate, and mislabelling
 * it would quietly turn the release ledger into a list of things an owner believes
 * are already moving.
 */
export const BUCKET_BLURB: Record<UpdateBucket, string> = {
  'Found automatically': 'Detected when it landed on main. Nobody has reviewed, approved or sent these — they are waiting for you to look.',
  'Ready for Preview': 'Approved for release. These can be sent to a business’s Preview.',
  'Needs Review': 'Something went wrong or is blocked. These need a decision.',
  Queued: 'Being worked on. Not ready to send yet.',
  'Already Deployed': 'Live on at least one business.',
}

/** Which section a pending update belongs to (deployed updates are separated). */
export function updateBucket(status: string): UpdateBucket {
  // Checked FIRST and by name, so it can never fall through to a bucket that
  // implies somebody has already decided something about it.
  if (status === 'discovered') return 'Found automatically'
  if (['approved', 'ready_to_release', 'ready_for_review', 'included_in_release'].includes(status)) return 'Ready for Preview'
  if (['blocked', 'failed'].includes(status)) return 'Needs Review'
  if (['partially_deployed', 'fully_deployed'].includes(status)) return 'Already Deployed'
  return 'Queued'
}

export function groupUpdates(updates: PlatformUpdate[]): Record<UpdateBucket, PlatformUpdate[]> {
  const groups: Record<UpdateBucket, PlatformUpdate[]> = { 'Found automatically': [], 'Ready for Preview': [], 'Needs Review': [], Queued: [], 'Already Deployed': [] }
  for (const u of updates) groups[updateBucket(u.status)].push(u)
  return groups
}

/**
 * The owner-facing name for a raw status. The list view rendered the enum itself,
 * so an automatically-filed record announced itself as the word "discovered" —
 * accurate to the machine, unhelpful to the person deciding what to do about it.
 */
export const STATUS_LABEL: Record<string, string> = {
  discovered: 'Needs review',
  planned: 'Planned',
  queued: 'Queued',
  in_progress: 'In progress',
  implemented: 'Built',
  testing: 'Testing',
  blocked: 'Blocked',
  ready_for_review: 'Ready for review',
  approved: 'Approved',
  ready_to_release: 'Ready to release',
  included_in_release: 'In a release',
  partially_deployed: 'Partly live',
  fully_deployed: 'Live',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  cancelled: 'Cancelled',
  archived: 'Archived',
}

/** Never invents a label: an unmapped status degrades to its own readable form. */
export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, ' ')
}

/**
 * The status filter offered on /admin/operations/platform, in display order.
 *
 * `discovered` is listed explicitly. It used to be the one status a record could
 * actually hold that the filter could not select, so the moment discovery started
 * filing records automatically the only way to see just those was to read every row.
 * The two synthetic entries come first and are not statuses.
 */
export const STATUS_FILTERS = [
  'all', 'pending', 'discovered', 'ready_for_review', 'approved',
  'blocked', 'failed', 'partially_deployed', 'fully_deployed', 'archived',
] as const

/** Statuses `pending` hides. Anything not closed out is "open" — including `discovered`. */
const CLOSED_STATUSES = ['fully_deployed', 'cancelled', 'archived']

/** The row predicate behind the filter. Exported so it is testable away from the page. */
export function matchesStatusFilter(status: string, filter: string): boolean {
  if (filter === 'all') return true
  if (filter === 'pending') return !CLOSED_STATUSES.includes(status)
  return status === filter
}

/** The label shown for a filter option (the two synthetic entries are not statuses). */
export function statusFilterLabel(filter: string): string {
  if (filter === 'all') return 'All'
  if (filter === 'pending') return 'Anything open'
  return statusLabel(filter)
}

export type BusinessReadiness = {
  repo: { owner: string; name: string } | null
  githubReady: boolean
  configurationStatus: string
  previewReady: boolean
  productionProtected: boolean
  missing: string[]
}

/** Derived readiness — reads the existing model + configurationStatus only. */
export function businessReadiness(b: PlatformBusiness): BusinessReadiness {
  const repo = businessRepoRef(b)
  const configurationStatus = b.configurationStatus ?? 'not_configured'
  const missing: string[] = []
  if (!repo) missing.push('Repository (owner/name)')
  if (!b.githubInstallationId) missing.push('GitHub validation')
  if (!b.previewProjectId) missing.push('Preview project ID')
  if (!b.automationWorkflowFile) missing.push('Workflow file')
  return {
    repo,
    githubReady: !!b.githubInstallationId && !!repo,
    configurationStatus,
    previewReady: configurationStatus === 'ready',
    productionProtected: !b.allowProductionPromotion,
    missing,
  }
}

export type NextStepKey = 'connect' | 'configure' | 'prepare' | 'done'
/** The single most important next action, computed from current state. */
export function businessNextStep(b: PlatformBusiness, pendingCount: number): { key: NextStepKey; title: string; detail: string } {
  const r = businessReadiness(b)
  if (!r.githubReady) return { key: 'connect', title: 'Connect GitHub', detail: 'Validate the GitHub connection to link the repository + installation.' }
  if (!r.previewReady) return { key: 'configure', title: 'Complete Preview configuration', detail: r.missing.length ? `Missing: ${r.missing.join(', ')}` : 'Re-run validation to reach “ready”.' }
  if (pendingCount) return { key: 'prepare', title: `Prepare a Preview for ${pendingCount} pending update${pendingCount === 1 ? '' : 's'}`, detail: 'Open a ready update and click Prepare Preview.' }
  return { key: 'done', title: 'All set', detail: 'Connection ready, configuration complete, and no updates pending.' }
}
