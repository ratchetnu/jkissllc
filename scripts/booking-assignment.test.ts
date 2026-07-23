// Sprint 1's payoff, proven at the seam: once a customer Booking carries real
// roster crew and real equipment, the SHIPPED conflict engine catches a crew
// member double-booked across a contract route and a moving job, and a truck used
// on both — with no change to conflicts.ts at all. Plus the guarantees that make
// that safe: legacy bookings project exactly as before, and the customer never
// sees a difference.
//
// Pure projection + conflict detection only — no Redis. The server orchestration
// (lib/booking-assignment) is exercised through its pure collaborators; its write
// path is CAS-protected by lib/booking-concurrency, which has its own suite.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking } from '../app/lib/bookings'
import type { RouteRecord, Assignee } from '../app/lib/routes'
import { bookingToScheduleItem, routeToScheduleItem, mergeSchedule } from '../app/lib/schedule/unified'
import { detectConflicts } from '../app/lib/schedule/conflicts'
import type { JobAssignee } from '../app/lib/job-assignment'
import { deriveLegacyCrewNames } from '../app/lib/job-assignment'

process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'

// ── factories ────────────────────────────────────────────────────────────────
let n = 5000
const booking = (o: Partial<Booking> = {}): Booking => ({
  token: (o.token ?? `bk${n++}`).padEnd(16, '0'),
  bookingNumber: o.bookingNumber ?? `JK-B-${n}`,
  customerName: 'Jane Doe',
  serviceType: 'moving',
  items: [],
  invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0,
  availableDates: [], availableWindows: [],
  status: 'confirmed',
  payments: [],
  source: 'online',
  createdAt: 1, updatedAt: 1,
  ...o,
} as Booking)

const route = (o: Partial<RouteRecord> = {}): RouteRecord => ({
  token: (o.token ?? `rt${n++}`).padEnd(16, '0'),
  routeNumber: o.routeNumber ?? `JK-R-${n}`,
  status: 'assigned',
  businessName: 'Amazon DSP',
  reportAddress: '1 Commerce St',
  reportTime: '8:00 AM',
  routeDate: '2026-07-20',
  events: [], audit: [],
  createdAt: 1, updatedAt: 1,
  ...o,
} as RouteRecord)

const crew = (staffId: string, o: Partial<JobAssignee> = {}): JobAssignee =>
  ({ staffId, name: o.name ?? staffId, token: `t_${staffId}`, ...o })

const routeCrew = (staffId: string, o: Partial<Assignee> = {}): Assignee =>
  ({ staffId, name: o.name ?? staffId, token: `rt_${staffId}`, ...o }) as Assignee

const typesOf = (cs: ReturnType<typeof detectConflicts>) => cs.map(c => c.type)

// ── THE payoff: cross-lane conflict detection ────────────────────────────────
test('a crew member double-booked across a route and a booking is caught by staffId', () => {
  const items = mergeSchedule({
    bookings: [booking({
      selectedDate: '2026-07-20', selectedWindow: '8am–10am',
      assignees: [crew('s1', { name: 'Marcus', role: 'Driver' })],
      vehicle: '26ft Box Truck #1',
    })],
    routes: [route({ routeDate: '2026-07-20', reportTime: '8:00 AM', assignees: [routeCrew('s1', { name: 'Marcus' })] })],
  })

  const conflicts = detectConflicts(items)
  assert.ok(typesOf(conflicts).includes('crew_overlap'),
    'the same person cannot be on a contract route and a moving job at 8am')
})

test('a truck used on a route and a booking the same morning is caught by equipmentId', () => {
  const items = mergeSchedule({
    bookings: [booking({
      selectedDate: '2026-07-20', selectedWindow: '8am–10am',
      assignees: [crew('s2', { name: 'Dre', role: 'Driver' })],
      equipmentId: 'eq_truck1', vehicle: '26ft Box Truck #1',
    })],
    routes: [route({
      routeDate: '2026-07-20', reportTime: '8:00 AM',
      assignees: [routeCrew('s9', { name: 'Tay' })],
      equipmentId: 'eq_truck1', vehicle: '26ft Box Truck #1',
    })],
  })

  const types = typesOf(detectConflicts(items))
  assert.ok(types.includes('equipment_overlap'), 'one truck cannot run two jobs at once')
  assert.ok(types.includes('vehicle_overlap'), 'and the vehicle label agrees')
})

