// ── Operion Shadow — owner-facing run status projection (PURE) ───────────────
//
// Turns a (booking, job, eligibility, budget) tuple into the single status vocabulary the
// owner UI renders. PURE: no I/O, no clock beyond the `now` the caller passes. The route and
// the client both read status THROUGH here, so "Budget blocked" means the same thing in the
// booking detail, the estimate review, and the eligible-jobs table.

import type { V2ShadowJob } from './shadow-types'
import { decideShadowSpend, type ShadowBudgetLimits, type ShadowSpendState } from './shadow-budget'
import { groundTruthQuote } from './shadow-comparison'

export type ShadowRunStatus =
  | 'not_selected'
  | 'selected'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'retry_blocked'          // failed AND permanent (billing/auth/schema/…) — a retry can't help
  | 'budget_blocked'         // a cap would stop the next run
  | 'kill_switch'            // inference halted by the kill switch
  | 'awaiting_ground_truth'  // completed, but no owner benchmark yet

export type ShadowRunView = {
  status: ShadowRunStatus
  label: string
  /** Which owner actions are offered for this status (the UI shows only these). */
  canSelect: boolean
  canUnselect: boolean
  canRun: boolean
  canRetry: boolean
  canRerun: boolean
  canOpen: boolean           // a completed comparison exists to open
  detail: string
}

// Permanent failure categories a retry cannot fix — mirrors the non-transient set.
const PERMANENT_FAILURES = new Set(['provider_billing', 'provider_auth', 'unsupported_image', 'no_usable_images', 'invalid_output'])

const LABEL: Record<ShadowRunStatus, string> = {
  not_selected: 'Not selected',
  selected: 'Selected',
  queued: 'Queued',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  retry_blocked: 'Retry blocked',
  budget_blocked: 'Budget blocked',
  kill_switch: 'Kill switch enabled',
  awaiting_ground_truth: 'Awaiting ground truth',
}

export type ShadowRunInputs = {
  selected: boolean
  eligible: boolean
  eligibilityReason: string
  job: V2ShadowJob | null
  budget: ShadowBudgetLimits
  spend: ShadowSpendState
}

/**
 * Project the owner-facing status. Order matters: an operator-level stop (kill switch) and a
 * hard resource stop (budget) outrank a job's own lifecycle, because they change what the owner
 * can DO next regardless of where the job sits.
 */
export function projectShadowRun(input: ShadowRunInputs): ShadowRunView {
  const { job, selected } = input
  const hasComparison = !!job?.comparison
  const hasGroundTruth = groundTruthQuote(job?.groundTruth) !== null

  // Would the next inference be allowed? (Only meaningful when a run is a possible next step.)
  const spendDecision = decideShadowSpend(input.budget, input.spend)
  const killed = !spendDecision.allowed && spendDecision.block === 'killed'
  const budgetBlocked = !spendDecision.allowed && spendDecision.block !== 'killed'

  const base = { canSelect: false, canUnselect: false, canRun: false, canRetry: false, canRerun: false, canOpen: hasComparison }
  const view = (status: ShadowRunStatus, detail: string, over: Partial<ShadowRunView> = {}): ShadowRunView =>
    ({ status, label: LABEL[status], detail, ...base, ...over })

  // ── active lifecycle states are reported as-is (an in-flight job is neither blocked nor runnable) ──
  if (job?.status === 'processing') return view('processing', 'V2 is analyzing the photos now.', { canOpen: hasComparison })
  if (job?.status === 'queued' || job?.status === 'retrying') {
    return view('queued', 'Waiting for the shadow worker to pick it up.', { canUnselect: selected })
  }

  // ── completed ──
  if (job?.status === 'completed' || job?.status === 'manual_review') {
    if (!hasGroundTruth) {
      return view('awaiting_ground_truth', 'V2 finished. Record the amount you actually quoted to score it.', {
        canOpen: true, canRerun: !killed && !budgetBlocked, canUnselect: selected,
      })
    }
    return view('completed', 'V2 finished and has an owner benchmark.', {
      canOpen: true, canRerun: !killed && !budgetBlocked, canUnselect: selected,
    })
  }

  // ── failed ──
  if (job?.status === 'failed') {
    const permanent = job.failureCategory ? PERMANENT_FAILURES.has(job.failureCategory) : false
    if (permanent) {
      return view('retry_blocked', `${job.failureSummary ?? 'Permanent failure'} — a retry cannot succeed until the cause is fixed.`, {
        canOpen: hasComparison, canRerun: !killed && !budgetBlocked,
      })
    }
    if (killed) return view('kill_switch', 'Inference is halted by the kill switch; retry once it is released.', { canOpen: hasComparison })
    if (budgetBlocked) return view('budget_blocked', spendDecision.allowed ? '' : spendDecision.detail, { canOpen: hasComparison })
    return view('failed', `${job.failureSummary ?? 'The run failed'} — a retry is allowed.`, { canRetry: true, canOpen: hasComparison })
  }

  // ── no job yet: selection + run gating ──
  if (killed) return view('kill_switch', 'V2 inference is halted by the kill switch.', { canSelect: !selected, canUnselect: selected })
  if (!selected) return view('not_selected', input.eligible ? 'Eligible — select it to allow a shadow run.' : `Not eligible: ${input.eligibilityReason}.`, { canSelect: input.eligible })
  if (budgetBlocked) return view('budget_blocked', spendDecision.allowed ? '' : spendDecision.detail, { canUnselect: true })
  return view('selected', input.eligible ? 'Selected and eligible — ready to run.' : `Selected, but not eligible: ${input.eligibilityReason}.`, {
    canUnselect: true, canRun: input.eligible,
  })
}
