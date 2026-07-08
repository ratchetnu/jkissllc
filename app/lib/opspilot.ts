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
  { title: 'Business Management', desc: 'Client profiles, contract rates, rate history, and billing terms in one record.',              Icon: Building2 },
  { title: 'Crew Management',    desc: 'Driver and helper profiles, pay rates, documents, and availability.',                            Icon: Users },
  { title: 'Contractor Confirmations', desc: 'Drivers confirm or decline from their phone. Declines surface for reassignment instantly.', Icon: CheckCircle2 },
  { title: 'Digital Agreements', desc: 'Terms delivered, read, and accepted on the record — no paper chase.',                            Icon: FileSignature },
  { title: 'Claims Tracking',    desc: 'Damage claims logged against the route and the crew, with accrual and deduction handling.',      Icon: ShieldAlert },
  { title: 'Financial Tracking', desc: 'Revenue in, payouts out, and the profit between — per route, per week, per client.',             Icon: Wallet },
  { title: 'Weekly Payroll',     desc: 'Payouts computed from completed routes, adjusted for deductions, ready to send.',                Icon: Banknote },
  { title: 'Route Profitability', desc: 'What a route earned against what it cost to run — before you agree to run it again.',           Icon: TrendingUp },
  { title: 'Business Analytics', desc: 'Volume, revenue, and crew performance trends across the operation.',                             Icon: BarChart3 },
  { title: 'Notifications',      desc: 'Text and email at every step, to the crew and the customer, without anyone remembering to send it.', Icon: Bell },
  { title: 'Messaging',          desc: 'Inbound replies land in one inbox, threaded to the job they belong to.',                          Icon: MessageSquare },
  { title: 'Audit Logs',         desc: 'Who changed what, and when. Every status transition is on the record.',                           Icon: History },
  { title: 'Smart Scheduling',   desc: 'Availability, conflicts, and coverage gaps caught before dispatch, not after.',                   Icon: CalendarClock },
  { title: 'Real-Time Operations Dashboard', desc: 'Today, tomorrow, and everything that needs a decision — on one screen.',              Icon: LayoutDashboard },
];

/** The one-line positioning statement. Used verbatim in the footer and login. */
export const OPSPILOT_TAGLINE = 'The operating system behind J KISS Freight.';

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
