// Contractor reliability — derived entirely from route history (no new store).
// A 0–100 score summarizing how a contractor handles the routes they're offered,
// alongside the raw counts so dispatch can see exactly what drives it.
import { listRoutes, type RouteRecord } from './routes'

export type ContractorStats = {
  staffId: string
  assignments: number   // resolved assignments that count toward the score
  confirmed: number     // confirmed and reported (or awaiting completion)
  completed: number     // confirmed and finished
  declined: number      // turned it down (communicated)
  noResponse: number    // never answered by the route date
  noShow: number        // confirmed then didn't report
  score: number | null  // 0–100, or null with no resolved history yet
}

// Per-outcome weight. Completing/confirming reward; ghosting (no response) is
// neutral-zero; a no-show actively drags the score down. Declines sit mid — the
// contractor communicated, but a decline still costs dispatch a reassignment.
const WEIGHT = { completed: 1, confirmed: 0.85, declined: 0.5, no_response: 0, no_show: -0.75 }

// Accepts a pre-fetched route list so a caller that already loaded routes (e.g.
// the admin routes GET) doesn't trigger a second full scan.
export async function computeContractorStats(prefetched?: RouteRecord[]): Promise<Map<string, ContractorStats>> {
  const routes = prefetched ?? await listRoutes(1000)
  const acc = new Map<string, ContractorStats & { sum: number }>()

  for (const r of routes) {
    const id = r.assignedStaffId
    if (!id) continue
    let e = acc.get(id)
    if (!e) { e = { staffId: id, assignments: 0, confirmed: 0, completed: 0, declined: 0, noResponse: 0, noShow: 0, score: null, sum: 0 }; acc.set(id, e) }

    let pts: number | null = null
    switch (r.status) {
      case 'completed': e.completed++; pts = WEIGHT.completed; break
      case 'confirmed': e.confirmed++; pts = WEIGHT.confirmed; break
      case 'declined': e.declined++; pts = WEIGHT.declined; break
      case 'no_response': e.noResponse++; pts = WEIGHT.no_response; break
      case 'no_show': e.noShow++; pts = WEIGHT.no_show; break
      // draft / assigned / text_sent / cancelled — not a resolved outcome; ignore.
    }
    if (pts !== null) { e.assignments++; e.sum += pts }
  }

  const out = new Map<string, ContractorStats>()
  for (const [id, e] of acc) {
    const score = e.assignments > 0 ? Math.max(0, Math.min(100, Math.round((e.sum / e.assignments) * 100))) : null
    out.set(id, {
      staffId: e.staffId, assignments: e.assignments, confirmed: e.confirmed, completed: e.completed,
      declined: e.declined, noResponse: e.noResponse, noShow: e.noShow, score,
    })
  }
  return out
}

// Plain-object form for JSON responses (keyed by staffId).
export async function contractorStatsObject(prefetched?: RouteRecord[]): Promise<Record<string, ContractorStats>> {
  return Object.fromEntries(await computeContractorStats(prefetched))
}
