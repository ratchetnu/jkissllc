// ── Operion AI — Evaluation Queue priority engine (PURE) ─────────────────────
//
// Turns a booking's shadow run-status into "where does this sit in the owner's work queue,
// why is it here, and what one action finishes it". Deterministic — NO AI, no clock beyond the
// `now` the caller passes for age. The Queue page and its API both derive ordering THROUGH here,
// so priority is identical everywhere and testable in isolation.
//
// Reuses the existing state vocabulary (ShadowRunStatus / ShadowRunView from shadow-run-status)
// — this adds no new lifecycle, only a priority + reason + next-action reading of it.

import type { ShadowRunStatus, ShadowRunView } from './shadow-run-status'

// The owner's attention order, most-urgent tier first. Lower number = higher priority.
export const QUEUE_TIERS = [
  'needs_intervention',    // failed / retry-blocked / budget-blocked / kill-switch — the model is stuck
  'awaiting_review',       // completed + went to manual_review, not yet owner-reviewed
  'missing_ground_truth',  // completed, no owner benchmark — blocks accuracy + readiness
  'uncategorized',         // completed + benchmarked, but no failure category recorded
  'ready_to_run',          // selected/eligible and runnable now
  'in_flight',             // queued / processing — nothing for the owner to do yet
  'informational',         // fully handled, or not a candidate
] as const
export type QueueTier = (typeof QUEUE_TIERS)[number]
export const tierRank = (t: QueueTier): number => QUEUE_TIERS.indexOf(t)

export const QUEUE_TIER_LABEL: Record<QueueTier, string> = {
  needs_intervention: 'Needs intervention',
  awaiting_review: 'Awaiting review',
  missing_ground_truth: 'Missing ground truth',
  uncategorized: 'Uncategorized',
  ready_to_run: 'Ready to run',
  in_flight: 'In flight',
  informational: 'Handled',
}

// The single dominant action offered per item. `kind` maps to a concrete control the UI wires;
// `href` items navigate, `action` items POST to the shadow-run/analytics routes.
export type QueueAction =
  | { kind: 'run'; label: string }
  | { kind: 'retry'; label: string }
  | { kind: 'review'; label: string }        // → open eval detail to record ground truth
  | { kind: 'categorize'; label: string }    // → open eval detail to tag categories
  | { kind: 'resolve'; label: string }       // → open eval detail to resolve a failure
  | { kind: 'open'; label: string }          // → open eval detail (view)
  | { kind: 'select'; label: string }
  | { kind: 'none'; label: string }

/** What the Queue needs to know about one booking. Derived from the existing status view plus
 *  the few evaluation facts the row displays. No new persistence. */
export type QueueInput = {
  bookingId: string
  status: ShadowRunStatus
  view: Pick<ShadowRunView, 'canRun' | 'canRetry' | 'canOpen'>
  selected: boolean
  eligible: boolean
  hasComparison: boolean
  hasGroundTruth: boolean
  hasCategories: boolean
  reviewedAt?: number
  wentToManualReview: boolean
  updatedAt: number
}

export type QueueDerived = {
  tier: QueueTier
  /** Owner-facing sentence: why this is in the queue. */
  reason: string
  action: QueueAction
  /** True when the owner has an action that advances this item (drives "Review next"). */
  actionable: boolean
}

/**
 * Map one item onto its tier + reason + dominant next action. The ORDER of these checks IS the
 * priority policy — the first matching branch wins, so a failed job that also lacks ground truth
 * surfaces as an intervention, not as missing ground truth.
 */
