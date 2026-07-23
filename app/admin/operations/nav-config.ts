// ── Operion operations navigation model (config-driven, role-aware, PURE) ────
// ONE source of truth for the admin/manager operations nav. Apple-style hierarchy:
//   • Desktop top bar — a small set of PRIMARY destinations in the centre, everything
//     else in a grouped "More" mega-menu; Book Now surfaces as the notification indicator.
//   • Mobile bottom bar — four primary destinations + a raised centre "Book Now" action +
//     a "More" sheet holding every remaining authorized destination.
// Every destination stays reachable — nothing is removed. No React/icons here (icons are
// mapped by href in the shell) so the model is unit-testable. Permission rules
// (`adminOnly`/`ownerOnly`) are unchanged and are ALSO enforced server-side on each route.

export type NavGroup = 'team' | 'comms' | 'business' | 'finance' | 'release' | 'platform'

export type NavItem = {
  href: string
  label: string
  group?: NavGroup          // category in the "More" menu/sheet (top-level items + Book Now omit it)
  desktopPrimary?: boolean  // shown in the desktop top-bar centre
  mobilePrimary?: boolean   // shown in the mobile bottom bar
  adminOnly?: boolean       // hidden from managers (also gated server-side)
  ownerOnly?: boolean       // platform owner only (also gated server-side)
}

/** Book Now is the high-attention inbox: the notification indicator on desktop and the
 *  raised centre action on mobile — never a plain nav pill. Referenced by href. */
export const BOOK_NOW_HREF = '/admin/operations/book-now'
export function isBookNow(n: { href: string }): boolean { return n.href === BOOK_NOW_HREF }

// Order matters: desktop centre order, mobile bar order, and item order within each group.
export const NAV_ITEMS: NavItem[] = [
  // ── Primary destinations ──
  { href: '/admin/operations', label: 'Home', desktopPrimary: true, mobilePrimary: true },
  { href: '/admin/operations/schedule', label: 'Schedule', desktopPrimary: true, mobilePrimary: true },
  { href: '/admin/operations/list', label: 'Operations', desktopPrimary: true, mobilePrimary: true },
  { href: '/admin/operations/messages', label: 'Messages', desktopPrimary: true, mobilePrimary: true },
  { href: '/admin/operations/employees', label: 'Crew', desktopPrimary: true }, // mobile: lives in More
  // ── Book Now (special action — bell on desktop, raised centre button on mobile) ──
  { href: BOOK_NOW_HREF, label: 'Book Now' },
  // ── More menu — Team ──
  // Team & Access (logins, roles, deactivation) was reachable ONLY via Settings, so
  // adding a crew login meant a detour through an unrelated screen. It belongs beside
  // Crew: same subject, different half — the roster vs. who can sign in.
  { href: '/admin/operations/users', label: 'Team & Access', group: 'team', adminOnly: true },
  // ── More menu — Communication ──
  { href: '/admin/operations/communications', label: 'Communications', group: 'comms' },
  { href: '/admin/operations/ai', label: 'AI Command Center', group: 'comms', adminOnly: true, ownerOnly: true },
  // ── More menu — Business ──
  { href: '/admin/operations/businesses', label: 'Businesses', group: 'business' },
  { href: '/admin/operations/equipment', label: 'Equipment', group: 'business' },
  { href: '/admin/operations/claims', label: 'Claims', group: 'business' },
  // ── More menu — Finance ──
  { href: '/admin/operations/pay-statements', label: 'Pay', group: 'finance' },
  { href: '/admin/operations/settings', label: 'Settings', group: 'finance', adminOnly: true },
  // ── More menu — Release ──
  { href: '/admin/operations/release', label: 'Release Center', group: 'release', adminOnly: true },
  // ── More menu — Platform ──
  { href: '/admin/operations/platform', label: 'Platform', group: 'platform', adminOnly: true, ownerOnly: true },
  { href: '/admin/operations/sync', label: 'Sync Status', group: 'platform', adminOnly: true, ownerOnly: true },
]

export const GROUP_ORDER: NavGroup[] = ['team', 'comms', 'business', 'finance', 'release', 'platform']
export const GROUP_LABELS: Record<NavGroup, string> = {
  team: 'Team', comms: 'Communication', business: 'Business', finance: 'Finance', release: 'Release', platform: 'Platform',
}

/** Destinations the current role/owner may see (managers lose adminOnly; ownerOnly is owner-only).
 *  Semantics unchanged from the previous nav model — hiding is never the control. */
export function visibleNav(items: NavItem[], ctx: { role?: string; isOwner: boolean }): NavItem[] {
  return items.filter(n => (!n.adminOnly || ctx.role !== 'manager') && (!n.ownerOnly || ctx.isOwner))
}

/** Desktop top-bar centre destinations, in order. */
export function desktopPrimaryNav(visible: NavItem[]): NavItem[] {
  return visible.filter(n => n.desktopPrimary)
}

/** Mobile bottom-bar destinations, in order (Book Now is the raised centre action, added by the shell). */
export function mobilePrimaryNav(visible: NavItem[]): NavItem[] {
  return visible.filter(n => n.mobilePrimary)
}

export type NavMenuGroup = { key: string; label: string; items: NavItem[] }

/** Desktop "More" mega-menu: the grouped destinations, in category order, non-empty. */
export function menuGroups(visible: NavItem[]): NavMenuGroup[] {
  return GROUP_ORDER
    .map(group => ({ key: group, label: GROUP_LABELS[group], items: visible.filter(n => n.group === group) }))
    .filter(g => g.items.length > 0)
}

/** Mobile "More" sheet: top-level destinations not in the bottom bar (Crew) lead, then the
 *  categories. Crew and Team & Access are ONE section, never two headings both reading
 *  "Team" — the bottom-bar overflow merges into the real group rather than sitting above it. */
export function mobileMoreGroups(visible: NavItem[]): NavMenuGroup[] {
  const topLevelExtra = visible.filter(n => n.desktopPrimary && !n.mobilePrimary && !isBookNow(n))
  const groups = menuGroups(visible)
  if (!topLevelExtra.length) return groups
  const i = groups.findIndex(g => g.key === 'team')
  if (i === -1) return [{ key: 'team', label: GROUP_LABELS.team, items: topLevelExtra }, ...groups]
  const merged = { ...groups[i], items: [...topLevelExtra, ...groups[i].items] }
  return [merged, ...groups.slice(0, i), ...groups.slice(i + 1)]
}
