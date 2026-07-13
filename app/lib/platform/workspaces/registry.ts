// ── Role-adaptive workspace registry ─────────────────────────────────────────
//
// The owner experience prioritizes: Today, Jobs, Customers, Team, Messages,
// Money, Assets, Insights, Automations, Settings — plus portal destinations for
// crew/contractor/customer. Each destination declares which personas may see it;
// a workspace's capability set is DERIVED from its visible destinations so a
// persona can never be handed a destination it cannot access.

import type { WorkerId } from '../ai-workers/types'
import type { CapabilityId } from '../capabilities/types'
import type { PersonaRole, RoleWorkspace, WorkspaceDestination, WorkspacePersona } from './types'

const STAFF: WorkspacePersona[] = ['platform-owner', 'org-owner', 'administrator', 'manager', 'dispatcher', 'office']

export const WORKSPACE_DESTINATIONS: WorkspaceDestination[] = [
  { id: 'today', label: 'Today', capability: 'management-workspace', personas: STAFF },
  { id: 'jobs', label: 'Jobs', capability: 'routes', personas: ['platform-owner', 'org-owner', 'administrator', 'manager', 'dispatcher'] },
  { id: 'customers', label: 'Customers', capability: 'customers', personas: ['platform-owner', 'org-owner', 'administrator', 'manager', 'office'] },
  { id: 'team', label: 'Team', capability: 'workforce', personas: ['platform-owner', 'org-owner', 'administrator', 'manager', 'dispatcher'] },
  { id: 'messages', label: 'Messages', capability: 'messaging', personas: ['platform-owner', 'org-owner', 'administrator', 'manager', 'dispatcher', 'office'] },
  { id: 'money', label: 'Money', capability: 'invoicing', personas: ['platform-owner', 'org-owner', 'administrator', 'office'] },
  { id: 'assets', label: 'Assets', capability: 'equipment', personas: ['platform-owner', 'org-owner', 'administrator', 'manager', 'dispatcher'] },
  { id: 'insights', label: 'Insights', capability: 'ai-intelligence', personas: ['platform-owner', 'org-owner', 'administrator', 'manager'] },
  { id: 'automations', label: 'Automations', capability: 'automations', personas: ['platform-owner', 'org-owner', 'administrator', 'manager'] },
  { id: 'settings', label: 'Settings', capability: 'permissions', personas: ['platform-owner', 'org-owner', 'administrator'] },
  // Portal destinations
  { id: 'crew-home', label: 'Home', capability: 'crew-portal', personas: ['crew', 'contractor'] },
  { id: 'crew-jobs', label: 'My Routes', capability: 'crew-portal', personas: ['crew', 'contractor'] },
  { id: 'crew-messages', label: 'Messages', capability: 'messaging', personas: ['crew', 'contractor'] },
  { id: 'my-bookings', label: 'My Bookings', capability: 'customer-portal', personas: ['customer'] },
]

export const ALL_DESTINATION_IDS = WORKSPACE_DESTINATIONS.map((d) => d.id)

function destinationsFor(persona: WorkspacePersona): WorkspaceDestination[] {
  return WORKSPACE_DESTINATIONS.filter((d) => d.personas.includes(persona))
}

// Extra capabilities a persona uses beyond navigation (self-service, etc.).
const EXTRA_CAPS: Partial<Record<WorkspacePersona, CapabilityId[]>> = {
  crew: ['availability', 'time-off', 'time-tracking', 'compliance-photos'],
  contractor: ['availability', 'time-off', 'time-tracking', 'compliance-photos'],
}

const ROLE_OF: Record<WorkspacePersona, PersonaRole> = {
  'platform-owner': 'platform', 'org-owner': 'admin', 'administrator': 'admin',
  manager: 'manager', dispatcher: 'manager', office: 'manager',
  crew: 'crew', contractor: 'crew', customer: 'public',
}

const AI_WORKERS_OF: Partial<Record<WorkspacePersona, WorkerId[]>> = {
  'platform-owner': ['ai-coo', 'ai-dispatcher', 'ai-sales', 'ai-support', 'ai-finance', 'ai-workforce', 'ai-fleet', 'ai-marketing', 'ai-advisor'],
  'org-owner': ['ai-coo', 'ai-dispatcher', 'ai-sales', 'ai-support', 'ai-finance', 'ai-workforce', 'ai-fleet', 'ai-marketing', 'ai-advisor'],
  administrator: ['ai-coo', 'ai-dispatcher', 'ai-sales', 'ai-support', 'ai-finance', 'ai-workforce', 'ai-marketing', 'ai-advisor'],
  manager: ['ai-dispatcher', 'ai-support', 'ai-workforce'],
  dispatcher: ['ai-dispatcher'],
  office: ['ai-support'],
}

function buildWorkspace(persona: WorkspacePersona): RoleWorkspace {
  const dests = destinationsFor(persona)
  const caps = Array.from(new Set<CapabilityId>([
    ...dests.map((d) => d.capability),
    ...(EXTRA_CAPS[persona] ?? []),
  ]))
  return {
    persona,
    role: ROLE_OF[persona],
    destinations: dests,
    capabilities: caps,
    primaryActions: primaryActionsFor(persona),
    visibleMetrics: metricsFor(persona),
    aiWorkers: AI_WORKERS_OF[persona] ?? [],
    approvalAuthority: ['platform-owner', 'org-owner', 'administrator', 'manager'].includes(persona),
    mobilePriorities: mobileFor(persona),
  }
}

function primaryActionsFor(p: WorkspacePersona): string[] {
  if (p === 'crew' || p === 'contractor') return ['confirm-route', 'clock-in', 'upload-uniform']
  if (p === 'customer') return ['pay', 'reschedule']
  if (p === 'dispatcher') return ['create-route', 'assign-crew']
  if (p === 'office') return ['message-customer', 'record-payment']
  return ['create-route', 'new-booking', 'message']
}
function metricsFor(p: WorkspacePersona): string[] {
  if (p === 'crew' || p === 'contractor') return ['next-route', 'pay-summary']
  if (p === 'customer') return ['booking-status']
  if (p === 'office') return ['unread-messages', 'aging-invoices']
  return ['today-routes', 'unconfirmed-assignments', 'revenue', 'crew-coverage']
}
function mobileFor(p: WorkspacePersona): string[] {
  if (p === 'crew' || p === 'contractor') return ['crew-home', 'crew-jobs', 'crew-messages']
  if (p === 'customer') return ['my-bookings']
  return ['today', 'jobs', 'messages']
}

export const PERSONAS: WorkspacePersona[] = [
  'platform-owner', 'org-owner', 'administrator', 'manager', 'dispatcher', 'office', 'crew', 'contractor', 'customer',
]

export const ROLE_WORKSPACES: Record<WorkspacePersona, RoleWorkspace> = Object.freeze(
  PERSONAS.reduce((acc, p) => { acc[p] = buildWorkspace(p); return acc }, {} as Record<WorkspacePersona, RoleWorkspace>),
)

export function workspaceFor(persona: WorkspacePersona): RoleWorkspace {
  return ROLE_WORKSPACES[persona]
}
