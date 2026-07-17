// Crew portal timeclock — pure punch + selection logic. No Redis, no routes I/O.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyPunch,
  selectClockable,
  pickActiveClockable,
  clockPhase,
  isClockable,
  coord,
  type ClockableRoute,
} from '../app/lib/crew-timeclock'
import type { Assignee, RouteRecord } from '../app/lib/routes'

// Minimal builders — the pure helpers only touch a handful of fields, so we cast
// trimmed literals rather than construct full records.
const assignee = (o: Partial<Assignee>): Assignee => ({ staffId: 's1', name: 'Dee', token: 'atok1', ...o }) as Assignee
const route = (o: Partial<RouteRecord>): RouteRecord =>
  ({ token: 'rt1', routeNumber: 'JK-R-1', businessName: 'Acme', reportAddress: '1 Main', reportTime: '7:00 AM', routeDate: '2026-07-17', status: 'confirmed', assignees: [], ...o }) as RouteRecord

test('coord drops out-of-range and non-finite values', () => {
  assert.equal(coord(41.5, -90, 90), 41.5)
  assert.equal(coord(999, -90, 90), undefined)
  assert.equal(coord(Number.NaN, -90, 90), undefined)
  assert.equal(coord('41', -90, 90), undefined)
})

test('clock_in records time + GPS, and is idempotent', () => {
  const a = assignee({ confirmedAt: 1 })
  const r1 = applyPunch(a, 'clock_in', { lat: 41.1, lng: -96.1, accuracy: 8 }, 1000)
  assert.deepEqual(r1, { ok: true, changed: true, already: false, denied: false })
  assert.equal(a.clockInAt, 1000)
  assert.equal(a.clockInLat, 41.1)
  assert.equal(a.clockInLocationDenied, undefined)

  // A second clock_in makes no change and reports `already`.
  const r2 = applyPunch(a, 'clock_in', { lat: 42, lng: -97, accuracy: 8 }, 2000)
  assert.equal(r2.ok, true)
  assert.equal((r2 as { changed: boolean }).changed, false)
  assert.equal((r2 as { already: boolean }).already, true)
  assert.equal(a.clockInAt, 1000, 'timestamp unchanged by the repeat')
})

test('clock_in with no location is allowed and flagged denied', () => {
  const a = assignee({ confirmedAt: 1 })
  const r = applyPunch(a, 'clock_in', { locationDenied: true }, 1000)
  assert.equal(r.ok, true)
  assert.equal((r as { denied: boolean }).denied, true)
  assert.equal(a.clockInAt, 1000, 'shift still recorded')
  assert.equal(a.clockInLocationDenied, true)
})

test('missing coordinates count as denied even without the explicit flag', () => {
  const a = assignee({ confirmedAt: 1 })
  const r = applyPunch(a, 'clock_in', { lat: 41.1 /* no lng */ }, 1000)
  assert.equal((r as { denied: boolean }).denied, true)
  assert.equal(a.clockInLocationDenied, true)
})

test('cannot clock in without confirming the route', () => {
  const a = assignee({})
  const r = applyPunch(a, 'clock_in', {}, 1000)
  assert.deepEqual(r, { ok: false, code: 'not_confirmed' })
  assert.equal(a.clockInAt, undefined)
})

test('cannot clock out before clocking in', () => {
  const a = assignee({ confirmedAt: 1 })
  const r = applyPunch(a, 'clock_out', { lat: 41, lng: -96 }, 1000)
  assert.deepEqual(r, { ok: false, code: 'not_clocked_in' })
})

test('clock_out records time and is idempotent', () => {
  const a = assignee({ confirmedAt: 1, clockInAt: 500 })
  const r1 = applyPunch(a, 'clock_out', { lat: 41, lng: -96, accuracy: 10 }, 1500)
  assert.equal((r1 as { changed: boolean }).changed, true)
  assert.equal(a.clockOutAt, 1500)
  const r2 = applyPunch(a, 'clock_out', {}, 2500)
  assert.equal((r2 as { already: boolean }).already, true)
  assert.equal(a.clockOutAt, 1500)
})

test('clockPhase reflects the punch state', () => {
  assert.equal(clockPhase({}), 'not_started')
  assert.equal(clockPhase({ clockInAt: 1 }), 'clocked_in')
  assert.equal(clockPhase({ clockInAt: 1, clockOutAt: 2 }), 'clocked_out')
})

test('isClockable requires confirmed, not declined, and a live route', () => {
  assert.equal(isClockable({ status: 'confirmed' }, { confirmedAt: 1 }), true)
  assert.equal(isClockable({ status: 'confirmed' }, {}), false, 'unconfirmed')
  assert.equal(isClockable({ status: 'confirmed' }, { confirmedAt: 1, declinedAt: 2 }), false, 'declined')
  assert.equal(isClockable({ status: 'completed' }, { confirmedAt: 1 }), false, 'route over')
  assert.equal(isClockable({ status: 'cancelled' }, { confirmedAt: 1 }), false, 'route cancelled')
})

test('selectClockable returns only today\'s confirmed assignments for the staff member', () => {
  const routes: RouteRecord[] = [
    route({ token: 'a', routeDate: '2026-07-17', status: 'confirmed', assignees: [assignee({ staffId: 's1', token: 'ta', confirmedAt: 1 })] }),
    route({ token: 'b', routeDate: '2026-07-18', status: 'confirmed', assignees: [assignee({ staffId: 's1', token: 'tb', confirmedAt: 1 })] }), // wrong day
    route({ token: 'c', routeDate: '2026-07-17', status: 'confirmed', assignees: [assignee({ staffId: 's2', token: 'tc', confirmedAt: 1 })] }), // other crew
    route({ token: 'd', routeDate: '2026-07-17', status: 'confirmed', assignees: [assignee({ staffId: 's1', token: 'td' })] }), // unconfirmed
    route({ token: 'e', routeDate: '2026-07-17', status: 'cancelled', assignees: [assignee({ staffId: 's1', token: 'te', confirmedAt: 1 })] }), // cancelled
  ]
  const out = selectClockable(routes, 's1', '2026-07-17')
  assert.equal(out.length, 1)
  assert.equal(out[0].assigneeToken, 'ta')
})

test('pickActiveClockable prefers an open shift, then a not-started one', () => {
  const mk = (assigneeToken: string, phase: ClockableRoute['phase']): ClockableRoute =>
    ({ assigneeToken, phase, routeToken: 'r', routeNumber: 'n', businessName: 'b', reportAddress: '', reportTime: '', routeDate: '', role: null, status: 'confirmed', clockInAt: null, clockOutAt: null })
  assert.equal(pickActiveClockable([mk('a', 'not_started'), mk('b', 'clocked_in')])?.assigneeToken, 'b')
  assert.equal(pickActiveClockable([mk('a', 'clocked_out'), mk('b', 'not_started')])?.assigneeToken, 'b')
  assert.equal(pickActiveClockable([]), null)
})
