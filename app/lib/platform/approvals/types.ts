// ── Approval domain types ────────────────────────────────────────────────────
//
// The record behind human-approved AI actions (Level 3). No automatic execution
// exists this sprint; this is the typed foundation + state machine (machine.ts),
// gated by APPROVAL_QUEUE_ENABLED. See 07-ai-operating-layer.md.

import type { Role } from '../../rbac'

export type ApprovalStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 'restricted' == a Level-5 category: never approvable via the AI queue. */
export type RiskClass = 'low' | 'medium' | 'high' | 'restricted'

export type ApprovalRequest = {
  id: string
  tenantId: string
  requestedAction: string
  requestingWorkerId: string
  approverRole: Role
  riskClass: RiskClass
  actionPreview: string
  explanation: string
  evidence: string[]
  confidence: number // 0..1
  expectedImpact: string
  expiresAt: number
  status: ApprovalStatus
  decidedBy?: string
  decisionReason?: string
  executionResult?: { ok: boolean; detail?: string }
  rollbackMetadata?: Record<string, unknown>
  createdAt: number
}

export const TERMINAL_STATUSES: ReadonlySet<ApprovalStatus> = new Set([
  'rejected', 'expired', 'completed', 'failed', 'cancelled',
])
