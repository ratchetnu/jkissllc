/**
 * OpsPilot — the capability catalog.
 *
 * Single source of truth for how the platform is described anywhere it is shown
 * to the public (/operion, /start-your-carrier, /about, homepage). One list, so
 * the story never drifts between pages.
 *
 * RULE: every capability listed here must actually be built and running in
 * production for J KISS today. This list is evidence, not a roadmap — if it ships
 * on this page, an owner-operator can watch it work. Anything aspirational belongs
 * in docs/opspilot-multi-tenant-roadmap.md, not here.
 *
 * Cross-check before editing: app/lib/platform/capabilities/registry.ts is the
 * internal status of record. Only `status: 'full'` capabilities may appear here —
 * `partial` and `planned` ones (customers, expenses, approvals, organizations)
 * must not. A card that overstates its status is a defect, not marketing.
 *
 * ORDER IS THE POSITIONING. Operion runs a crew-based trucking / delivery
 * operation end to end — dispatch, workforce, time, equipment, money. Photo-based
 * instant quoting is ONE intake path (it happens to be the one J KISS's junk and
 * cleanout work uses), so it sits inside the intake group rather than leading the
 * list. Do not reorder so the AI quoting cards come first.
 */

import {
  Route,
  Repeat,
  Building2,
  Users,
  CheckCircle2,
  FileSignature,
  ShieldAlert,
  Wallet,
  Banknote,
  TrendingUp,
  BarChart3,
  Bell,
  MessageSquare,
  History,
  CalendarClock,
  CalendarDays,
  CalendarOff,
  LayoutDashboard,
  Truck,
  Wrench,
  Sparkles,
  Scale,
  LifeBuoy,
  UserPlus,
  Receipt,
  CreditCard,
  Link2,
  Clock,
  MapPin,
  Camera,
  Gauge,
  FolderLock,
  KeyRound,
  FileCheck2,
  FileBarChart,
  ScanSearch,
  Calculator,
  Inbox,
  type LucideIcon,
} from 'lucide-react';

export type Capability = {
  title: string;
  desc: string;
  Icon: LucideIcon;
};

