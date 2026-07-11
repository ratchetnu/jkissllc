// OpsPilot Role-Based Access Control — the single source of truth for "who may do
// what". Authorization is defined here ONCE as a role→permission matrix; call sites
// ask `can(role, permission)` instead of comparing role strings inline. This is the
// centralized system the platform gates on — no scattered `role === 'admin'` checks.
//
// Enforcement lives server-side: the session guards in
// app/api/admin/_lib/session.ts resolve a principal's role from the signed token
// and consult this matrix. Hiding a button is never the control — the API is.

export type Role = 'admin' | 'manager' | 'crew'

export const ROLES: Role[] = ['admin', 'manager', 'crew']

export function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'manager' || v === 'crew'
}

// The full permission vocabulary. Grouped by area for readability; the string
// values are stable identifiers (persisted nowhere, but referenced across routes),
// so treat them as an API — add, don't rename.
export type Permission =
  // ── Business / operations ──
  | 'businesses:manage'
  | 'routes:manage'
  | 'routes:view'
  | 'recurring:manage'
  | 'equipment:manage'
  | 'equipment:assign'
  // ── Crew directory ──
  | 'crew:manage'          // create/edit/deactivate crew records
  | 'crew:view'            // see the crew directory + operational detail
  | 'crew:assign'          // assign crew to routes
  | 'crew:score:view'      // see the internal Crew Score (admin/manager only)
  // ── Availability & time off (operational) ──
  | 'availability:view'    // see crew availability while scheduling
  | 'timeoff:view'         // see time-off requests
  | 'timeoff:approve'      // approve / deny time off (admin + manager)
  // ── Applicants ──
  | 'applicants:review'
  | 'applicants:decide'    // approve / deny
  // ── AI (LLMOps) ──
  | 'ai:use'               // invoke the centralized AI service (read-only / draft-only)
  | 'ai:analytics'         // read the AI Control Center (usage/cost/quality observability)
  // ── Communications / reminders (Communication Center) ──
  | 'messages:send'        // send a crew message / reply from ops
  | 'reminders:view'       // see the reminder management surface
  | 'reminders:manage'     // create/edit/pause/delete reminders
  | 'dispatch:send'        // fire dispatch quick-blasts (Call Me, Emergency, …)
  | 'comms:analytics'      // read communication analytics
  // ── Users / identity ──
  | 'users:manage'         // invite/manage manager & crew logins
  | 'roles:manage'         // change a user's role (admin only)
  // ── Compensation / pay ──
  | 'pay:configure'        // set rates / pay structures
  | 'pay:generate'         // generate pay statements
  | 'pay:view:all'         // view any crew's compensation
  | 'pay:adjust:submit'    // submit a comp adjustment for review (manager)
  | 'pay:approve'          // approve pay / corrections
  | 'tax:view'             // W-9 / TIN / 1099 readiness (sensitive)
  // ── Money ──
  | 'invoices:manage'
  | 'profitability:view'   // unrestricted profitability
  // ── Claims ──
  | 'claims:manage'
  | 'claims:create'
  | 'claimguard:use'
  // ── Platform ──
  | 'settings:manage'      // global settings / company config
  | 'integrations:manage'
  | 'audit:view'
  | 'accounts:suspend'     // suspend / reactivate accounts
  | 'reports:view'         // operational reports
  // ── Crew self-service (portal) ──
  | 'self:view'            // view own portal data
  | 'self:availability'    // submit own availability (Phase B)
  | 'self:timeoff'         // request own time off (Phase B)
  | 'self:timeclock'       // clock in/out
  | 'self:pay:request'     // request a pay correction
  | 'self:messages'        // read/send own crew messages
  | 'self:reminders'       // see + acknowledge own reminders/tasks
  | 'self:uniform'         // upload own daily uniform photo

// Admin = everything. Defined explicitly (not "all perms") so the matrix stays
// auditable and a new permission is a deliberate grant, never an accidental one.
const ADMIN: Permission[] = [
  'businesses:manage', 'routes:manage', 'routes:view', 'recurring:manage',
  'equipment:manage', 'equipment:assign',
  'crew:manage', 'crew:view', 'crew:assign', 'crew:score:view',
  'availability:view', 'timeoff:view', 'timeoff:approve',
  'applicants:review', 'applicants:decide',
  'ai:use', 'ai:analytics',
  'messages:send', 'reminders:view', 'reminders:manage', 'dispatch:send', 'comms:analytics',
  'users:manage', 'roles:manage',
  'pay:configure', 'pay:generate', 'pay:view:all', 'pay:adjust:submit', 'pay:approve', 'tax:view',
  'invoices:manage', 'profitability:view',
  'claims:manage', 'claims:create', 'claimguard:use',
  'settings:manage', 'integrations:manage', 'audit:view', 'accounts:suspend', 'reports:view',
]

// Manager = operational only. Explicitly excludes: roles:manage, settings:manage,
// integrations:manage, pay:configure, pay:approve, tax:view, profitability:view,
// accounts:suspend — matching the spec's "Managers should NOT" list.
const MANAGER: Permission[] = [
  'businesses:manage', 'routes:manage', 'routes:view', 'recurring:manage',
  'equipment:manage', 'equipment:assign',
  'crew:view', 'crew:assign', 'crew:score:view',
  'availability:view', 'timeoff:view', 'timeoff:approve',   // managers run the schedule + approve time off
  'applicants:review',
  'ai:use', 'ai:analytics',
  'messages:send', 'reminders:view', 'reminders:manage', 'dispatch:send', 'comms:analytics',
  'pay:adjust:submit',       // submit adjustments for admin approval — not configure/approve
  'claims:manage', 'claims:create', 'claimguard:use',
  'reports:view',
]

// Crew = own data only. All crew permissions are self-scoped; the server further
// narrows every crew query to principal.staffId (see the portal APIs).
const CREW: Permission[] = [
  'self:view', 'self:availability', 'self:timeoff', 'self:timeclock', 'self:pay:request',
  'self:messages', 'self:reminders', 'self:uniform',
]

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(ADMIN),
  manager: new Set(MANAGER),
  crew: new Set(CREW),
}

/** The one authorization primitive. Everything else composes this. */
export function can(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false
  return MATRIX[role]?.has(permission) ?? false
}

/** True when the role belongs in the admin/operations surface (not the crew portal). */
export function isStaffRole(role: Role | undefined | null): boolean {
  return role === 'admin' || role === 'manager'
}

export const roleLabel: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manager',
  crew: 'Crew',
}