test('different people on different trucks the same morning is not a conflict', () => {
  const items = mergeSchedule({
    bookings: [booking({
      selectedDate: '2026-07-20', selectedWindow: '8am–10am',
      assignees: [crew('s1', { name: 'Marcus', role: 'Driver' })],
      equipmentId: 'eq_truck1', vehicle: '26ft Box Truck #1',
    })],
    routes: [route({
      routeDate: '2026-07-20', reportTime: '8:00 AM',
      assignees: [routeCrew('s2', { name: 'Dre' })],
      equipmentId: 'eq_truck2', vehicle: '26ft Box Truck #2',
    })],
  })
  const types = typesOf(detectConflicts(items))
  assert.ok(!types.includes('crew_overlap'))
  assert.ok(!types.includes('equipment_overlap'))
})

// ── The booking projection ───────────────────────────────────────────────────
test('a roster-assigned booking projects real crew, staffIds, and equipment', () => {
  const it = bookingToScheduleItem(booking({
    selectedDate: '2026-07-20', selectedWindow: '8am–10am',
    assignees: [
      crew('s1', { name: 'Marcus', role: 'Driver', confirmedAt: 111 }),
      crew('s2', { name: 'Dre', role: 'Helper' }),
    ],
    equipmentId: 'eq_truck1', vehicle: '26ft Box Truck #1',
    crewSize: 2,
  }))

  assert.deepEqual(it.crew.map(c => c.staffId), ['s1', 's2'])
  assert.equal(it.crew[0].confirmed, true)
  assert.equal(it.crew[1].confirmed, false)
  assert.equal(it.vehicle, '26ft Box Truck #1')
  assert.equal(it.equipmentId, 'eq_truck1')
  assert.deepEqual(it.equipment, ['26ft Box Truck #1'])
  assert.equal(it.crewComplete, true)
})

test('declined crew do not project onto the schedule', () => {
  const it = bookingToScheduleItem(booking({
    selectedDate: '2026-07-20',
    assignees: [crew('s1', { name: 'Marcus', role: 'Driver' }), crew('s2', { name: 'Dre', declinedAt: 99 })],
  }))
  assert.deepEqual(it.crew.map(c => c.staffId), ['s1'])
})

test('a short-handed roster booking is flagged, a fully crewed one is not', () => {
  const short = bookingToScheduleItem(booking({
    status: 'confirmed', selectedDate: '2026-07-20', crewSize: 2,
    assignees: [crew('s1', { name: 'Marcus', role: 'Driver' })],
    vehicle: 'Truck',
  }))
  assert.ok(short.attention.includes('needs_helper'))
  assert.equal(short.crewComplete, false)

  const full = bookingToScheduleItem(booking({
    status: 'confirmed', selectedDate: '2026-07-20', crewSize: 2,
    assignees: [crew('s1', { name: 'Marcus', role: 'Driver' }), crew('s2', { name: 'Dre', role: 'Helper' })],
    vehicle: 'Truck',
  }))
  assert.ok(!full.attention.includes('needs_helper'))
  assert.equal(full.crewComplete, true)
})

test('a roster-assigned booking with no truck is flagged; one with a truck is not', () => {
  const noTruck = bookingToScheduleItem(booking({
    status: 'confirmed', selectedDate: '2026-07-20',
    assignees: [crew('s1', { name: 'Marcus', role: 'Driver' })],
  }))
  assert.ok(noTruck.attention.includes('no_vehicle'))

  const withTruck = bookingToScheduleItem(booking({
    status: 'confirmed', selectedDate: '2026-07-20',
    assignees: [crew('s1', { name: 'Marcus', role: 'Driver' })],
    equipmentId: 'eq_1', vehicle: 'Truck #1',
  }))
  assert.ok(!withTruck.attention.includes('no_vehicle'))
})

// ── Nothing about existing bookings changes ──────────────────────────────────
test('a legacy free-text booking projects exactly as it did before', () => {
  const it = bookingToScheduleItem(booking({
    status: 'confirmed', selectedDate: '2026-07-20',
    assignedTo: 'Marcus', assignedHelper: 'Dre',
  }))
  assert.deepEqual(it.crew, [
    { name: 'Marcus', role: 'Lead' },
    { name: 'Dre', role: 'Helper' },
  ])
  assert.equal(it.crewComplete, true)
  assert.equal(it.vehicle, undefined)
  assert.equal(it.equipmentId, undefined)
  assert.deepEqual(it.equipment, [])
})

test('a legacy booking gains no new warnings — no_vehicle never fires without roster crew', () => {
  const it = bookingToScheduleItem(booking({
    status: 'confirmed', selectedDate: '2026-07-20', assignedTo: 'Marcus',
  }))
  assert.ok(!it.attention.includes('no_vehicle'))
  assert.ok(!it.attention.includes('needs_helper'))
  assert.ok(!it.attention.includes('no_crew'))

  const conflicts = detectConflicts(mergeSchedule({ bookings: [booking({
    status: 'confirmed', selectedDate: '2026-07-20', assignedTo: 'Marcus',
  })], routes: [] }))
  assert.ok(!typesOf(conflicts).includes('missing_vehicle'),
    'work that predates the assignment model must not start warning')
})