export const CAPABILITIES: Capability[] = [
  // ── Dispatch & scheduling — the operational spine ──
  { title: 'Route Assignment',   desc: 'Every job assigned to a named driver, with the address, report time, and scope attached.',      Icon: Route },
  { title: 'Recurring Routes',   desc: 'Standing contracts generate themselves on schedule — nobody rebuilds Monday every Monday.',      Icon: Repeat },
  { title: 'One Unified Schedule', desc: 'Contract routes and one-off customer jobs land on a single schedule — every source of work in one place.', Icon: CalendarDays },
  { title: 'Smart Scheduling',   desc: 'Availability, conflicts, and coverage gaps caught before dispatch, not after.',                   Icon: CalendarClock },
  { title: 'Contractor Confirmations', desc: 'Drivers confirm or decline from their phone. Declines surface for reassignment instantly.', Icon: CheckCircle2 },

  // ── Workforce, time & compliance ──
  { title: 'Crew Management',    desc: 'Driver, helper, contractor, and employee profiles — pay rates with history, documents, availability, and last-seen activity.', Icon: Users },
  { title: 'Time & Attendance',  desc: 'Crew clock in and out from the field. Timesheets roll up by person and period, and a correction never erases the original punch.', Icon: Clock },
  { title: 'GPS Clock Verification', desc: 'Clock-ins are checked against the job’s own coordinates, so “on site” is evidence rather than a claim.', Icon: MapPin },
  { title: 'Availability & Time Off', desc: 'Crew submit weekly availability and request time off. Approvals feed scheduling, and late requests are flagged.', Icon: CalendarOff },
  { title: 'Daily Readiness Checks', desc: 'A uniform photo before the route starts, reviewed and approved — or bounced back for a resubmit.', Icon: Camera },
  { title: 'Crew Reliability Scores', desc: 'Confirm, decline, no-show, and completion history weighted into one internal dispatch signal. Management-only.', Icon: Gauge },
  { title: 'Hiring & Onboarding', desc: 'A careers portal scores applicants, gates the application on required documents, and turns an approved hire into a crew member.', Icon: UserPlus },
  { title: 'Crew Document Vault', desc: 'Agreements, policies, training, and tax documents in one place. Personal and tax records are encrypted at rest.', Icon: FolderLock },
  { title: 'Digital Agreements', desc: 'Terms delivered, read, and accepted on the record — with the exact version each person agreed to stored alongside the job.', Icon: FileSignature },
  { title: 'Roles & Permissions', desc: 'Owner, manager, and crew access enforced on the server — with a readable map of who can do what.', Icon: KeyRound },

  // ── Equipment & fleet ──
  { title: 'Equipment Inventory', desc: 'Trucks and gear tracked by ownership — company or contractor — and matched to the routes that need them.', Icon: Truck },
  { title: 'Fleet Maintenance',  desc: 'Service and inspection intervals per vehicle. Anything out of service is benched and can’t be dispatched.', Icon: Wrench },

  // ── Customer intake & sales ──
  { title: 'Online Booking & Intake', desc: 'Customers book online with service, address, date, and photos — arriving as a structured job, not a text.', Icon: Inbox },
  { title: 'Photo-Assisted Estimating', desc: 'AI reads uploaded job photos for visible items and truck fill. Advisory only — low-confidence reads route to a person.', Icon: ScanSearch },
  { title: 'Your Own Pricing Engine', desc: 'Estimates are computed from your rules — labor, disposal trips, margin, minimums — deterministically, never by the model.', Icon: Calculator },
  { title: 'Business Management', desc: 'Client profiles, contract rates, rate history, billing terms, and contract start and end dates in one record.', Icon: Building2 },

  // ── Money in, money out ──
  { title: 'Client Invoicing',   desc: 'Completed routes become a client invoice — card or manual — with each route stamped so it can never be billed twice.', Icon: Receipt },
  { title: 'Deposits & Payments', desc: 'Card, transfer, or manual — recorded against the job, with payment proof encrypted at rest.', Icon: CreditCard },
  { title: 'Pay Statements',     desc: 'Payouts computed from completed routes, adjusted for deductions, and issued as an immutable statement with YTD earnings.', Icon: Banknote },
  { title: '1099 Readiness',     desc: 'Who crosses the reporting threshold, whose W-9 is on file, and what’s still missing — assessed, never filed for you.', Icon: FileCheck2 },
  { title: 'Financial Tracking', desc: 'Revenue in, payouts out, and the profit between — per route, per week, per client.',             Icon: Wallet },
  { title: 'Route Profitability', desc: 'What a route earned against what it cost to run — before you agree to run it again.',           Icon: TrendingUp },

  // ── Claims & accountability ──
  { title: 'Claims Tracking',    desc: 'Damage claims logged against the route, the crew, and the client — with status, evidence, and a full history.', Icon: ShieldAlert },
  { title: 'Crew Cost Recovery', desc: 'When crew are responsible for a claim, deductions schedule against their pay — capped at what they earned that week, and never silently forgiven.', Icon: Scale },
  { title: 'ClaimGuard Assist',  desc: 'Every claim opens with a recommended playbook and one-tap deep links into ClaimGuard’s dispute tools.', Icon: LifeBuoy },

  // ── Communication ──
  { title: 'Notifications',      desc: 'Text and email at every step, to the crew and the customer, without anyone remembering to send it.', Icon: Bell },
  { title: 'Messaging',          desc: 'Inbound replies land in one inbox, threaded to the job they belong to.',                          Icon: MessageSquare },
  { title: 'Client Portals',     desc: 'Hand a client a private link to their routes, status, and paperwork — no login, no back-and-forth.', Icon: Link2 },

  // ── Visibility & governance ──
  // NOT "real-time": the operations surface loads on mount and has no polling,
  // socket, or revalidation anywhere (checked across app/admin/operations). It is
  // current as of the moment you open it, which is what this wording claims.
  { title: 'Operations Dashboard', desc: 'Today, tomorrow, and everything that needs a decision — one adaptive command center.', Icon: LayoutDashboard },
  { title: 'Business Analytics', desc: 'Volume, revenue, and crew performance trends across the operation.',                             Icon: BarChart3 },
  { title: 'Reports & Exports',  desc: 'Revenue and claims-recovery reports on screen, and the same rows out as CSV.',                    Icon: FileBarChart },
  { title: 'Audit Logs',         desc: 'Who changed what, and when — including the attempts that were denied.',                           Icon: History },
  { title: 'AI Command Bar',     desc: 'Ask in plain English — “unconfirmed routes tomorrow” — and it takes you there or answers from your live data.', Icon: Sparkles },
];

/** The one-line positioning statement. Used verbatim in the footer and login. */
export const OPSPILOT_TAGLINE = 'AI Operating System for Business.';

/**
 * Pick a subset by title, preserving the order requested. Throws on a typo rather
 * than silently rendering a short grid — a missing card is easy to miss in review.
 */
export function pickCapabilities(titles: string[]): Capability[] {
  return titles.map(t => {
    const found = CAPABILITIES.find(c => c.title === t);
    if (!found) throw new Error(`[opspilot] unknown capability: "${t}"`);
    return found;
  });
}

/** The six shown on the homepage — enough to intrigue, not enough to distract. */
export const HOMEPAGE_CAPABILITIES = [
  'Route Assignment',
  'Smart Scheduling',
  'Contractor Confirmations',
  'Claims Tracking',
  'Financial Tracking',
  'Notifications',
];