export function deriveQueue(item: QueueInput): QueueDerived {
  const s = item.status

  // 1. Stuck — the model can't proceed without the owner.
  if (s === 'failed') return { tier: 'needs_intervention', reason: 'The evaluation failed and can be retried.', action: { kind: 'retry', label: 'Retry' }, actionable: true }
  if (s === 'retry_blocked') return { tier: 'needs_intervention', reason: 'A permanent failure (billing/auth/schema) — a retry cannot succeed until the cause is fixed.', action: { kind: 'resolve', label: 'Review failure' }, actionable: true }
  if (s === 'budget_blocked') return { tier: 'needs_intervention', reason: 'A budget cap is stopping the next run.', action: { kind: 'open', label: 'View' }, actionable: false }
  if (s === 'kill_switch') return { tier: 'needs_intervention', reason: 'Inference is halted by the kill switch.', action: { kind: 'open', label: 'View' }, actionable: false }

  // 2. Completed and needs a human read (V2 asked for manual review, owner hasn't looked).
  if (item.hasComparison && item.wentToManualReview && !item.reviewedAt) {
    return { tier: 'awaiting_review', reason: 'V2 flagged this for manual review — needs an owner read.', action: { kind: 'review', label: 'Review result' }, actionable: true }
  }

  // 3. Completed, no owner benchmark — the single biggest blocker on accuracy + readiness.
  if (s === 'awaiting_ground_truth' || (item.hasComparison && !item.hasGroundTruth)) {
    return { tier: 'missing_ground_truth', reason: 'Completed, but no owner-confirmed quote yet — record it to score the model.', action: { kind: 'review', label: 'Add ground truth' }, actionable: true }
  }

  // 4. Benchmarked but not categorized — a learning-signal gap, not a blocker.
  if (item.hasComparison && item.hasGroundTruth && !item.hasCategories) {
    return { tier: 'uncategorized', reason: 'Scored, but no failure category tagged yet — categorize to feed the learning heatmaps.', action: { kind: 'categorize', label: 'Categorize' }, actionable: true }
  }

  // 5. Ready to run now.
  if (item.view.canRun) return { tier: 'ready_to_run', reason: item.selected ? 'Selected and eligible — ready to run.' : 'Eligible — select and run a shadow evaluation.', action: { kind: 'run', label: 'Run evaluation' }, actionable: true }
  if (!item.selected && item.eligible) return { tier: 'ready_to_run', reason: 'Eligible for shadow evaluation.', action: { kind: 'select', label: 'Select' }, actionable: true }

  // 6. In flight — nothing to do but wait.
  if (s === 'queued' || s === 'processing') return { tier: 'in_flight', reason: s === 'processing' ? 'V2 is analyzing the photos now.' : 'Queued for the shadow worker.', action: { kind: 'none', label: 'Waiting' }, actionable: false }

  // 7. Fully handled (completed + benchmarked + categorized) or not a candidate.
  return {
    tier: 'informational',
    reason: item.hasComparison ? 'Completed, benchmarked, and categorized — nothing outstanding.' : 'Not currently a shadow candidate.',
    action: { kind: 'open', label: item.view.canOpen ? 'Open comparison' : 'Open' },
    actionable: false,
  }
}

/**
 * Stable total order: tier first, then oldest-first WITHIN a tier (age = the owner has waited
 * longest on it), then bookingId as a deterministic tiebreak so the order never wobbles between
 * requests. Pure; callers pass the derived tier alongside each item.
 */
export function orderQueue<T extends { bookingId: string; updatedAt: number; derived: QueueDerived }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    tierRank(a.derived.tier) - tierRank(b.derived.tier) ||
    a.updatedAt - b.updatedAt ||
    a.bookingId.localeCompare(b.bookingId))
}

/** The next item "Review next" should open: the highest-priority ACTIONABLE item. Null when the
 *  queue is clear of owner work. */
export function nextActionable<T extends { bookingId: string; updatedAt: number; derived: QueueDerived }>(items: T[]): T | null {
  return orderQueue(items).find((i) => i.derived.actionable) ?? null
}

export type QueueCounts = Record<QueueTier, number>
export function countByTier<T extends { derived: QueueDerived }>(items: T[]): QueueCounts {
  const out = Object.fromEntries(QUEUE_TIERS.map((t) => [t, 0])) as QueueCounts
  for (const i of items) out[i.derived.tier]++
  return out
}
