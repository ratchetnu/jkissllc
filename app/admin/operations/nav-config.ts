// ── Operion operations navigation model (config-driven, role-aware, PURE) ────
// ONE source of truth for the admin/manager operations nav. The mobile bottom bar shows at
// most FIVE items (four primary + More); everything else lives in a grouped "More" sheet.
// Desktop shows the full dock. Every destination stays reachable — nothing is removed. No
// React/icons here (icons are mapped by href in the shell) so the model is unit-testable.

export type NavGroup = 'work' | 'finance' | 'comms' | 'platform'
export type NavItem = {
  href: string
  label: string
  group: NavGroup
  primary?: boolean        // shown in the mobile bottom bar (max 4 + More)
  adminOnly?: boolean      // hidden from managers (also gated server-side)
  ownerOnly?: boolean      // platform owner only
}

// Order matters for the desktop dock + the More sheet within each group.
export const NAV_ITEMS: NavItem[] = [
  { href: '/admin/operations', label: 'Home', group: 'work', primary: true },
  { href: '/admin/operations/book-now', label: 'Book Now', group: 'work', primary: true },
  { href: '/admin/operations/list', label: 'Operations', group: 'work', primary: true },
  { href: '/admin/operations/messages', label: 'Messages', group: 'comms', primary: true },
  { href: '/admin/operations/employees', label: 'Crew', group: 'work' },
  { href: '/admin/operations/businesses', label: 'Businesses', group: 'work' },
  { href: '/admin/operations/equipment', label: 'Equipment', group: 'work' },
  { href: '/admin/operations/claims', label: 'Claims', group: 'finance' },
  { href: '/admin/operations/pay-statements', label: 'Pay', group: 'finance' },
  { href: '/admin/operations/settings', label: 'Settings', group: 'platform', adminOnly: true },
  { href: '/admin/operations/platform', label: 'Platform', group: 'platform', adminOnly: true, ownerOnly: true },
  { href: '/admin/operations/ai/shadow', label: 'Shadow AI', group: 'platform', adminOnly: true, ownerOnly: true },
]

export const GROUP_LABELS: Record<NavGroup, string> = { work: 'Work', finance: 'Finance', comms: 'Communication', platform: 'Platform' }
export const GROUP_ORDER: NavGroup[] = ['work', 'finance', 'comms', 'platform']

export const MAX_PRIMARY = 5   // four destinations + the More button

/** Destinations the current role/owner may see (managers lose adminOnly; ownerOnly is owner-only). */
export function visibleNav(items: NavItem[], ctx: { role?: string; isOwner: boolean }): NavItem[] {
  return items.filter(n => (!n.adminOnly || ctx.role !== 'manager') && (!n.ownerOnly || ctx.isOwner))
}

/** The mobile primary destinations — at most 4 (the 5th slot is the More button). */
export function primaryNav(visible: NavItem[]): NavItem[] {
  const primary = visible.filter(n => n.primary).slice(0, MAX_PRIMARY - 1)
  // Backfill from the visible list if fewer than 4 are flagged primary (keeps 4 tappable).
  if (primary.length < MAX_PRIMARY - 1) {
    for (const n of visible) { if (primary.length >= MAX_PRIMARY - 1) break; if (!primary.includes(n)) primary.push(n) }
  }
  return primary
}

/** Everything not in the mobile primary bar, grouped for the More sheet (order preserved). */
export function moreGroups(visible: NavItem[], primary: NavItem[]): { group: NavGroup; label: string; items: NavItem[] }[] {
  const primaryHrefs = new Set(primary.map(p => p.href))
  const rest = visible.filter(n => !primaryHrefs.has(n.href))
  return GROUP_ORDER
    .map(group => ({ group, label: GROUP_LABELS[group], items: rest.filter(n => n.group === group) }))
    .filter(g => g.items.length > 0)
}
