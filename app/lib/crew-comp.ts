// Crew compensation summary — earnings computed ONLY from actual completed work.
//
// Pure and truthful: every figure is the sum of the pay OpsPilot already snapshotted
// onto each assignee when they were put on a route (lib/finance.snapshotCrewPay).
// It reports what a crew member has EARNED (completed routes), not what has been paid
// out — there is no crew-payment settlement record yet, so we never fabricate a
// "Total Paid / Outstanding" (see docs/opspilot-future-improvements.md). A crew member
// can be any assignee on a route, not just the lead, so we match on assignees[].

export type CompRoute = {
  routeNumber: string
  businessName: string
  status: string
  routeDate: string // YYYY-MM-DD
  assignees?: { staffId: string; payCents?: number; role?: string }[]
}

export type CompLine = { routeNumber: string; businessName: string; date: string; payCents: number }

export type CrewCompSummary = {
  lifetimeEarningsCents: number
  ytdEarningsCents: number
  periodEarningsCents: number     // current pay week (weekStart..today, inclusive)
  completedRoutes: number
  upcomingRoutes: number
  businesses: string[]            // distinct clients they've been assigned to
  recent: CompLine[]              // recent completed routes = their earnings history
}

const LIVE_UPCOMING = new Set(['assigned', 'text_sent', 'confirmed'])

export function computeCrewComp(
  staffId: string,
  routes: CompRoute[],
  todayYmd: string,
  weekStartYmd: string,
): CrewCompSummary {
  const yearStart = `${todayYmd.slice(0, 4)}-01-01`
  const businesses = new Set<string>()
  const completed: CompLine[] = []
  let lifetime = 0, ytd = 0, period = 0, completedRoutes = 0, upcoming = 0

  for (const r of routes) {
    const mine = r.assignees?.find(a => a.staffId === staffId)
    if (!mine) continue
    if (r.businessName) businesses.add(r.businessName)
    const pay = mine.payCents ?? 0

    if (r.status === 'completed') {
      completedRoutes++
      lifetime += pay
      if (r.routeDate >= yearStart) ytd += pay
      if (r.routeDate >= weekStartYmd && r.routeDate <= todayYmd) period += pay
      completed.push({ routeNumber: r.routeNumber, businessName: r.businessName, date: r.routeDate, payCents: pay })
    } else if (LIVE_UPCOMING.has(r.status) && r.routeDate >= todayYmd) {
      upcoming++
    }
  }

  completed.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return {
    lifetimeEarningsCents: lifetime,
    ytdEarningsCents: ytd,
    periodEarningsCents: period,
    completedRoutes,
    upcomingRoutes: upcoming,
    businesses: [...businesses].sort((a, b) => a.localeCompare(b)),
    recent: completed.slice(0, 8),
  }
}
