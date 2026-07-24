// Wave C — time-tracking across both lanes + admin timesheet rollups.
// Pure coverage (no live Redis): booking-lane clock ingress, the flag gate, the
// cross-lane single-shift guard, and the hours math. Also pins the registry status
// and the new time:* authorization.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { RouteRecord } from '../app/lib/routes'
import type { Booking } from '../app/lib/bookings'
import type { JobAssignee } from '../app/lib/job-assignment'
import {
  selectClockable, selectClockableBookings, isBookingClockable, mergeClockable, hasOtherOpenPunch,
  type ClockableRoute,
} from '../app/lib/crew-timeclock'
import {
  punchStatus, durationMinutes, selectTimeEntries, rollupByStaff, periodTotalMinutes, formatMinutes,
} from '../app/lib/timesheets'
import { can, permissionsForRole } from '../app/lib/rbac'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'

const DAY = '2026-03-10'
const asg = (o: Partial<JobAssignee> = {}): JobAssignee => ({ staffId: 's1', name: 'Alex', token: 'a1', confirmedAt: 1, ...o })
const route = (o: Partial<RouteRecord> = {}): RouteRecord =>
  ({ token: 'rt1', routeNumber: 'R-1', routeDate: DAY, status: 'scheduled', businessName: 'Acme', reportAddress: '1 St', reportTime: '8a', assignees: [asg()], ...o } as unknown as RouteRecord)
const booking = (o: Partial<Booking> = {}): Booking =>
  ({ token: 'bk1', bookingNumber: 'JK-B-1', customerName: 'Jane', jobSiteAddress: '9 Rd', status: 'confirmed', selectedDate: DAY, assignees: [asg()], ...o } as unknown as Booking)

// ── Existing route lane is unchanged ──────────────────────────────────────────

test('route clock selection is unchanged and tagged type:route', () => {
  const items = selectClockable([route()], 's1', DAY)
  assert.equal(items.length, 1)
  assert.equal(items[0].type, 'route')
  assert.equal(items[0].routeToken, 'rt1')
  assert.equal(items[0].assigneeToken, 'a1')
  // unconfirmed / declined / wrong-day are excluded, as before
  assert.equal(selectClockable([route({ assignees: [asg({ confirmedAt: undefined })] })], 's1', DAY).length, 0)
  assert.equal(selectClockable([route({ routeDate: '2026-03-11' })], 's1', DAY).length, 0)
})

// ── Booking-lane clock ingress ────────────────────────────────────────────────

test('isBookingClockable: confirmed + live only', () => {
  assert.equal(isBookingClockable({ status: 'confirmed', completedAt: undefined }, asg()), true)
  assert.equal(isBookingClockable({ status: 'confirmed', completedAt: undefined }, asg({ confirmedAt: undefined })), false)
  assert.equal(isBookingClockable({ status: 'confirmed', completedAt: undefined }, asg({ declinedAt: 5 })), false)
  assert.equal(isBookingClockable({ status: 'cancelled', completedAt: undefined }, asg()), false)
  assert.equal(isBookingClockable({ status: 'completed', completedAt: undefined }, asg()), false)
  assert.equal(isBookingClockable({ status: 'confirmed', completedAt: 123 }, asg()), false)
})

test('selectClockableBookings projects bookings tagged type:booking with the booking token as key', () => {
  const items = selectClockableBookings([booking()], 's1', DAY)
  assert.equal(items.length, 1)
  assert.equal(items[0].type, 'booking')
  assert.equal(items[0].routeToken, 'bk1')            // booking token = punch key
  assert.equal(items[0].routeNumber, 'JK-B-1')
  assert.equal(items[0].businessName, 'Jane')
  assert.equal(items[0].reportAddress, '9 Rd')
  // wrong day + not-mine excluded
  assert.equal(selectClockableBookings([booking({ selectedDate: '2026-03-11' })], 's1', DAY).length, 0)
  assert.equal(selectClockableBookings([booking()], 'sOther', DAY).length, 0)
})

test('mergeClockable hides bookings when the flag is off, includes them when on', () => {
  const off = mergeClockable([route()], [booking()], 's1', DAY, false)
  assert.equal(off.length, 1)
  assert.equal(off[0].type, 'route')                  // booking-lane dormant
  const on = mergeClockable([route()], [booking()], 's1', DAY, true)
  assert.equal(on.length, 2)
  assert.deepEqual(on.map(i => i.type).sort(), ['booking', 'route'])
})

// ── Cross-lane single-shift guard ─────────────────────────────────────────────

