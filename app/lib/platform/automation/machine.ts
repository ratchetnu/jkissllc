// ── Operion automation — PURE status state machine ───────────────────────────
// No I/O. Encodes the pipeline + the hard invariant: the ONLY path to production is
// awaiting_owner_review → approved_for_production, and NOTHING auto-advances past
// awaiting_owner_review. The orchestrator enforces WHO may make that transition (owner);
// this module enforces WHICH transitions are structurally legal.

import type { AutomationStatus, AutomationStep } from './types'
import { AUTOMATION_ACTIVE, AUTOMATION_TERMINAL } from './types'

const ALLOWED: Record<AutomationStatus, AutomationStatus[]> = {
  draft: ['validating', 'cancelled'],
  validating: ['queued', 'blocked', 'cancelled'],
  blocked: ['validating', 'queued', 'cancelled'],
  queued: ['creating_branch', 'cancelled', 'failed'],
  creating_branch: ['applying_update', 'failed', 'cancelled'],
  applying_update: ['testing', 'failed', 'cancelled'],
  testing: ['preview_deploying', 'build_failed', 'failed', 'cancelled'],
  build_failed: ['queued', 'failed', 'cancelled'],           // retry or give up
  preview_deploying: ['preview_ready', 'failed', 'cancelled'],
  preview_ready: ['awaiting_owner_review', 'failed', 'cancelled'],
  // The owner-gated boundary. approved_for_production is reachable ONLY from here.
  awaiting_owner_review: ['approved_for_production', 'failed', 'cancelled', 'rollback_required'],
  approved_for_production: ['merging', 'cancelled', 'failed'],
  merging: ['production_deploying', 'failed', 'cancelled'],   // failed = conflict/commit drift
  production_deploying: ['verifying', 'failed', 'rollback_required'],
  verifying: ['completed', 'rollback_required', 'failed'],
  rollback_required: ['rolling_back', 'failed'],
  rolling_back: ['rolled_back', 'failed'],
  // terminal (failed may be retried back to queued)
  completed: [],
  failed: ['queued'],
  cancelled: [],
  rolled_back: [],
}

const STEP: Record<AutomationStatus, AutomationStep> = {
  draft: 'preflight', validating: 'preflight', blocked: 'preflight', queued: 'branch',
  creating_branch: 'branch', applying_update: 'implementation', testing: 'tests',
  build_failed: 'build', preview_deploying: 'preview', preview_ready: 'preview',
  awaiting_owner_review: 'owner_review', approved_for_production: 'production', merging: 'production',
  production_deploying: 'production', verifying: 'verification', completed: 'verification',
  failed: 'verification', cancelled: 'verification', rollback_required: 'verification',
  rolling_back: 'verification', rolled_back: 'verification',
}

export const STEP_ORDER: AutomationStep[] = ['preflight', 'branch', 'implementation', 'tests', 'build', 'preview', 'owner_review', 'production', 'verification']

export function canTransition(from: AutomationStatus, to: AutomationStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}
export function stepFor(status: AutomationStatus): AutomationStep { return STEP[status] }
export function isActive(status: AutomationStatus): boolean { return AUTOMATION_ACTIVE.includes(status) }
export function isTerminal(status: AutomationStatus): boolean { return AUTOMATION_TERMINAL.includes(status) }

/** The single owner-gated transition into the production half of the pipeline. */
export function isProductionApprovalTransition(from: AutomationStatus, to: AutomationStatus): boolean {
  return from === 'awaiting_owner_review' && to === 'approved_for_production'
}

/** True if `status` is any point at or beyond the owner-approval gate (production side). */
export function isProductionPhase(status: AutomationStatus): boolean {
  return ['approved_for_production', 'merging', 'production_deploying', 'verifying'].includes(status)
}
