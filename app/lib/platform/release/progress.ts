// ── Update progress mapping (internal, PURE) ─────────────────────────────────
//
// Maps the EXISTING automation job's real state to the five calm steps the drawer shows.
// It reads the job that the orchestrator already drives — it does not compute or store any
// status of its own. The operator sees "Checking / Preparing Preview / Deploying Preview /
// Verifying Preview / Ready to Publish" and short human messages; internal job names, SHAs,
// migration ids, and failure categories never surface here (Advanced only).

export const UPDATE_STEPS = ['Checking', 'Preparing Preview', 'Deploying Preview', 'Verifying Preview', 'Ready to Publish'] as const
export type UpdateStep = (typeof UPDATE_STEPS)[number]

export type UpdateProgress = {
  step: number                 // 0..4 index into UPDATE_STEPS (current step)
  stepLabel: UpdateStep
  message: string              // short, human
  done: number                 // count of fully-completed steps (0..5)
  running: boolean             // a job is actively moving
  previewReady: boolean        // verified preview — Ready to Publish (NOT installed)
  blocked: boolean
  canRetry: boolean
  issue?: string               // one clear human message when blocked
}

/** Preview-stage failures the operator can safely retry. */
const RETRYABLE = new Set(['failed', 'build_failed'])
/** Any failure/attention state. */
const FAILED = new Set(['failed', 'build_failed', 'blocked', 'rollback_required'])

/**
 * Map an automation job status (+ optional failure note) to the calm progress view.
 * `hasJob=false` means no update is running yet (the initial "Update" affordance).
 */
export function mapJobToProgress(status: string | null | undefined, opts: { failureSummary?: string; hasJob?: boolean } = {}): UpdateProgress {
  const at = (step: number, message: string, extra: Partial<UpdateProgress> = {}): UpdateProgress => ({
    step, stepLabel: UPDATE_STEPS[step], message, done: step, running: true, previewReady: false, blocked: false, canRetry: false, ...extra,
  })

  if (!opts.hasJob || !status) {
    return { step: 0, stepLabel: UPDATE_STEPS[0], message: 'Ready to check for and apply the latest update.', done: 0, running: false, previewReady: false, blocked: false, canRetry: false }
  }

  switch (status) {
    case 'draft': case 'validating': case 'queued':
      return at(0, 'Checking your version and prerequisites…')
    case 'creating_branch': case 'applying_update':
      return at(1, 'Preparing the update…')
    case 'testing':
      return at(1, 'Running checks…')
    case 'preview_deploying':
      return at(2, 'Deploying a preview…')
    case 'preview_ready':
      return at(3, 'Verifying the preview…')
    case 'awaiting_owner_review': case 'owner_review': case 'completed':
      return { step: 4, stepLabel: UPDATE_STEPS[4], message: 'Preview verified — ready to publish when you are.', done: 5, running: false, previewReady: true, blocked: false, canRetry: false }
    // Production-only states must never appear in this Preview-only flow; if seen, show a
    // neutral "in progress" and never a publish/promote control here.
    case 'approved_for_production': case 'merging': case 'production_deploying': case 'verifying':
      return at(4, 'Finishing up…', { previewReady: true })
    case 'cancelled': case 'rolled_back': case 'rolling_back':
      return { step: 0, stepLabel: UPDATE_STEPS[0], message: 'The last update was stopped. You can start again.', done: 0, running: false, previewReady: false, blocked: false, canRetry: true }
    default:
      if (FAILED.has(status)) {
        return {
          step: 1, stepLabel: UPDATE_STEPS[1], done: 0, running: false, previewReady: false, blocked: true,
          canRetry: RETRYABLE.has(status),
          message: RETRYABLE.has(status) ? 'The update didn’t finish. You can retry safely.' : 'This needs your attention before it can update.',
          issue: humanIssue(status),
        }
      }
      return at(0, 'Working…')
  }
}

/** One clear, jargon-free reason — never the raw internal summary. */
function humanIssue(status: string): string {
  if (status === 'build_failed' || status === 'failed') return 'The update didn’t complete. Nothing was published; you can retry.'
  return 'Something needs attention before this can update.'
}
