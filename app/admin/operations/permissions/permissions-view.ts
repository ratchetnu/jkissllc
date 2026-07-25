// ── Permissions viewer — PURE view helpers ───────────────────────────────────
// Presentation only. These helpers shape the read-only RBAC projection served by
// /api/admin/permissions for display; they never decide access. Authorization stays
// exactly where it was: the static matrix in lib/rbac.ts, computed through can() and
// enforced by the route guards. Nothing here can grant, revoke, or reorder a grant.
//
// Kept separate from the page so the labelling, filtering, and grouping are unit-
// testable without a DOM.

export type Role = { id: string; label: string }
export type Perm = { id: string; grantedBy: string[] }
export type Domain = { domain: string; permissions: Perm[] }
export type MatrixData = { roles: Role[]; domains: Domain[]; readOnly: boolean }

/** The three ways to read the same matrix. */
export type ViewMode = 'permission' | 'role' | 'matrix'
export const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'permission', label: 'By permission' },
  { id: 'role', label: 'By role' },
  { id: 'matrix', label: 'Matrix' },
]

// Plain-language name for each permission. The raw `domain:action` id is developer
// vocabulary — it stays available as secondary text and in Matrix view, but it is not
// what the primary UI leads with. Unknown ids fall back to a derived phrase, so a new
// permission added to rbac.ts still renders sensibly instead of disappearing.
export const PERMISSION_LABELS: Record<string, string> = {
  'businesses:manage': 'Manage businesses',
  'routes:manage': 'Manage routes',
  'routes:view': 'View routes',
  'recurring:manage': 'Manage recurring routes',
  'equipment:manage': 'Manage equipment',
  'equipment:assign': 'Assign equipment',
  'equipment:view': 'View equipment',
  'fleet:maintenance': 'Manage fleet maintenance',
  'crew:manage': 'Manage crew',
  'crew:view': 'View crew',
  'crew:assign': 'Assign crew',
  'crew:score:view': 'View crew scores',
  'availability:view': 'View availability',
  'timeoff:view': 'View time-off requests',
  'timeoff:approve': 'Approve time off',
  'time:view': 'View timesheets',
  'time:manage': 'Manage timesheets',
  'applicants:review': 'Review applicants',
  'applicants:decide': 'Decide on applicants',
  'ai:use': 'Use AI tools',
  'ai:analytics': 'View AI analytics',
  'ai:prompts:manage': 'Manage AI prompts',
  'messages:send': 'Send messages',
  'reminders:view': 'View reminders',
  'reminders:manage': 'Manage reminders',
  'dispatch:send': 'Send dispatch messages',
  'comms:analytics': 'View communication analytics',
  'users:manage': 'Manage user accounts',
  'roles:manage': 'Manage roles',
  'pay:configure': 'Configure pay rules',
  'pay:generate': 'Generate pay statements',
  'pay:view:all': "View everyone's pay",
  'pay:adjust:submit': 'Submit pay adjustments',
  'pay:approve': 'Approve pay',
  'tax:view': 'View tax details',
  'invoices:manage': 'Manage invoices',
  'profitability:view': 'View profitability',
  'claims:manage': 'Manage claims',
  'claims:create': 'Create claims',
  'claimguard:use': 'Use ClaimGuard',
  'settings:manage': 'Manage settings',
  'integrations:manage': 'Manage integrations',
  'audit:view': 'View audit log',
  'permissions:view': 'View permissions',
  'accounts:suspend': 'Suspend accounts',
  'reports:view': 'View reports',
  'self:view': 'View their own profile',
  'self:availability': 'Set their own availability',
  'self:timeoff': 'Request their own time off',
  'self:timeclock': 'Clock in and out',
  'self:pay:request': 'Request their own pay details',
  'self:messages': 'See their own messages',
  'self:reminders': 'See their own reminders',
  'self:uniform': 'Manage their own uniform',
}

const VERBS = new Set(['manage', 'view', 'assign', 'approve', 'send', 'use', 'create', 'suspend', 'configure', 'generate', 'submit', 'decide', 'review', 'request'])

/** Plain-language name, with a safe derivation for ids not in the map. */
export function permissionLabel(id: string): string {
  const known = PERMISSION_LABELS[id]
  if (known) return known
  const parts = id.split(':').filter(Boolean)
  if (parts.length === 0) return id
  const last = parts[parts.length - 1]
  if (!VERBS.has(last)) return id
  const subject = parts.slice(0, -1).join(' ')
  const verb = last.charAt(0).toUpperCase() + last.slice(1)
  return subject ? `${verb} ${subject}` : verb
}

export type FilterOpts = { q?: string; domain?: string; role?: string }

/** Filter by free text (matches BOTH the plain-language name and the raw id), by
 *  domain, and by granting role. Empty domains are dropped so no header sits alone. */
export function filterDomains(domains: Domain[], opts: FilterOpts = {}): Domain[] {
  const s = (opts.q ?? '').trim().toLowerCase()
  return domains
    .filter(d => !opts.domain || d.domain === opts.domain)
    .map(d => ({
      ...d,
      permissions: d.permissions.filter(p => {
        if (opts.role && !p.grantedBy.includes(opts.role)) return false
        if (!s) return true
        return p.id.toLowerCase().includes(s) || permissionLabel(p.id).toLowerCase().includes(s)
      }),
    }))
    .filter(d => d.permissions.length > 0)
}

export function countPermissions(domains: Domain[]): number {
  return domains.reduce((n, d) => n + d.permissions.length, 0)
}

/** "3 permissions" / "1 permission" — no bare numbers floating in the UI. */
export function resultCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'permission' : 'permissions'}`
}

export type RoleSummary = { id: string; label: string; granted: number; total: number; areas: number }

/** Per-role totals, derived from the SAME projection the matrix renders — never a
 *  hand-written claim about what a role can do. */
export function roleSummaries(data: MatrixData): RoleSummary[] {
  const total = countPermissions(data.domains)
  return data.roles.map(r => {
    const areas = data.domains.filter(d => d.permissions.some(p => p.grantedBy.includes(r.id))).length
    const granted = data.domains.reduce((n, d) => n + d.permissions.filter(p => p.grantedBy.includes(r.id)).length, 0)
    return { id: r.id, label: r.label, granted, total, areas }
  })
}

/** "12 of 54 · 4 areas" */
export function roleScopeLabel(s: RoleSummary): string {
  return `${s.granted} of ${s.total} · ${s.areas} ${s.areas === 1 ? 'area' : 'areas'}`
}
