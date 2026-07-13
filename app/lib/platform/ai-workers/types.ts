// ── AI worker types ──────────────────────────────────────────────────────────
//
// An AI worker is a governed role that acts through the existing runAiTask
// pipeline — NOT a free chatbot. Each worker declares exactly what it may touch,
// which permissions the invoking human needs, its autonomy ceiling, and its
// data-access rules. This registry is declarative; wiring workers into live
// runAiTask calls is a later phase (gated by AI_WORKFORCE_ENABLED).

import type { Permission } from '../../rbac'
import type { CapabilityId } from '../capabilities/types'
import type { AutonomyLevel } from './autonomy'

export type WorkerId =
  | 'ai-coo'
  | 'ai-dispatcher'
  | 'ai-sales'
  | 'ai-support'
  | 'ai-finance'
  | 'ai-workforce'
  | 'ai-fleet'
  | 'ai-marketing'
  | 'ai-advisor'

export type PiiAccess = 'none' | 'redacted' | 'full'

export type AiWorker = {
  id: WorkerId
  displayName: string
  purpose: string
  allowedCapabilities: CapabilityId[]
  allowedTools: string[]
  requiredPermissions: Permission[] // the human invoker must hold ALL of these
  dataDomains: string[]
  defaultAutonomy: AutonomyLevel
  approvalRequiredAtOrAbove: AutonomyLevel
  budgetUsdPerDay: number
  rateLimitPerHour: number
  auditRequired: boolean
  prohibitedActions: string[] // always includes the global Level-5 set
  escalationRule: string
  enabledForTenants: 'none' | 'all' | string[]
  industryPackCompatibility: 'all' | string[]
  promptVersionId: string
  modelRoutingPolicy: string
  piiAccess: PiiAccess
  locationDataAccess: boolean
  financialDataAccess: boolean
}
