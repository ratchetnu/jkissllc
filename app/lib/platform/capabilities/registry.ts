// ── Platform capability registry ─────────────────────────────────────────────
//
// The typed source of truth for every platform capability. Status values reflect
// docs/opspilot-os/03-capability-matrix.md as verified against the repo. This is
// configuration — importing it changes no runtime behavior (guarded further by the
// CAPABILITY_REGISTRY_ENABLED flag at the query layer).
//
// ── What `status` means ──────────────────────────────────────────────────────
//
//   full        Production-capable and usable today: implementation, API, UI,
//               permissions and tests all exist and are deployed. Only `full`
//               capabilities may be described as available in public copy
//               (see the marketing rule in lib/opspilot.ts).
//   partial     Implemented but limited — a lane, a surface, or a lifecycle stage
//               is missing. Public copy must be worded so it cannot be read as
//               claiming the missing part.
//   planned     Not production-ready. Never marketable. Usually paired with
//               defaultSelection: 'disabled' and/or a requiredFlag.
//   backend-only  Logic exists with no user-facing surface yet.
//   duplicated  Two implementations of one concept, pending consolidation.
//
// `defaultSelection` answers a DIFFERENT question from `status`: what a tenant that
// has expressed no preference gets. A capability can be `full` and default-off, or
// default-on and `partial`. Don't read one as the other. It is only a DEFAULT — the
// authority is the tenant's own capability profile (capabilities/tenant-profile.ts),
// which this field seeds and an explicit owner choice overrides.
//
// It replaces the former per-tenant-zero boolean, which was scaffolding: it answered
// the question for exactly one tenant and returned "disabled" for every other tenant,
// so a second business could not be configured at all.
//
// ── `dependencies` vs `softDependencies` ─────────────────────────────────────
//
// `dependencies` are HARD prerequisites: the profile validator refuses to enable a
// capability while one of them is disabled. `softDependencies` enhance and never
// require. Getting this wrong is not cosmetic — invoicing used to declare `payments`
// a hard dependency, which said, in the only machine-readable place that answers the
// question, that a business cannot bill anyone without a card processor.
//
// ── ABSENCE IS NOT EVIDENCE OF ABSENCE ───────────────────────────────────────
//
// A capability missing from this file means only that nobody entered it. It does
// NOT mean the product lacks it. That failure mode was real: the 2026-08-07 audit
// (OPERION_SYSTEM_STATUS.md) found four shipped, production-deployed, publicly
// marketed capabilities absent here — claims, businesses, crew-reliability and
// hiring — including a nine-module claims domain with its own admin surface and
// five test files.
//
// This matters because the marketing rule in lib/opspilot.ts says to cross-check
// this registry before publishing a capability. That check silently passes for
// anything the registry does not contain, so an omission quietly disables the
// guardrail rather than tripping it.
//
// So: when adding a capability here, record WHERE it lives (modules, API, UI) in
// a comment, as the entries below do. And when auditing, verify against the
// running system — routes, APIs, tests, permissions — never against this list
// alone. This registry is a claim about the system, not the system.

import type { Capability, CapabilityId } from './types'

// Small builder so each entry states only what differs from the common defaults.
type CapInput = Pick<Capability, 'id' | 'displayName' | 'description' | 'domain' | 'status' | 'kind'> &
  Partial<Capability>

function cap(c: CapInput): Capability {
  return {
    dependencies: [],
    softDependencies: [],
    requiredPermissions: [],
    requiredFlags: [],
    supportedRoles: ['admin', 'manager'],
    aiActions: [],
    defaultSelection: 'enabled',
    tenantConfigurable: true,
    tiers: ['free', 'starter', 'pro'],
    ...c,
  }
}

