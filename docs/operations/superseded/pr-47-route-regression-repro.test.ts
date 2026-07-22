// COORDINATOR REPRO — throwaway. Independently reproduces the PR #47 route-lane
// regression on main c791d4e. Not to be committed to main.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { RouteRecord } from '../app/lib/routes'
import { routeToScheduleItem } from '../app/lib/schedule/unified'
import { detectConflicts } from '../app/lib/schedule/conflicts'
import { isEnabled } from '../app/lib/platform/flags'

// A scheduled, non-draft contract route that HAS a driver but still wants a
// helper. This is ordinary, pre-existing route-lane data — no bookings, no
// assignment feature, nothing to do with BOOKING_ASSIGNMENT_ENABLED.
function partiallyCrewedRoute(): RouteRecord {
  return {
    token: 'rt-repro-1',
    routeNumber: 'R-1001',
    businessName: 'Acme Contract',
    routeDate: '2026-08-01',
    reportTime: '07:00',
    status: 'assigned',
    requiresHelper: true,
    assignees: [
      { staffId: 'stf-1', name: 'Dana Driver', role: 'driver', confirmedAt: '2026-07-20T10:00:00Z' },
    ],
  } as unknown as RouteRecord
}

test('flag is OFF — this is the inert configuration', () => {
  assert.equal(isEnabled('BOOKING_ASSIGNMENT_ENABLED'), false)
})

test('REPRO: partially-crewed route projects crew=1 but crewComplete=false', () => {
  const it = routeToScheduleItem(partiallyCrewedRoute())
  assert.equal(it.kind, 'route')
  assert.equal(it.lane, 'confirmed')          // non-draft => confirmed
  assert.equal(it.scheduled, true)            // has a valid routeDate
  assert.equal(it.crew.length, 1)             // A DRIVER IS ASSIGNED
  assert.equal(it.crewComplete, false)        // ...but the helper gap is open
})

test('REPRO: detectConflicts emits missing_crew for a route that HAS a driver', () => {
  const item = routeToScheduleItem(partiallyCrewedRoute())
  const conflicts = detectConflicts([item])
  const missing = conflicts.filter(c => c.type === 'missing_crew')

  console.log('  >> missing_crew count:', missing.length)
  for (const m of missing) console.log('  >> message:', JSON.stringify(m.message))

  // Pre-#47 predicate (crew.length === 0) would have produced ZERO here.
  assert.equal(missing.length, 1, 'regression reproduced: spurious missing_crew on the route lane')
  assert.match(missing[0].message, /no crew assigned/)
})

test('CONTROL: a fully-crewed route emits nothing (unchanged by #47)', () => {
  const r = partiallyCrewedRoute()
  r.assignees!.push({ staffId: 'stf-2', name: 'Hal Helper', role: 'helper' } as never)
  const conflicts = detectConflicts([routeToScheduleItem(r)])
  assert.equal(conflicts.filter(c => c.type === 'missing_crew').length, 0)
})

test('CONTROL: a genuinely uncrewed route still emits missing_crew (must stay)', () => {
  const r = partiallyCrewedRoute()
  r.assignees = []
  const conflicts = detectConflicts([routeToScheduleItem(r)])
  assert.equal(conflicts.filter(c => c.type === 'missing_crew').length, 1)
})

// The proposed narrow fix, evaluated as a pure predicate against the same items.
test('PROPOSED FIX: crew.length===0 && !crewComplete restores the route lane', () => {
  const partial = routeToScheduleItem(partiallyCrewedRoute())
  const uncrewedRoute = partiallyCrewedRoute(); uncrewedRoute.assignees = []
  const uncrewed = routeToScheduleItem(uncrewedRoute)

  const fixed = (it: { crew: unknown[]; crewComplete: boolean }) =>
    it.crew.length === 0 && !it.crewComplete

  assert.equal(fixed(partial), false, 'partially-crewed route: no longer flagged')
  assert.equal(fixed(uncrewed), true, 'uncrewed route: still flagged')
})
