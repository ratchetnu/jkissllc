// ── Operion business-detail view model (PURE) ────────────────────────────────
// The read-only derivations behind the simplified business detail page: readiness,
// pending-update grouping, and the single "next step". No I/O, no React — so the owner-
// facing logic (what's ready, what to do next, how updates group) is unit-testable.

import type { PlatformBusiness, PlatformUpdate } from './types'
import { businessRepoRef } from '../automation/repo-identity'

export type UpdateBucket = 'Ready for Preview' | 'Needs Review' | 'Queued' | 'Already Deployed'
export const BUCKET_ORDER: UpdateBucket[] = ['Ready for Preview', 'Needs Review', 'Queued', 'Already Deployed']

/** Which section a pending update belongs to (deployed updates are separated). */
export function updateBucket(status: string): UpdateBucket {
  if (['approved', 'ready_to_release', 'ready_for_review', 'included_in_release'].includes(status)) return 'Ready for Preview'
  if (['blocked', 'failed'].includes(status)) return 'Needs Review'
  if (['partially_deployed', 'fully_deployed'].includes(status)) return 'Already Deployed'
  return 'Queued'
}

export function groupUpdates(updates: PlatformUpdate[]): Record<UpdateBucket, PlatformUpdate[]> {
  const groups: Record<UpdateBucket, PlatformUpdate[]> = { 'Ready for Preview': [], 'Needs Review': [], Queued: [], 'Already Deployed': [] }
  for (const u of updates) groups[updateBucket(u.status)].push(u)
  return groups
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