const LIST: Capability[] = [
  // ── Identity & tenancy ──
  cap({ tenantConfigurable: false, mandatoryReason: 'Signing in is how anyone reaches anything. Without it there is no admin, no crew portal and no way to grant or check access.', id: 'identity', displayName: 'Identity', description: 'Authentication and user identity.', domain: 'Identity & Tenancy', status: 'full', kind: 'core', supportedRoles: ['admin', 'manager', 'crew'] }),
  cap({ id: 'organizations', displayName: 'Organizations', description: 'Tenant/organization records.', domain: 'Identity & Tenancy', status: 'planned', kind: 'core', dependencies: ['identity'], requiredFlags: ['TENANCY_ENABLED'], defaultSelection: 'disabled' }),
  cap({ id: 'memberships', displayName: 'Memberships', description: 'User↔tenant↔role association.', domain: 'Identity & Tenancy', status: 'planned', kind: 'core', dependencies: ['identity', 'organizations', 'roles'], requiredFlags: ['TENANCY_ENABLED'], defaultSelection: 'disabled' }),
  cap({ tenantConfigurable: false, mandatoryReason: 'Roles are how the platform decides who may do what. Removing them would not open the system up, it would leave every check without an answer.', id: 'roles', displayName: 'Roles', description: 'Role definitions (admin/manager/crew).', domain: 'Identity & Tenancy', status: 'full', kind: 'core', dependencies: ['identity'] }),
  // Wave D/E: enforcement was already full (the can() chokepoint); this adds the read-only
  // matrix VIEWER (/admin/operations/permissions, permissions:view) sourced from the SAME
  // rbac primitive so it can't drift, and role-assignment activity is now audited. The
  // matrix stays static/in-code — deliberately NOT tenant-configurable.
  cap({ tenantConfigurable: false, mandatoryReason: 'The permission matrix is the same check every route runs. It is defined in code, deliberately, so it cannot be edited into a state that grants more than intended.', id: 'permissions', displayName: 'Permissions', description: 'RBAC permission matrix + read-only viewer.', domain: 'Identity & Tenancy', status: 'full', kind: 'core', dependencies: ['roles', 'audit-logs'], requiredPermissions: ['roles:manage', 'permissions:view'] }),

  // ── CRM ──
  cap({ id: 'customers', displayName: 'Customers', description: 'First-class customer records.', domain: 'CRM', status: 'planned', kind: 'core', dependencies: ['identity'], defaultSelection: 'disabled' }),
  // NOT the same thing as `customers` (which is planned): `businesses` is the B2B
  // CLIENT ACCOUNT — contract rates, rate history, billing terms, contract start/end.
  // It has shipped since before this registry existed and was simply never entered.
  // lib/businesses.ts · /api/admin/businesses · /admin/operations/businesses + business/[key].
  cap({ id: 'businesses', displayName: 'Client Accounts', description: 'B2B client records: contract rates, rate history, billing terms, contract dates.', domain: 'CRM', status: 'full', kind: 'core', requiredPermissions: ['businesses:manage'] }),
  cap({ id: 'leads', displayName: 'Leads', description: 'Lead intake and pipeline.', domain: 'CRM', status: 'partial', kind: 'core', dependencies: ['identity', 'bookings'] }),

  // ── Sales & pricing ──
  // Paid, external vision calls — deliberately distinct from `ai-intelligence`,
  // which is the governed runAiTask chokepoint. A tenant can want the governance and
  // decline the spend.
  cap({
    id: 'photo-estimation', displayName: 'Photo estimates', description: 'Read customer photos to produce an instant estimate.',
    domain: 'AI', status: 'full', kind: 'optional', provider: 'ai', dependencies: ['bookings', 'pricing', 'ai-intelligence'], defaultSelection: 'disabled',
    disabledConsequence: 'Photos are still collected and stored, but no automatic estimate is produced and no AI charges are incurred. Quotes are priced by a person instead.',
  }),
  cap({ id: 'quotes', displayName: 'Quotes', description: 'Estimates and quote lifecycle.', domain: 'Sales', status: 'partial', kind: 'core', dependencies: ['pricing', 'bookings', 'ai-intelligence'], aiActions: [{ id: 'quote.draft', level: 2 }] }),
  cap({ id: 'pricing', displayName: 'Pricing', description: 'Dynamic pricing + calibration.', domain: 'Pricing', status: 'full', kind: 'core', aiActions: [{ id: 'price.estimate', level: 0 }] }),

  // ── Jobs & scheduling ──
  // The booking RECORD. Core and not switchable: scheduling, invoicing, dispatch,
  // time tracking and pay all resolve through it, so a profile that turned it off
  // would not be a product configuration, it would be a broken deployment.
  cap({
    tenantConfigurable: false, id: 'bookings', displayName: 'Bookings', description: 'The booking record itself.',
    domain: 'Sales/Booking', status: 'full', kind: 'core', dependencies: ['pricing'],
    mandatoryReason: 'Scheduling, invoicing, dispatch, time tracking and pay are all built on the booking record. It cannot be switched off; the public booking form can (see “Online booking”).',
  }),
  // …and the public self-service intake that CREATES one. Separate on purpose: a
  // business that only takes contract/dispatch work can decline the retail form
  // without losing the record model everything else depends on.
  cap({
    id: 'booking-intake', displayName: 'Online booking', description: 'The public Book Now form customers use to book themselves.',
    domain: 'Sales/Booking', status: 'full', kind: 'optional', dependencies: ['bookings', 'pricing'], defaultSelection: 'enabled',
    disabledConsequence: 'Customers cannot book themselves online. Staff can still create bookings in the admin, and every existing booking is untouched.',
  }),
  cap({ id: 'jobs', displayName: 'Jobs', description: 'Unified job concept (target).', domain: 'Jobs', status: 'partial', kind: 'core', dependencies: ['bookings', 'routes', 'workforce', 'equipment'] }),
  cap({ id: 'routes', displayName: 'Routes', description: 'Contractor dispatch operations.', domain: 'Dispatch/Routes', status: 'full', kind: 'core', requiredPermissions: ['routes:manage'] }),
  cap({ id: 'scheduling', displayName: 'Scheduling', description: 'Capacity, blackout, availability calendar.', domain: 'Scheduling', status: 'full', kind: 'core', dependencies: ['bookings'] }),

  // ── Workforce ──
  cap({ id: 'workforce', displayName: 'Workforce', description: 'Crew / contractor roster.', domain: 'Workforce', status: 'full', kind: 'core', requiredPermissions: ['crew:manage'], supportedRoles: ['admin', 'manager', 'crew'] }),
  cap({ id: 'availability', displayName: 'Availability', description: 'Crew weekly availability.', domain: 'Workforce', status: 'full', kind: 'core', dependencies: ['workforce'], requiredPermissions: ['availability:view'], supportedRoles: ['admin', 'manager', 'crew'] }),
  cap({ id: 'time-off', displayName: 'Time Off', description: 'Time-off requests + approval.', domain: 'Workforce', status: 'full', kind: 'core', dependencies: ['workforce'], requiredPermissions: ['timeoff:view'], supportedRoles: ['admin', 'manager', 'crew'], aiActions: [{ id: 'timeoff.approve', level: 3 }] }),
  // Wave C: both lanes clock in/out through the shared applyPunch (route lock + booking
  // lock) and roll up into a time:view admin timesheet. Route lane is fully live; the
  // booking lane's PRODUCTION availability stays controlled by BOOKING_ASSIGNMENT_ENABLED
  // (off ⇒ routes-only, byte-identical), so no requiredFlags is asserted on the capability.
  cap({ id: 'time-tracking', displayName: 'Time Tracking', description: 'Clock in/out + admin timesheets (route + booking lanes).', domain: 'Workforce', status: 'full', kind: 'core', dependencies: ['routes', 'workforce', 'bookings'], requiredPermissions: ['time:view'], supportedRoles: ['admin', 'manager', 'crew'] }),
  // Wave I: capture + admin review still ship; adds a deterministic geofence engine that
  // verifies clock-ins against a route's stored destination coords (additive reportLat/Lng;
  // NO geocoding — missing coords → 'expected_unavailable', never a false positive), an
  // explicit accuracy policy, a tenant-safe compliance API/UI (routes:view), and a shared
  // ClockStrip badge. GPS is operational evidence, not proof of misconduct or a payroll input.
  cap({ disabledConsequence: 'Clock-ins are still recorded, but they are no longer checked against the job’s location, so there is no on-site evidence to review.', id: 'gps-verification', displayName: 'GPS Verification', description: 'On-site geofence verification of clock events.', domain: 'Compliance', status: 'full', kind: 'optional', dependencies: ['time-tracking', 'routes'], requiredPermissions: ['routes:view'], supportedRoles: ['admin', 'manager', 'crew'] }),
  cap({ disabledConsequence: 'Crew are no longer asked for uniform or completion photos, and those checks disappear from the review screens. Photos already collected are kept.', id: 'compliance-photos', displayName: 'Compliance Photos', description: 'Uniform + completion evidence.', domain: 'Compliance', status: 'full', kind: 'optional', dependencies: ['workforce'], supportedRoles: ['admin', 'manager', 'crew'] }),
  // Deterministic score built from confirm / decline / no-show / completion history —
  // an internal DISPATCH SIGNAL, never shown to the crew member it describes, which is
  // why supportedRoles omits 'crew' even though workforce includes it.
  // lib/crew-score.ts (pure: buildCrewScore) · surfaced on /admin/operations/employees.
  cap({ disabledConsequence: 'The internal dispatch score is no longer calculated or shown, so assignment decisions rely on judgement alone. Confirm, decline and no-show history is still recorded.', id: 'crew-reliability', displayName: 'Crew Reliability', description: 'Internal dispatch score from confirm/decline/no-show/completion history.', domain: 'Workforce', status: 'full', kind: 'optional', dependencies: ['workforce', 'routes'], requiredPermissions: ['crew:view'] }),
  // Careers portal → scored application → gated on required documents → approved hire
  // becomes a crew member. lib/applicants.ts + ats-scoring.ts + ats-config.ts ·
  // /careers (public) + /api/careers · admin review under applicants:review/:decide.
  cap({
    id: 'hiring', displayName: 'Careers and onboarding', description: 'Public careers page, applicant scoring, and document-gated onboarding into the crew roster.',
    domain: 'Workforce', status: 'full', kind: 'optional', defaultSelection: 'enabled',
    dependencies: ['workforce', 'documents'], requiredPermissions: ['applicants:review', 'applicants:decide'],
    disabledConsequence: 'The public careers page stops accepting applications. Applicants already in the pipeline are kept and can still be reviewed and hired.',
  }),

  // ── Equipment / fleet ──
  cap({ disabledConsequence: 'Equipment is no longer tracked or assigned to jobs, and conflict checks stop. Existing equipment records are kept.', id: 'equipment', displayName: 'Equipment', description: 'Equipment inventory.', domain: 'Equipment', status: 'full', kind: 'optional', requiredPermissions: ['equipment:manage'] }),
  // Wave H: additive maintenance model on Equipment + deterministic status engine +
  // authorized maintenance API/UI + route equipmentId assignment (out-of-service refused)
  // + a REAL narrow maintenance.flag executor (internal flags only, idempotent, tenant-
  // scoped, no external send — deliberately NOT a general workflow engine, so `automations`
  // stays partial).
  cap({ disabledConsequence: 'Vehicles are no longer assigned to routes and maintenance status stops being tracked. Existing vehicle and maintenance records are kept.', id: 'fleet', displayName: 'Fleet', description: 'Vehicle/asset assignment + maintenance.', domain: 'Equipment', status: 'full', kind: 'industry-specific', dependencies: ['equipment', 'routes'], requiredPermissions: ['equipment:assign', 'equipment:view', 'fleet:maintenance'], aiActions: [{ id: 'maintenance.flag', level: 1 }] }),

  // ── Comms ──
  //
  // The RECORD is core; the external DELIVERY CHANNEL is an optional adapter. A
  // message thread, a communications log entry, a crew assignment note and an
  // admin/portal conversation all exist, are stored, are readable and are auditable
  // with neither Twilio nor Resend configured. Only the leg that leaves the building
  // is optional — which is why `sms-delivery` and `email-delivery` are
  // softDependencies here rather than dependencies.
  cap({ id: 'messaging', displayName: 'Messaging', description: 'Customer + crew messaging records and threads (in-app; external delivery is optional).', domain: 'Comms', status: 'full', kind: 'core', softDependencies: ['sms-delivery', 'email-delivery'], requiredPermissions: ['messages:send'], supportedRoles: ['admin', 'manager', 'crew'], aiActions: [{ id: 'message.draft', level: 2 }] }),
  cap({ id: 'notifications', displayName: 'Notifications', description: 'Notification records + in-app delivery (external channels are optional adapters).', domain: 'Comms', status: 'full', kind: 'core', softDependencies: ['sms-delivery', 'email-delivery'] }),

  // ── Optional external provider adapters ──
  //
  // Every one defaults to DISABLED. A tenant that has expressed no preference must
  // never find itself spending money, texting customers or emailing them because a
  // variable happened to be present in the environment — the presence of a key is
  // evidence that somebody once configured something, not that this business wants
  // the feature on.
  //
  // Existing tenants keep their behavior through the explicit, idempotent backfill in
  // capabilities/capability-backfill.ts, which records today's effective state as a
  // real choice. Until that runs for a tenant, an uninitialized profile falls back to
  // legacy compatibility and says so.
  cap({
    id: 'sms-delivery', displayName: 'Text messages', description: 'Send and receive customer and crew text messages (Twilio).',
    domain: 'Comms', status: 'full', kind: 'optional', provider: 'twilio', dependencies: ['messaging'], defaultSelection: 'disabled',
    disabledConsequence: 'No text messages are sent or received. Reminders, confirmations and crew notices still exist as records, and links are handed over from the admin or the portal instead.',
    requiredPermissions: ['messages:send'], supportedRoles: ['admin', 'manager', 'crew'],
  }),
  cap({
    id: 'email-delivery', displayName: 'Email', description: 'Send transactional email (Resend).',
    domain: 'Comms', status: 'full', kind: 'optional', provider: 'resend', dependencies: ['notifications'], defaultSelection: 'disabled',
    disabledConsequence: 'No email is sent. Receipts, confirmations and reminders still exist as records; secure links are delivered by hand from the admin.',
  }),
  cap({ id: 'documents', displayName: 'Documents', description: 'File storage + encrypted identity docs.', domain: 'Documents', status: 'full', kind: 'core' }),

  // ── Money ──
  // Two legitimate lanes, consolidated (Wave B) onto shared plumbing (lib/invoicing/*)
  // + one InvoiceLike contract WITHOUT merging their entities/keyspaces/counters. Authz
  // is split by lane and both are enforced: the B2B route-invoice surface requires
  // invoices:manage (admin-only); the B2C booking-invoice surface is governed as part of
  // `bookings` via requireStaffSession (admin+manager). requiredPermissions names the
  // invoice-native permission. Stripe recording is unified + idempotent, so a paid route
  // invoice can no longer stay unmarked (webhook backstop).
  //
  // `payments` moved from dependencies to softDependencies. An invoice is a RECORD:
  // it is numbered, rendered, sent, viewed at /invoice/{token} and marked paid by an
  // admin recording an offline payment, with no processor involved at all. Declaring
  // the money lane a hard prerequisite of billing said the opposite in the one
  // machine-readable place that answers the question.
  cap({ id: 'invoicing', displayName: 'Invoicing', description: 'Booking + route invoices (card collection optional).', domain: 'Invoicing', status: 'full', kind: 'core', dependencies: ['bookings', 'routes'], softDependencies: ['payments', 'payments-stripe'], requiredPermissions: ['invoices:manage'], aiActions: [{ id: 'invoice.draft', level: 3 }] }),
  // The payment LEDGER — recording that money arrived, by any method. Cash, check,
  // Zelle and "paid on site" need no provider, so this is core and always on. Only
  // the card-collection leg is optional (`payments-stripe`).
  cap({ id: 'payments', displayName: 'Payments', description: 'Payment ledger: manual, offline, Zelle, cash, check (card collection is a separate adapter).', domain: 'Payments', status: 'full', kind: 'core', softDependencies: ['payments-stripe'] }),
  cap({
    id: 'payments-stripe', displayName: 'Card payments', description: 'Take card payments online (Stripe Checkout) and confirm them automatically.',
    domain: 'Payments', status: 'full', kind: 'optional', provider: 'stripe', dependencies: ['payments'], defaultSelection: 'disabled',
    disabledConsequence: 'Customers cannot pay by card online. Invoices and balances are unchanged, and cash, check, Zelle and other offline payments are still recorded normally.',
  }),
  // Optional: a business that pays its crew through an outside payroll service does
  // not need pay resolution or statements here, and should not be told it does.
  cap({
    id: 'contractor-compensation', displayName: 'Contractor pay', description: 'Work out what each contractor is owed and issue pay statements.',
    domain: 'Compensation', status: 'full', kind: 'optional', defaultSelection: 'enabled', requiredPermissions: ['pay:generate'],
    disabledConsequence: 'No pay is calculated and no new pay statements are issued. Statements already issued stay exactly as they are and remain viewable.',
  }),
  // Damage claims against the route / crew / client, with evidence, status history, and
  // crew cost recovery that schedules capped deductions into pay. Nine modules
  // (lib/claims.ts + claim-{accrual,assist,documents,mutex,notify,payroll,types}.ts,
  // claims-report.ts) · /api/admin/claims · /admin/operations/claims + claims/[id].
  // The ClaimGuard playbook (claim-assist.ts) is DETERMINISTIC — no aiActions.
  // The financial report is read via reports:view; claims:manage governs mutation.
  cap({
    id: 'claims', displayName: 'Damage claims', description: 'Damage claims with evidence, status history, and capped crew cost recovery into pay.',
    domain: 'Claims', status: 'full', kind: 'optional', defaultSelection: 'enabled',
    dependencies: ['routes', 'businesses', 'contractor-compensation', 'documents'], requiredPermissions: ['claims:create', 'claims:manage'],
    disabledConsequence: 'No new claims can be opened and no new deductions are scheduled. Existing claims, their evidence and any deductions already posted are kept and stay viewable.',
  }),
  cap({ id: 'expenses', displayName: 'Expenses', description: 'Expense ledger.', domain: 'Compensation', status: 'planned', kind: 'core', defaultSelection: 'disabled' }),
  // Wave G: dedicated /admin/operations/reports surface over the two live engines
  // (revenue + claims) with CSV export, plus the authz reconciliation — the claims
  // financial report is now READ via reports:view (claims:manage stays for claims
  // management, unchanged). No company P&L: net profit needs `expenses` (planned), so
  // only revenue + claims-recovery reports exist, labeled as such.
  // `payments` is a soft dependency: the revenue report reads BOOKING and INVOICE
  // records, so it renders with an empty card-payment column rather than refusing to
  // load. Reporting must never require a processor to open.
  cap({ id: 'reporting', displayName: 'Reporting', description: 'Revenue + claims reports (read-only, CSV export).', domain: 'Analytics', status: 'full', kind: 'core', dependencies: ['bookings', 'ai-intelligence'], softDependencies: ['payments', 'payments-stripe'], requiredPermissions: ['reports:view'], aiActions: [{ id: 'insights.brief', level: 1 }] }),
  // Wave F: the one un-wrapped analytics route (ai/analytics) is now tenant-wrapped;
  // comms analytics has a UI; the previously WRITE-ONLY quote funnel is surfaced (reader
  // + UI). Spans several guards — reports:view (site + funnel), ai:analytics (AI Control
  // Center), comms:analytics — listed here to match the real route permissions.
  cap({ id: 'analytics', displayName: 'Analytics', description: 'Site + operational analytics + quote funnel.', domain: 'Analytics', status: 'full', kind: 'core', dependencies: ['ai-intelligence', 'messaging'], requiredPermissions: ['reports:view', 'ai:analytics', 'comms:analytics'] }),

  // ── Automation & AI ──
  cap({ id: 'automations', displayName: 'Automations', description: 'Reminders + workflow automation.', domain: 'Automation', status: 'partial', kind: 'core', dependencies: ['workforce', 'routes', 'notifications', 'messaging'], requiredPermissions: ['reminders:manage'], aiActions: [{ id: 'reminder.draft', level: 2 }] }),
  cap({ id: 'ai-intelligence', displayName: 'AI Intelligence', description: 'Governed AI service (runAiTask).', domain: 'AI', status: 'full', kind: 'core', requiredPermissions: ['ai:use'], aiActions: [{ id: 'ops.command', level: 0 }, { id: 'ops.insights', level: 1 }] }),
  cap({ id: 'approvals', displayName: 'Approvals', description: 'Human-approved AI actions.', domain: 'Automation', status: 'planned', kind: 'core', dependencies: ['ai-intelligence', 'audit-logs'], requiredFlags: ['APPROVAL_QUEUE_ENABLED'], defaultSelection: 'disabled' }),
  // Wave D/E: tenant-stamped, attributed trail (actor/role/action/target/outcome/
  // correlation) now covers administrative identity/security events (user create/update/
  // role-change/suspend/reactivate/delete) — successes AND denied attempts — not just
  // comms; read-only viewer at /admin/operations/audit (audit:view). Legacy records
  // (no tenantId/outcome) remain readable.
  cap({ tenantConfigurable: false, mandatoryReason: 'The audit trail is how a change is attributed after the fact. A business that could switch it off could also switch it off first.', id: 'audit-logs', displayName: 'Audit Logs', description: 'Attributed, tenant-scoped audit trail + viewer.', domain: 'Governance', status: 'full', kind: 'core', dependencies: ['identity'], requiredPermissions: ['audit:view'] }),

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
