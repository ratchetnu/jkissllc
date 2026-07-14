/**
 * OpsPilot — the capability catalog.
 *
 * Single source of truth for how the platform is described anywhere it is shown
 * to the public (/opspilot, /start-your-carrier, /about, homepage). One list, so
 * the story never drifts between pages.
 *
 * RULE: every capability listed here must actually be built and running in
 * production for J KISS today. This list is evidence, not a roadmap — if it ships
 * on this page, an owner-operator can watch it work. Anything aspirational belongs
 * in docs/opspilot-multi-tenant-roadmap.md, not here.
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
  LayoutDashboard,
  Truck,
  Sparkles,
  Scale,
  LifeBuoy,
  UserPlus,
  Receipt,
  Link2,
  type LucideIcon,
} from 'lucide-react';

export type Capability = {
  title: string;
  desc: string;
  Icon: LucideIcon;
};

export const CAPABILITIES: Capability[] = [
  { title: 'Route Assignment',   desc: 'Every job assigned to a named driver, with the address, report time, and scope attached.',      Icon: Route },
  { title: 'Recurring Routes',   desc: 'Standing contracts generate themselves on schedule — nobody rebuilds Monday every Monday.',      Icon: Repeat },
  { title: 'Smart Scheduling',   desc: 'Availability, conflicts, and coverage gaps caught before dispatch, not after.',                   Icon: CalendarClock },
  { title: 'Contractor Confirmations', desc: 'Drivers confirm or decline from their phone. Declines surface for reassignment instantly.', Icon: CheckCircle2 },
  { title: 'Digital Agreements', desc: 'Terms delivered, read, and accepted on the record — no paper chase.',                            Icon: FileSignature },
  { title: 'Equipment & Fleet',  desc: 'Trucks and gear tracked by ownership — company or contractor — and matched to the routes that need them.', Icon: Truck },
  { title: 'Business Management', desc: 'Client profiles, contract rates, rate history, and billing terms in one record.',              Icon: Building2 },
  { title: 'Crew Management',    desc: 'Driver and helper profiles, pay rates, documents, availability, and last-seen activity.',        Icon: Users },
  { title: 'Hiring & Onboarding', desc: 'A careers portal scores applicants, gates the application on required documents, and turns an approved hire into a crew member.', Icon: UserPlus },
  { title: 'Claims Tracking',    desc: 'Damage claims logged against the route, the crew, and the client — with status, evidence, and a full history.', Icon: ShieldAlert },
  { title: 'Crew Cost Recovery', desc: 'When crew are responsible for a claim, deductions schedule against their pay — capped at what they earned that week, and never silently forgiven.', Icon: Scale },
  { title: 'ClaimGuard Assist',  desc: 'Every claim opens with a recommended playbook and one-tap deep links into ClaimGuard’s dispute tools.', Icon: LifeBuoy },
  { title: 'Financial Tracking', desc: 'Revenue in, payouts out, and the profit between — per route, per week, per client.',             Icon: Wallet },
  { title: 'Weekly Payroll',     desc: 'Payouts computed from completed routes, adjusted for deductions, ready to send.',                Icon: Banknote },
  { title: 'Client Invoicing',   desc: 'Completed routes become a client invoice — card or manual — with each route stamped so it can never be billed twice.', Icon: Receipt },
  { title: 'Route Profitability', desc: 'What a route earned against what it cost to run — before you agree to run it again.',           Icon: TrendingUp },
  { title: 'Business Analytics', desc: 'Volume, revenue, and crew performance trends across the operation.',                             Icon: BarChart3 },
  { title: 'Notifications',      desc: 'Text and email at every step, to the crew and the customer, without anyone remembering to send it.', Icon: Bell },
  { title: 'Messaging',          desc: 'Inbound replies land in one inbox, threaded to the job they belong to.',                          Icon: MessageSquare },
  { title: 'Client Portals',     desc: 'Hand a client a private link to their routes, status, and paperwork — no login, no back-and-forth.', Icon: Link2 },
  { title: 'Audit Logs',         desc: 'Who changed what, and when. Every status transition is on the record.',                           Icon: History },
  { title: 'AI Command Palette', desc: 'Type what you need in plain English — “add a route for Acme tomorrow” — and it happens. No menu-diving.', Icon: Sparkles },
  { title: 'Real-Time Operations Dashboard', desc: 'Today, tomorrow, and everything that needs a decision — one adaptive command center.', Icon: LayoutDashboard },
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
