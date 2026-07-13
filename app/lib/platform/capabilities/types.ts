// ── Platform capability types ────────────────────────────────────────────────
//
// A capability is a first-class, named unit of platform functionality. The
// registry (registry.ts) is the single typed source of truth for what exists,
// what it depends on, who may use it, and how AI may act on it. Configuration-
// backed (not a DB) this sprint; nothing here changes runtime behavior.

import type { Permission, Role } from '../../rbac'
import type { FeatureFlag } from '../flags'
import type { AutonomyLevel } from '../ai-workers/autonomy'

/** Stable capability identifiers — the vocabulary the platform reasons about. */
export const CAPABILITY_IDS = [
  'identity', 'organizations', 'memberships', 'roles', 'permissions',
  'customers', 'leads', 'quotes', 'pricing', 'bookings', 'jobs', 'routes',
  'scheduling', 'workforce', 'availability', 'time-off', 'time-tracking',
  'gps-verification', 'compliance-photos', 'equipment', 'fleet', 'messaging',
  'notifications', 'documents', 'invoicing', 'payments', 'contractor-compensation',
  'expenses', 'reporting', 'analytics', 'automations', 'ai-intelligence',
  'approvals', 'audit-logs', 'customer-portal', 'crew-portal', 'management-workspace',
] as const

export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/** Implementation status (mirrors docs/opspilot-os/03-capability-matrix.md). */
export type CapabilityStatus = 'full' | 'partial' | 'backend-only' | 'planned' | 'duplicated'

export type CapabilityKind = 'core' | 'optional' | 'industry-specific'

export type Tier = 'free' | 'starter' | 'pro'

export type CapabilityAiAction = { id: string; level: AutonomyLevel }

export type Capability = {
  id: CapabilityId
  displayName: string
  description: string
  domain: string // the owning domain (04-domain-model.md)
  dependencies: CapabilityId[]
  status: CapabilityStatus
  kind: CapabilityKind
  requiredPermissions: Permission[] // permissions a user needs to exercise it
  requiredFlags: FeatureFlag[] // flags that must be on for it to be active
  supportedRoles: Role[] // internal roles that can access it (customer surfaces = [])
  aiActions: CapabilityAiAction[] // AI actions the capability supports + their level
  enabledForJkiss: boolean // whether tenant #0 currently uses it
  tiers: Tier[] // future subscription-tier eligibility
}
