// Crew compensation — earnings from actual completed work only. Pure.
import assert from 'node:assert/strict'
import test from 'node:test'
import { computeCrewComp, type CompRoute } from '../app/lib/crew-comp'

const routes: CompRoute[] = [
  // Marcus: two completed (one this week, one earlier this year), one upcoming.
  { routeNumber: 'JK-R-1', businessName: 'Acme', status: 'completed', routeDate: '2026-07-08', assignees: [{ staffId: 'marcus', payCents: 17500 }] },
  { routeNumber: 'JK-R-2', businessName: 'Acme', status: 'completed', routeDate: '2026-02-01', assignees: [{ staffId: 'marcus', payCents: 15000 }] },
  { routeNumber: 'JK-R-3', businessName: 'Beta', status: 'confirmed', routeDate: '2026-07-20', assignees: [{ staffId: 'marcus', payCents: 15000 }, { staffId: 'dee', payCents: 12500 }] },
  // A prior-year completed route must NOT count toward YTD, but does toward lifetime.
  { routeNumber: 'JK-R-0', businessName: 'Acme', status: 'completed', routeDate: '2025-12-30', assignees: [{ staffId: 'marcus', payCents: 10000 }] },
  // Cancelled earns nothing.
  { routeNumber: 'JK-R-4', businessName: 'Gamma', status: 'cancelled', routeDate: '2026-07-01', assignees: [{ staffId: 'marcus', payCents: 15000 }] },
]

test('earnings are summed only from completed routes, scoped by period', () => {
  // Pay week Mon 2026-07-06 .. today 2026-07-09.
  const c = computeCrewComp('marcus', routes, '2026-07-09', '2026-07-06')
  assert.equal(c.completedRoutes, 3, 'three completed (incl. prior year), cancelled excluded')
  assert.equal(c.lifetimeEarningsCents, 17500 + 15000 + 10000, 'lifetime = all completed')
  assert.equal(c.ytdEarningsCents, 17500 + 15000, 'YTD excludes the 2025 route')
  assert.equal(c.periodEarningsCents, 17500, 'this pay week = only JK-R-1')
  assert.equal(c.upcomingRoutes, 1, 'one live upcoming route')
  assert.deepEqual(c.businesses, ['Acme', 'Beta', 'Gamma'], 'distinct clients they were ASSIGNED to (a cancelled route still counts as an assignment)')
  assert.equal(c.recent[0].routeNumber, 'JK-R-1', 'recent sorted newest-first')
})

test('a non-lead assignee is credited by their own snapshotted pay', () => {
  const c = computeCrewComp('dee', routes, '2026-07-09', '2026-07-06')
  assert.equal(c.upcomingRoutes, 1)
  assert.equal(c.completedRoutes, 0)
  assert.equal(c.lifetimeEarningsCents, 0)
})

test('unknown crew member yields an all-zero summary', () => {
  const c = computeCrewComp('ghost', routes, '2026-07-09', '2026-07-06')
  assert.deepEqual([c.completedRoutes, c.lifetimeEarningsCents, c.upcomingRoutes, c.businesses.length], [0, 0, 0, 0])
})
