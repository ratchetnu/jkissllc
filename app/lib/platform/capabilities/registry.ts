// ── Platform capability registry ─────────────────────────────────────────────
//
// The typed source of truth for every platform capability. Status values reflect
// docs/opspilot-os/03-capability-matrix.md as verified against the repo. This is
// configuration — importing it changes no runtime behavior (guarded further by the
// CAPABILITY_REGISTRY_ENABLED flag at the query layer).

import type { Capability, CapabilityId } from './types'

// Small builder so each entry states only what differs from the common defaults.
type CapInput = Pick<Capability, 'id' | 'displayName' | 'description' | 'domain' | 'status' | 'kind'> &
  Partial<Capability>

function cap(c: CapInput): Capability {
  return {
    dependencies: [],
    requiredPermissions: [],
    requiredFlags: [],
    supportedRoles: ['admin', 'manager'],
    aiActions: [],
    enabledForJkiss: true,
    tiers: ['free', 'starter', 'pro'],
    ...c,
  }
}

const LIST: Capability[] = [
  // ── Identity & tenancy ──
  cap({ id: 'identity', displayName: 'Identity', description: 'Authentication and user identity.', domain: 'Identity & Tenancy', status: 'full', kind: 'core', supportedRoles: ['admin', 'manager', 'crew'] }),
  cap({ id: 'organizations', displayName: 'Organizations', description: 'Tenant/organization records.', domain: 'Identity & Tenancy', status: 'planned', kind: 'core', dependencies: ['identity'], requiredFlags: ['TENANCY_ENABLED'], enabledForJkiss: false }),
  cap({ id: 'memberships', displayName: 'Memberships', description: 'User↔tenant↔role association.', domain: 'Identity & Tenancy', status: 'planned', kind: 'core', dependencies: ['identity', 'organizations', 'roles'], requiredFlags: ['TENANCY_ENABLED'], enabledForJkiss: false }),
  cap({ id: 'roles', displayName: 'Roles', description: 'Role definitions (admin/manager/crew).', domain: 'Identity & Tenancy', status: 'full', kind: 'core', dependencies: ['identity'] }),
  cap({ id: 'permissions', displayName: 'Permissions', description: 'RBAC permission matrix.', domain: 'Identity & Tenancy', status: 'partial', kind: 'core', dependencies: ['roles'], requiredPermissions: ['roles:manage'] }),

  // ── CRM ──
  cap({ id: 'customers', displayName: 'Customers', description: 'First-class customer records.', domain: 'CRM', status: 'planned', kind: 'core', dependencies: ['identity'], enabledForJkiss: false }),
  cap({ id: 'leads', displayName: 'Leads', description: 'Lead intake and pipeline.', domain: 'CRM', status: 'partial', kind: 'core', dependencies: ['identity'] }),

  // ── Sales & pricing ──
  cap({ id: 'quotes', displayName: 'Quotes', description: 'Estimates and quote lifecycle.', domain: 'Sales', status: 'partial', kind: 'core', dependencies: ['pricing'], aiActions: [{ id: 'quote.draft', level: 2 }] }),
  cap({ id: 'pricing', displayName: 'Pricing', description: 'Dynamic pricing + calibration.', domain: 'Pricing', status: 'full', kind: 'core', aiActions: [{ id: 'price.estimate', level: 0 }] }),

  // ── Jobs & scheduling ──
  cap({ id: 'bookings', displayName: 'Bookings', description: 'Retail booking lifecycle.', domain: 'Sales/Booking', status: 'full', kind: 'core', dependencies: ['pricing'] }),
  cap({ id: 'jobs', displayName: 'Jobs', description: 'Unified job concept (target).', domain: 'Jobs', status: 'partial', kind: 'core', dependencies: ['bookings', 'routes'] }),
  cap({ id: 'routes', displayName: 'Routes', description: 'Contractor dispatch operations.', domain: 'Dispatch/Routes', status: 'full', kind: 'core', requiredPermissions: ['routes:manage'] }),
  cap({ id: 'scheduling', displayName: 'Scheduling', description: 'Capacity, blackout, availability calendar.', domain: 'Scheduling', status: 'full', kind: 'core', dependencies: ['bookings'] }),

  // ── Workforce ──
  cap({ id: 'workforce', displayName: 'Workforce', description: 'Crew / contractor roster.', domain: 'Workforce', status: 'full', kind: 'core', requiredPermissions: ['crew:manage'], supportedRoles: ['admin', 'manager', 'crew'] }),
  cap({ id: 'availability', displayName: 'Availability', description: 'Crew weekly availability.', domain: 'Workforce', status: 'full', kind: 'core', dependencies: ['workforce'], requiredPermissions: ['availability:view'], supportedRoles: ['admin', 'manager', 'crew'] }),
  cap({ id: 'time-off', displayName: 'Time Off', description: 'Time-off requests + approval.', domain: 'Workforce', status: 'full', kind: 'core', dependencies: ['workforce'], requiredPermissions: ['timeoff:view'], supportedRoles: ['admin', 'manager', 'crew'], aiActions: [{ id: 'timeoff.approve', level: 3 }] }),
  cap({ id: 'time-tracking', displayName: 'Time Tracking', description: 'Clock in/out (per assignee).', domain: 'Workforce', status: 'partial', kind: 'core', dependencies: ['routes', 'workforce'], supportedRoles: ['admin', 'manager', 'crew'] }),
  cap({ id: 'gps-verification', displayName: 'GPS Verification', description: 'Location capture at clock events.', domain: 'Compliance', status: 'backend-only', kind: 'optional', dependencies: ['time-tracking'], supportedRoles: ['admin', 'manager', 'crew'] }),
  cap({ id: 'compliance-photos', displayName: 'Compliance Photos', description: 'Uniform + completion evidence.', domain: 'Compliance', status: 'full', kind: 'optional', dependencies: ['workforce'], supportedRoles: ['admin', 'manager', 'crew'] }),

  // ── Equipment / fleet ──
  cap({ id: 'equipment', displayName: 'Equipment', description: 'Equipment inventory.', domain: 'Equipment', status: 'full', kind: 'optional', requiredPermissions: ['equipment:manage'] }),
  cap({ id: 'fleet', displayName: 'Fleet', description: 'Vehicle/asset assignment + maintenance.', domain: 'Equipment', status: 'partial', kind: 'industry-specific', dependencies: ['equipment'], requiredPermissions: ['equipment:assign'], aiActions: [{ id: 'maintenance.flag', level: 1 }] }),

  // ── Comms ──
  cap({ id: 'messaging', displayName: 'Messaging', description: 'Customer + crew messaging.', domain: 'Comms', status: 'full', kind: 'core', requiredPermissions: ['messages:send'], supportedRoles: ['admin', 'manager', 'crew'], aiActions: [{ id: 'message.draft', level: 2 }] }),
  cap({ id: 'notifications', displayName: 'Notifications', description: 'Email/SMS/in-app delivery.', domain: 'Comms', status: 'full', kind: 'core' }),
  cap({ id: 'documents', displayName: 'Documents', description: 'File storage + encrypted identity docs.', domain: 'Documents', status: 'full', kind: 'core' }),

  // ── Money ──
  cap({ id: 'invoicing', displayName: 'Invoicing', description: 'Booking + route invoices.', domain: 'Invoicing', status: 'duplicated', kind: 'core', requiredPermissions: ['invoices:manage'], aiActions: [{ id: 'invoice.draft', level: 3 }] }),
  cap({ id: 'payments', displayName: 'Payments', description: 'Stripe + Zelle + manual.', domain: 'Payments', status: 'full', kind: 'core' }),
  cap({ id: 'contractor-compensation', displayName: 'Contractor Compensation', description: 'Pay resolution + statements.', domain: 'Compensation', status: 'full', kind: 'core', requiredPermissions: ['pay:generate'] }),
  cap({ id: 'expenses', displayName: 'Expenses', description: 'Expense ledger.', domain: 'Compensation', status: 'planned', kind: 'core', enabledForJkiss: false }),
  cap({ id: 'reporting', displayName: 'Reporting', description: 'Operational + financial reports.', domain: 'Analytics', status: 'partial', kind: 'core', requiredPermissions: ['reports:view'], aiActions: [{ id: 'insights.brief', level: 1 }] }),
  cap({ id: 'analytics', displayName: 'Analytics', description: 'Site + operational analytics.', domain: 'Analytics', status: 'partial', kind: 'core' }),

  // ── Automation & AI ──
  cap({ id: 'automations', displayName: 'Automations', description: 'Reminders + workflow automation.', domain: 'Automation', status: 'partial', kind: 'core', requiredPermissions: ['reminders:manage'], aiActions: [{ id: 'reminder.draft', level: 2 }] }),
  cap({ id: 'ai-intelligence', displayName: 'AI Intelligence', description: 'Governed AI service (runAiTask).', domain: 'AI', status: 'full', kind: 'core', requiredPermissions: ['ai:use'], aiActions: [{ id: 'ops.command', level: 0 }, { id: 'ops.insights', level: 1 }] }),
  cap({ id: 'approvals', displayName: 'Approvals', description: 'Human-approved AI actions.', domain: 'Automation', status: 'planned', kind: 'core', dependencies: ['ai-intelligence', 'audit-logs'], requiredFlags: ['APPROVAL_QUEUE_ENABLED'], enabledForJkiss: false }),
  cap({ id: 'audit-logs', displayName: 'Audit Logs', description: 'Attributed audit trail.', domain: 'Governance', status: 'partial', kind: 'core', requiredPermissions: ['audit:view'] }),

  // ── Surfaces ──
  cap({ id: 'customer-portal', displayName: 'Customer Portal', description: 'Booking/track/client portals.', domain: 'Surfaces', status: 'full', kind: 'core', supportedRoles: [] }),
  cap({ id: 'crew-portal', displayName: 'Crew Portal', description: 'Crew self-service portal.', domain: 'Surfaces', status: 'full', kind: 'core', dependencies: ['workforce'], supportedRoles: ['crew'] }),
  cap({ id: 'management-workspace', displayName: 'Management Workspace', description: 'Operations OS for staff.', domain: 'Surfaces', status: 'full', kind: 'core', dependencies: ['routes', 'workforce'] }),
]

export const CAPABILITY_REGISTRY: Record<CapabilityId, Capability> = Object.freeze(
  LIST.reduce((acc, c) => { acc[c.id] = c; return acc }, {} as Record<CapabilityId, Capability>),
)

export function getCapability(id: CapabilityId): Capability {
  const c = CAPABILITY_REGISTRY[id]
  if (!c) throw new Error(`unknown capability: ${id}`)
  return c
}

export function allCapabilities(): Capability[] {
  return Object.values(CAPABILITY_REGISTRY)
}