test('an uncrewed confirmed booking still reports no_crew, exactly as before', () => {
  const it = bookingToScheduleItem(booking({ status: 'confirmed', selectedDate: '2026-07-20' }))
  assert.ok(it.attention.includes('no_crew'))
})

// ── The customer-facing guarantee, end to end ────────────────────────────────
test('the names derived for the customer match what an owner would have typed', () => {
  const assignees = [crew('s1', { name: 'Dre', role: 'Helper' }), crew('s2', { name: 'Marcus', role: 'Driver' })]
  const legacy = deriveLegacyCrewNames(assignees)

  // What the confirmation page will show.
  assert.deepEqual(legacy, { assignedTo: 'Marcus', assignedHelper: 'Dre' })

  // And a booking carrying BOTH the roster crew and those derived names projects
  // the roster — one source of truth, no drift between the two views.
  const it = bookingToScheduleItem(booking({
    selectedDate: '2026-07-20', assignees,
    assignedTo: legacy.assignedTo, assignedHelper: legacy.assignedHelper,
  }))
  assert.deepEqual(it.crew.map(c => c.name), ['Dre', 'Marcus'])
  assert.ok(it.crew.every(c => c.staffId))
})

// ── Regression: emptying a roster-managed crew must clear the customer's names ──
// Found by the Sprint 1 Preview validation. Removing the last roster crew member
// left `assignedTo` naming someone no longer on the job — visible to the customer
// on the confirmation page, and it also produced a phantom name-matched
// crew_overlap on the schedule because the projector fell back to the stale name.
test('an emptied roster crew derives NO customer-facing names', () => {
  // The array is present but empty = roster-managed with nobody on it.
  assert.deepEqual(deriveLegacyCrewNames([]), { assignedTo: undefined, assignedHelper: undefined })
})

test('a booking whose roster crew was emptied projects no crew and no phantom conflict', () => {
  // Mirrors the post-fix persisted shape: assignees === [] and the derived names
  // cleared, rather than assignees === undefined with a stale name left behind.
  const emptied = booking({
    status: 'confirmed', selectedDate: '2026-07-24', selectedWindow: '8am–10am',
    assignees: [], assignedTo: undefined, assignedHelper: undefined,
  })
  const it = bookingToScheduleItem(emptied)
  assert.deepEqual(it.crew, [], 'no crew chips at all')
  assert.ok(it.attention.includes('no_crew'))

  // And it must not collide with a route the same morning that DOES have crew.
  const items = mergeSchedule({
    bookings: [emptied],
    routes: [route({ routeDate: '2026-07-24', reportTime: '8:00 AM', assignees: [routeCrew('s1', { name: 'Marcus' })] })],
  })
  assert.ok(!typesOf(detectConflicts(items)).includes('crew_overlap'),
    'an un-crewed booking must not phantom-conflict via a stale derived name')
})

test('the stale-name shape that caused the bug would still be caught', () => {
  // If a regression ever re-introduces "empty assignees + leftover name", the
  // projector falls back to the legacy chip and a phantom conflict reappears.
  const stale = booking({
    status: 'confirmed', selectedDate: '2026-07-24', selectedWindow: '8am–10am',
    assignees: [], assignedTo: 'Marcus',
  })
  const items = mergeSchedule({
    bookings: [stale],
    routes: [route({ routeDate: '2026-07-24', reportTime: '8:00 AM', assignees: [routeCrew('s1', { name: 'Marcus' })] })],
  })
  assert.ok(typesOf(detectConflicts(items)).includes('crew_overlap'),
    'documents WHY the names must be cleared — a leftover name still matches by name')
})

// ── Route lane untouched ─────────────────────────────────────────────────────
test('the route projection is unchanged by any of this', () => {
  const it = routeToScheduleItem(route({
    routeDate: '2026-07-20',
    assignees: [routeCrew('s1', { name: 'Marcus', role: 'Driver', confirmedAt: 5 })],
    vehicle: '26ft Box Truck #1', equipmentId: 'eq_truck1',
  }))
  assert.deepEqual(it.crew, [{ name: 'Marcus', staffId: 's1', role: 'Driver', confirmed: true }])
  assert.equal(it.vehicle, '26ft Box Truck #1')
  assert.equal(it.equipmentId, 'eq_truck1')
  assert.equal(it.crewComplete, true)
})
