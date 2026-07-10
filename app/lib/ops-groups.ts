// Operations grouped by Business — pure aggregation over the routes useOps already
// loads. No new backend; every figure is derived from route status/date/financials/
// assignees. Used by the Operations "By business" view and the per-business page.

export type OpsRoute = {
  token: string
  routeNumber: string
  status: string
  businessName: string
  routeDate: string // YYYY-MM-DD
  reportTime: string
  assignedStaffName?: string
  requiresHelper?: boolean
  assignees?: { name?: string; role?: string }[]
  financials?: { businessPriceCents?: number | null }
}

export type BusinessOps = {
  businessName: string
  bizKey: string
  total: number
  counts: {
    upcoming: number; pending: number; confirmed: number; active: number
    completed: number; cancelled: number; attention: number
  }
  nextRoute?: { token: string; routeDate: string; reportTime: string }
  upcomingValueCents: number
  crew: string[]            // distinct crew on upcoming routes
  lastActivity: string      // most recent route date
  isOneTime: boolean        // heuristic: a single route ever = ad-hoc / one-time
}

// Same key the businesses store uses (lib/businesses.bizKey) so URLs and lookups line up.
export const opsBizKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ')

const LIVE = (s: string) => s !== 'cancelled' && s !== 'completed'

// The "needs attention" predicate — mirrors app/admin/operations/list/page.tsx so the
// grouped view and the flat list agree on what's flagged. Two drivers satisfy a
// driver+helper client (a spare driver fills the helper seat).
export function needsAttention(o: OpsRoute, today: string): boolean {
  if (o.status === 'declined' || o.status === 'no_response') return true
  if (o.status === 'draft' && o.routeDate >= today) return true
  if ((o.status === 'assigned' || o.status === 'text_sent') && o.routeDate < today) return true
  if (o.requiresHelper && !['cancelled', 'completed'].includes(o.status) && o.routeDate >= today) {
    const roles = (o.assignees ?? []).map(a => (a.role || '').toLowerCase())
    const drivers = roles.filter(x => x.includes('driver')).length
    const hasHelper = roles.some(x => x.includes('helper'))
    if (drivers === 0 || (!hasHelper && drivers < 2)) return true
  }
  return false
}

function crewNames(o: OpsRoute): string[] {
  const fromAssignees = (o.assignees ?? []).map(a => a.name?.trim()).filter((n): n is string => !!n)
  if (fromAssignees.length) return fromAssignees
  return o.assignedStaffName ? [o.assignedStaffName] : []
}

export function groupOpsByBusiness(routes: OpsRoute[], today: string): BusinessOps[] {
  const map = new Map<string, BusinessOps & { _crew: Set<string> }>()

  for (const r of routes) {
    if (!r.businessName) continue
    const key = opsBizKey(r.businessName)
    let g = map.get(key)
    if (!g) {
      g = {
        businessName: r.businessName, bizKey: key, total: 0,
        counts: { upcoming: 0, pending: 0, confirmed: 0, active: 0, completed: 0, cancelled: 0, attention: 0 },
        upcomingValueCents: 0, crew: [], lastActivity: '', isOneTime: false, _crew: new Set<string>(),
      }
      map.set(key, g)
    }
    g.total++
    if (r.routeDate > g.lastActivity) g.lastActivity = r.routeDate

    const upcoming = r.routeDate >= today && LIVE(r.status)
    if (upcoming) {
      g.counts.upcoming++
      g.upcomingValueCents += r.financials?.businessPriceCents ?? 0
      for (const n of crewNames(r)) g._crew.add(n)
      if (!g.nextRoute || r.routeDate < g.nextRoute.routeDate || (r.routeDate === g.nextRoute.routeDate && r.reportTime < g.nextRoute.reportTime))
        g.nextRoute = { token: r.token, routeDate: r.routeDate, reportTime: r.reportTime }
    }
    if ((r.status === 'assigned' || r.status === 'text_sent') && r.routeDate >= today) g.counts.pending++
    if (r.status === 'confirmed' && r.routeDate >= today) g.counts.confirmed++
    if (r.status === 'confirmed' && r.routeDate === today) g.counts.active++
    if (r.status === 'completed') g.counts.completed++
    if (r.status === 'cancelled') g.counts.cancelled++
    if (needsAttention(r, today)) g.counts.attention++
  }

  const out: BusinessOps[] = []
  for (const g of map.values()) {
    g.crew = [...g._crew].sort((a, b) => a.localeCompare(b))
    g.isOneTime = g.total <= 1
    const { _crew, ...rest } = g
    void _crew
    out.push(rest)
  }
  // Most operationally-relevant first: attention, then most upcoming, then recent.
  return out.sort((a, b) =>
    b.counts.attention - a.counts.attention ||
    b.counts.upcoming - a.counts.upcoming ||
    (a.lastActivity < b.lastActivity ? 1 : -1),
  )
}
