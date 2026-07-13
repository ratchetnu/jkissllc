// ── Approval state machine ───────────────────────────────────────────────────
//
// Enforces the legal lifecycle so an AI action can NEVER execute without passing
// through a recorded human approval, and a restricted (Level-5) action can never
// be approved at all. Pure functions — no persistence, no clock dependency.

import type { ApprovalRequest, ApprovalStatus, RiskClass } from './types'
import { isProhibitedAction } from '../ai-workers/autonomy'

// Legal transitions. Note: 'executing' is reachable ONLY from 'approved', so
// nothing can execute that has not been approved.
const TRANSITIONS: Record<ApprovalStatus, ApprovalStatus[]> = {
  draft: ['pending', 'cancelled'],
  pending: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: ['executing', 'cancelled'],
  executing: ['completed', 'failed'],
  rejected: [],
  expired: [],
  completed: [],
  failed: [],
  cancelled: [],
}

export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function nextStatuses(from: ApprovalStatus): ApprovalStatus[] {
  return [...(TRANSITIONS[from] ?? [])]
}

/** Restricted risk == a Level-5 category; never eligible for AI-queue approval. */
export function isRestrictedRisk(riskClass: RiskClass): boolean {
  return riskClass === 'restricted'
}

/** Map an action id to a risk floor: prohibited actions are always 'restricted'. */
export function riskFloorForAction(action: string, proposed: RiskClass): RiskClass {
  return isProhibitedAction(action) ? 'restricted' : proposed
}

export type TransitionOpts = {
  decidedBy?: string
  decisionReason?: string
  executionResult?: { ok: boolean; detail?: string }
  rollbackMetadata?: Record<string, unknown>
}

/**
 * Apply a transition, enforcing every guard. Returns a NEW request object.
 * Throws on an illegal transition, a missing decider, or an attempt to approve a
 * restricted action.
 */
export function transition(req: ApprovalRequest, to: ApprovalStatus, opts: TransitionOpts = {}): ApprovalRequest {
  if (!canTransition(req.status, to)) {
    throw new Error(`illegal approval transition: ${req.status} → ${to}`)
  }
  if ((to === 'approved' || to === 'rejected') && !opts.decidedBy) {
    throw new Error(`transition to "${to}" requires decidedBy (a human decision-maker)`)
  }
  if (to === 'approved' && isRestrictedRisk(req.riskClass)) {
    throw new Error('restricted (Level-5) actions cannot be approved via the AI queue — require explicit high-authority human action')
  }
  return {
    ...req,
    status: to,
    decidedBy: opts.decidedBy ?? req.decidedBy,
    decisionReason: opts.decisionReason ?? req.decisionReason,
    executionResult: opts.executionResult ?? req.executionResult,
    rollbackMetadata: opts.rollbackMetadata ?? req.rollbackMetadata,
  }
}
