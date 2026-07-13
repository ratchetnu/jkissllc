// ── AI autonomy levels (0–5) ─────────────────────────────────────────────────
//
// The governed authority ladder shared by AI workers and capabilities. Higher =
// more power; Level 5 is a hard ceiling that is NEVER autonomously executed.
// See docs/opspilot-os/07-ai-operating-layer.md §5.

export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  0: 'Informational',
  1: 'Recommendation',
  2: 'Draft',
  3: 'Approval Required',
  4: 'Policy-Bounded Automation',
  5: 'Prohibited / Highly Restricted',
}

/** The level at which per-action human approval becomes mandatory. */
export const APPROVAL_REQUIRED_AT: AutonomyLevel = 3

/** L3 needs a recorded per-action human approval before it may execute. */
export function requiresApproval(level: AutonomyLevel): boolean {
  return level === 3
}

/** L4 executes autonomously but ONLY within a pre-approved policy + hard limits. */
export function isPolicyBounded(level: AutonomyLevel): boolean {
  return level === 4
}

/** Level 5 can never be executed by AI, approved or not. */
export function isAutonomouslyExecutable(level: AutonomyLevel): boolean {
  return level <= 4
}

// Action categories that are ALWAYS Level 5 — never autonomously executed, only
// performed by an explicitly authorized human. Matches the prompt's restricted list.
export const PROHIBITED_ACTIONS = [
  'permission.change',
  'tenant.administer',
  'record.delete',
  'tax.file',
  'legal.determine',
  'employee.discipline',
  'employee.terminate',
  'refund.large',
  'bank_account.change',
  'tenant.cross_access',
  'audit.disable',
  'safety_control.remove',
] as const

export type ProhibitedAction = (typeof PROHIBITED_ACTIONS)[number]

const PROHIBITED_SET = new Set<string>(PROHIBITED_ACTIONS)

/** True when an action id is in the always-Level-5 restricted set. */
export function isProhibitedAction(action: string): boolean {
  return PROHIBITED_SET.has(action)
}