test('hasOtherOpenPunch blocks a second concurrent clock-in across lanes', () => {
  const mk = (o: Partial<ClockableRoute>): ClockableRoute =>
    ({ type: 'route', assigneeToken: 'x', routeToken: 't', routeNumber: 'n', businessName: 'b', reportAddress: '', reportTime: '', routeDate: DAY, role: null, status: 'scheduled', clockInAt: null, clockOutAt: null, phase: 'not_started', ...o })
  const items = [mk({ assigneeToken: 'a1', phase: 'clocked_in' }), mk({ assigneeToken: 'b2', type: 'booking', phase: 'not_started' })]
  assert.equal(hasOtherOpenPunch(items, 'b2'), true)   // a1 (a route) is still open
  assert.equal(hasOtherOpenPunch(items, 'a1'), false)  // the only open one IS the target
  assert.equal(hasOtherOpenPunch([mk({ phase: 'not_started' })], 'z'), false)
})

// ── Hours math ────────────────────────────────────────────────────────────────

const T = Date.UTC(2026, 2, 10, 14, 0, 0)   // 14:00
const T8 = T + 8 * 3600_000                  // +8h

test('punchStatus + durationMinutes handle complete, open, invalid, overnight', () => {
  assert.equal(punchStatus(T, T8), 'complete')
  assert.equal(durationMinutes(T, T8), 480)
  assert.equal(punchStatus(T, null), 'open')            // missing clock-out
  assert.equal(durationMinutes(T, null), null)          // open never counts
  assert.equal(punchStatus(T8, T), 'invalid')           // out precedes in
  assert.equal(durationMinutes(T8, T), null)
  assert.equal(punchStatus(null, T8), 'invalid')        // out with no in
  // overnight: 23:00 → 03:00 next day is a normal positive diff
  const nightIn = Date.UTC(2026, 2, 10, 23, 0, 0), nightOut = Date.UTC(2026, 2, 11, 3, 0, 0)
  assert.equal(durationMinutes(nightIn, nightOut), 240)
})

test('selectTimeEntries spans both lanes, filters, and skips never-punched crew', () => {
  const r = route({ assignees: [asg({ clockInAt: T, clockOutAt: T8 })] })
  const b = booking({ assignees: [asg({ staffId: 's2', name: 'Bo', clockInAt: T })] }) // open
  const idle = route({ token: 'rt2', routeNumber: 'R-2', assignees: [asg({ staffId: 's3', name: 'Cy' })] }) // never punched
  const entries = selectTimeEntries([r, idle], [b], {})
  assert.equal(entries.length, 2)                        // idle crew produces no entry
  assert.ok(entries.some(e => e.type === 'route' && e.status === 'complete'))
  assert.ok(entries.some(e => e.type === 'booking' && e.status === 'open'))
  // staff filter
  assert.equal(selectTimeEntries([r, idle], [b], { staffId: 's2' }).length, 1)
  // type filter
  assert.equal(selectTimeEntries([r], [b], { type: 'route' }).every(e => e.type === 'route'), true)
  // date window
  assert.equal(selectTimeEntries([r], [b], { start: '2026-03-11' }).length, 0)
})

test('rollups: payable totals count COMPLETE punches only; open/invalid surfaced not counted', () => {
  const entries = selectTimeEntries(
    [route({ assignees: [asg({ clockInAt: T, clockOutAt: T8 }), asg({ staffId: 's2', name: 'Bo', token: 'a2', clockInAt: T })] })],
    [], {},
  )
  assert.equal(periodTotalMinutes(entries), 480)        // only the complete 8h counts
  const rolled = rollupByStaff(entries)
  const bo = rolled.find(r => r.staffId === 's2')!
  assert.equal(bo.totalMinutes, 0)
  assert.equal(bo.openCount, 1)
  assert.equal(formatMinutes(480), '8h 0m')
})

// ── Authorization + registry pins ─────────────────────────────────────────────

test('time:view is admin+manager; time:manage is admin-only', () => {
  assert.equal(can('admin', 'time:view'), true)
  assert.equal(can('manager', 'time:view'), true)
  assert.equal(can('admin', 'time:manage'), true)
  assert.equal(can('manager', 'time:manage'), false)     // corrections are admin-only
  assert.equal(can('crew', 'time:view'), false)
  assert.ok(permissionsForRole('admin').includes('time:manage'))
})

test('time-tracking capability is full, spans both lanes, gated time:view', () => {
  const cap = CAPABILITY_REGISTRY['time-tracking']
  assert.equal(cap.status, 'full')
  assert.ok(cap.dependencies.includes('bookings' as never))
  assert.ok(cap.requiredPermissions.includes('time:view'))
})
