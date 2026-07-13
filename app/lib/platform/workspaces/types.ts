// ── Role-adaptive workspace types ────────────────────────────────────────────
//
// Defines what each persona SEES and may do, so navigation can adapt by role
// without redesigning the UI. This is an information-architecture layer, not a
// production nav cutover — it is validated against current routes (route-map.ts)
// and consumed later. See 11-ux-and-design-system.md §8.

import type { Role } from '../../rbac'
import type { CapabilityId } from '../capabilities/types'
import type { WorkerId } from '../ai-workers/types'

export type WorkspacePersona =
  | 'platform-owner'
  | 'org-owner'
  | 'administrator'
  | 'manager'
  | 'dispatcher'
  | 'office'
  | 'crew'
  | 'contractor'
  | 'customer'

/** How a persona maps onto the concrete RBAC role (or a non-session context). */
export type PersonaRole = Role | 'platform' | 'public'

export type WorkspaceDestination = {
  id: string
  label: string
  capability: CapabilityId
  personas: WorkspacePersona[]
}

export type RoleWorkspace = {
  persona: WorkspacePersona
  role: PersonaRole
  destinations: WorkspaceDestination[]
  capabilities: CapabilityId[]
  primaryActions: string[]
  visibleMetrics: string[]
  aiWorkers: WorkerId[]
  approvalAuthority: boolean
  mobilePriorities: string[]
}
