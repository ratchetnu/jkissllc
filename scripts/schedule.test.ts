// Unified Operations schedule — projection + conflict detection. Pure functions,
// no Redis, no AI. Proves Book Now + manual + route work merge into one schedule,
// source badges are correct, lanes separate pending from confirmed, rescheduling
// moves the canonical job, cancellation preserves the record, and crew/vehicle/
// equipment conflicts are detected deterministically.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { Booking, BookingStatus, ServiceType } from '../app/lib/bookings'
import type { RouteRecord, Assignee, RouteStatus } from '../app/lib/routes'
import {
  bookingToScheduleItem, routeToScheduleItem, mergeSchedule,
  itemsForDay, itemsInRange, unscheduledItems, pendingItems, scheduleCounts,
  parseTimeToMinutes, itemDay,
} from '../app/lib/schedule/unified'
import { detectConflicts, conflictsByItem, summarizeConflicts } from '../app/lib/schedule/conflicts'

// ── factories ────────────────────────────────────────────────────────────────
let n = 1000
const booking = (o: Partial<Booking> = {}): Booking => ({
  token: (o.token ?? `bk${n++}`).padEnd(16, '0'),
  bookingNumber: o.bookingNumber ?? `JK-B-${n}`,
  customerName: 'Jane Doe',
  serviceType: 'junk-removal',
  items: [],
  invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0,
  availableDates: [], availableWindows: [],
  status: 'quote_received',
  payments: [],
  source: 'online',
  createdAt: 1, updatedAt: 1,
  ...o,
} as Booking)

const assignee = (o: Partial<Assignee> & { staffId: string }): Assignee =>
  ({ name: o.staffId, token: `t_${o.staffId}`, ...o }) as Assignee

const route = (o: Partial<RouteRecord> = {}): RouteRecord => ({
  token: (o.token ?? `rt${n++}`).padEnd(16, '0'),
  routeNumber: o.routeNumber ?? `JK-R-${n}`,
  status: 'assigned',
  businessName: 'Amazon DSP',
  reportAddress: '1 Commerce St',
  reportTime: '7:00 AM',
  routeDate: '2026-07-20',
  events: [], audit: [],
  createdAt: 1, updatedAt: 1,
  ...o,
} as RouteRecord)

// ── time parsing ─────────────────────────────────────────────────────────────
test('parseTimeToMinutes handles am/pm, 24h, ranges, and junk', () => {
  assert.equal(parseTimeToMinutes('8am'), 8 * 60)
  assert.equal(parseTimeToMinutes('8:30 AM'), 8 * 60 + 30)
  assert.equal(parseTimeToMinutes('12:00 PM'), 12 * 60)
  assert.equal(parseTimeToMinutes('12:00 AM'), 0)
  assert.equal(parseTimeToMinutes('7:00 AM'), 7 * 60)
  assert.equal(parseTimeToMinutes('10am–12pm'), 10 * 60) // first token
  assert.equal(parseTimeToMinutes('13:15'), 13 * 60 + 15)
  assert.equal(parseTimeToMinutes('whenever'), null)
  assert.equal(parseTimeToMinutes(undefined), null)
})

// ── source badges ────────────────────────────────────────────────────────────
test('source badges map correctly across all four sources', () => {
  assert.equal(bookingToScheduleItem(booking({ source: 'online' })).source, 'BOOK_NOW')
  assert.equal(bookingToScheduleItem(booking({ source: 'admin' })).source, 'MANUAL')
  assert.equal(routeToScheduleItem(route({ templateId: undefined })).source, 'CONTRACT_ROUTE')
  assert.equal(routeToScheduleItem(route({ templateId: 'tpl_1' })).source, 'RECURRING_ROUTE')
})

// ── one canonical job per record; links preserved ────────────────────────────
test('an accepted Book Now request projects to exactly one canonical job that links back to the record', () => {
  const b = booking({
    token: 'abc123abc123abc1', bookingNumber: 'JK-B-2001',
    status: 'confirmed', selectedDate: '2026-07-20', selectedWindow: '8am–10am',
    invoiceAmountCents: 40000, amountPaidCents: 20000, depositAmountCents: 20000,
    invoicePhotos: [{ url: 'https://blob/x.jpg' }],
  })
  const items = mergeSchedule({ bookings: [b] })
  assert.equal(items.length, 1)
  const it = items[0]
  assert.equal(it.id, 'booking:abc123abc123abc1')
  assert.equal(it.sourceRecordId, b.token)
  // Cross-nav to the source record (which owns photos, AI, quote history).
  assert.equal(it.href, `/admin/operations/book-now/${b.token}`)
  assert.equal(it.date, '2026-07-20')
  assert.equal(it.lane, 'confirmed')
})

// ── pending vs confirmed ─────────────────────────────────────────────────────
test('unconfirmed intake is pending, not confirmed work', () => {
  const pendingStatuses: BookingStatus[] = [
    'quote_received', 'pending_payment', 'payment_received', 'time_verified',
  ]
  for (const s of pendingStatuses) {
    assert.equal(bookingToScheduleItem(booking({ status: s })).lane, 'pending', s)
  }
  const confirmedStatuses: BookingStatus[] = ['booking_created', 'confirmed', 'in_progress', 'completed']
  for (const s of confirmedStatuses) {
    assert.equal(bookingToScheduleItem(booking({ status: s })).lane, 'confirmed', s)
  }
})

test('a quote request with a preferred date is tentative, not scheduled', () => {
  const it = bookingToScheduleItem(booking({
    status: 'quote_received', bookNow: { requestedDate: '2026-07-20' },
  }))
  assert.equal(it.scheduled, false)
  assert.equal(it.tentative, true)
  assert.equal(itemDay(it), '2026-07-20') // shows on that day as a tentative request
  assert.equal(it.lane, 'pending')
})

// ── everything on one day ────────────────────────────────────────────────────
test('Book Now, manual, contract-route and recurring-route work all appear in the same day view', () => {
  const day = '2026-07-20'
  const items = mergeSchedule({
    bookings: [
      booking({ source: 'online', status: 'confirmed', selectedDate: day, selectedWindow: '9am', customerName: 'Booknow Cust' }),
      booking({ source: 'admin', status: 'confirmed', selectedDate: day, selectedWindow: '11am', customerName: 'Manual Cust' }),
    ],
    routes: [
      route({ templateId: undefined, routeDate: day, reportTime: '7:00 AM', businessName: 'Contract Co' }),
      route({ templateId: 'tpl_1', routeDate: day, reportTime: '8:00 AM', businessName: 'Recurring Co' }),
    ],
  })
  const dayItems = itemsForDay(items, day)
  assert.equal(dayItems.length, 4)
  // Chronological: 7:00, 8:00, 9:00, 11:00
  assert.deepEqual(dayItems.map(i => i.source), ['CONTRACT_ROUTE', 'RECURRING_ROUTE', 'BOOK_NOW', 'MANUAL'])
  // Default day view needs no Book Now filter to show all sources.
  const sources = new Set(dayItems.map(i => i.source))
  assert.ok(sources.has('BOOK_NOW') && sources.has('CONTRACT_ROUTE'))
})

test('itemsInRange returns a week ordered by day then time', () => {
  const items = mergeSchedule({
    routes: [
      route({ routeDate: '2026-07-22', reportTime: '9:00 AM' }),
      route({ routeDate: '2026-07-20', reportTime: '10:00 AM' }),
      route({ routeDate: '2026-07-20', reportTime: '7:00 AM' }),
    ],
  })
  const week = itemsInRange(items, '2026-07-20', '2026-07-26')
  assert.deepEqual(week.map(i => `${itemDay(i)} ${i.timeLabel}`), [
    '2026-07-20 7:00 AM', '2026-07-20 10:00 AM', '2026-07-22 9:00 AM',
  ])
})

// ── rescheduling + cancellation ──────────────────────────────────────────────
test('rescheduling a booking moves the canonical schedule item to the new day', () => {
  const before = bookingToScheduleItem(booking({ status: 'confirmed', selectedDate: '2026-07-20' }))
  const after = bookingToScheduleItem(booking({ status: 'confirmed', selectedDate: '2026-07-27' }))
  assert.equal(before.date, '2026-07-20')
  assert.equal(after.date, '2026-07-27')
})

test('a continued job schedules on its return date', () => {
  const it = bookingToScheduleItem(booking({
    status: 'continued', selectedDate: '2026-07-20',
    continuation: { continuedAt: 1, returnDate: '2026-07-25', returnWindow: '1pm' },
  }))
  assert.equal(it.date, '2026-07-25')
  assert.equal(it.timeLabel, '1pm')
})

test('cancellation preserves the record and flags it without dropping history', () => {
  const it = bookingToScheduleItem(booking({ status: 'cancelled', selectedDate: '2026-07-20', bookingNumber: 'JK-B-9' }))
  assert.equal(it.cancelled, true)
  assert.equal(it.number, 'JK-B-9')          // still projects — history is not destroyed
  assert.ok(!pendingItems([it]).includes(it)) // excluded from the pending lane
})

// ── unscheduled + counts ─────────────────────────────────────────────────────
test('unscheduled confirmed work is surfaced; counts exclude cancelled', () => {
  const items = mergeSchedule({
    bookings: [
      booking({ status: 'confirmed', selectedDate: '2026-07-20' }),          // confirmed, scheduled
      booking({ status: 'confirmed' }),                                       // confirmed, NO date → unscheduled
      booking({ status: 'quote_received' }),                                  // pending
      booking({ status: 'cancelled', selectedDate: '2026-07-20' }),           // cancelled
    ],
  })
  assert.equal(unscheduledItems(items).length, 1)
  const c = scheduleCounts(items)
  assert.equal(c.cancelled, 1)
  assert.equal(c.pending, 1)
  assert.equal(c.total, 3) // cancelled excluded from the live total
})

// ── conflicts: crew ──────────────────────────────────────────────────────────
test('crew double-booked across two routes at overlapping times is an error', () => {
  const day = '2026-07-20'
  const conflicts = detectConflicts(mergeSchedule({
    routes: [
      route({ token: 'r1'.padEnd(16, '0'), routeNumber: 'JK-R-1', routeDate: day, reportTime: '7:00 AM',
        reportAddress: 'A St', assignees: [assignee({ staffId: 's1', name: 'Sam' })] }),
      route({ token: 'r2'.padEnd(16, '0'), routeNumber: 'JK-R-2', routeDate: day, reportTime: '7:30 AM',
        reportAddress: 'B St', assignees: [assignee({ staffId: 's1', name: 'Sam' })] }),
    ],
  }))
  const crew = conflicts.filter(c => c.type === 'crew_overlap')
  assert.equal(crew.length, 1)
  assert.equal(crew[0].severity, 'error')
  assert.equal(crew[0].resource, 'Sam')
})

test('same crew member on a route AND a booking the same overlapping time is caught by name', () => {
  const day = '2026-07-20'
  const conflicts = detectConflicts(mergeSchedule({
    bookings: [booking({ status: 'confirmed', selectedDate: day, selectedWindow: '7:00 AM',
      jobSiteAddress: 'C St', assignedTo: 'Sam' })],
    routes: [route({ routeDate: day, reportTime: '7:15 AM', reportAddress: 'D St',
      assignees: [assignee({ staffId: 's1', name: 'Sam' })] })],
  }))
  assert.ok(conflicts.some(c => c.type === 'crew_overlap' && c.resource === 'Sam'))
})

test('same crew, far-apart times at different addresses is a travel-time warning, not an overlap', () => {
  const day = '2026-07-20'
  const conflicts = detectConflicts(mergeSchedule({
    routes: [
      route({ routeDate: day, reportTime: '7:00 AM', reportAddress: 'A St', assignees: [assignee({ staffId: 's1', name: 'Sam' })] }),
      route({ routeDate: day, reportTime: '9:30 AM', reportAddress: 'B St', assignees: [assignee({ staffId: 's1', name: 'Sam' })] }),
    ],
  }))
  assert.equal(conflicts.filter(c => c.type === 'crew_overlap').length, 0)
  assert.equal(conflicts.filter(c => c.type === 'travel_time').length, 1)
  assert.equal(conflicts.find(c => c.type === 'travel_time')!.severity, 'warning')
})

test('same crew at the SAME address is not a conflict (sequential loads)', () => {
  const day = '2026-07-20'
  const conflicts = detectConflicts(mergeSchedule({
    routes: [
      route({ routeDate: day, reportTime: '7:00 AM', reportAddress: 'Same St', assignees: [assignee({ staffId: 's1', name: 'Sam' })] }),
      route({ routeDate: day, reportTime: '7:15 AM', reportAddress: 'Same St', assignees: [assignee({ staffId: 's1', name: 'Sam' })] }),
    ],
  }))
  assert.equal(conflicts.filter(c => c.type === 'crew_overlap').length, 0)
})

// ── conflicts: vehicle + equipment ───────────────────────────────────────────
test('vehicle double-booked at overlapping times is an error', () => {
  const day = '2026-07-20'
  const conflicts = detectConflicts(mergeSchedule({
    routes: [
      route({ routeDate: day, reportTime: '7:00 AM', reportAddress: 'A', vehicle: '26ft Box', assignees: [assignee({ staffId: 's1', name: 'Sam' })] }),
      route({ routeDate: day, reportTime: '7:30 AM', reportAddress: 'B', vehicle: '26ft Box', assignees: [assignee({ staffId: 's2', name: 'Pat' })] }),
    ],
  }))
  assert.equal(conflicts.filter(c => c.type === 'vehicle_overlap').length, 1)
})

test('equipment double-booked by roster id at overlapping times is an error', () => {
  const day = '2026-07-20'
  const conflicts = detectConflicts(mergeSchedule({
    routes: [
      route({ routeDate: day, reportTime: '7:00 AM', reportAddress: 'A', equipmentId: 'eq_1', vehicle: 'Truck 1', assignees: [assignee({ staffId: 's1', name: 'Sam' })] }),
      route({ routeDate: day, reportTime: '8:00 AM', reportAddress: 'B', equipmentId: 'eq_1', vehicle: 'Truck 1', assignees: [assignee({ staffId: 's2', name: 'Pat' })] }),
    ],
  }))
  assert.equal(conflicts.filter(c => c.type === 'equipment_overlap').length, 1)
})

// ── conflicts: structural ────────────────────────────────────────────────────
test('accepted-but-unscheduled and missing-crew are reported', () => {
  const conflicts = detectConflicts(mergeSchedule({
    bookings: [
      booking({ status: 'payment_received' }),                                     // accepted, no date
      booking({ status: 'confirmed', selectedDate: '2026-07-20' }),                // confirmed, no crew
    ],
  }))
  assert.ok(conflicts.some(c => c.type === 'accepted_not_scheduled'))
  assert.ok(conflicts.some(c => c.type === 'missing_crew'))
})

test('a hard-dated booking still in a pending status is flagged unlinked', () => {
  const conflicts = detectConflicts([bookingToScheduleItem(booking({ status: 'quote_received', selectedDate: '2026-07-20' }))])
  assert.ok(conflicts.some(c => c.type === 'unlinked_schedule'))
})

test('duplicate canonical jobs (same customer, day, service) are flagged', () => {
  const day = '2026-07-20'
  const conflicts = detectConflicts(mergeSchedule({
    bookings: [
      booking({ token: 'd1'.padEnd(16, '0'), bookingNumber: 'JK-B-1', customerName: 'Repeat Guy', serviceType: 'moving', status: 'confirmed', selectedDate: day }),
      booking({ token: 'd2'.padEnd(16, '0'), bookingNumber: 'JK-B-2', customerName: 'Repeat Guy', serviceType: 'moving', status: 'confirmed', selectedDate: day }),
    ],
  }))
  const dup = conflicts.filter(c => c.type === 'duplicate_job')
  assert.equal(dup.length, 1)
  assert.equal(dup[0].itemIds.length, 2)
})

test('conflictsByItem and summarize aggregate correctly', () => {
  const day = '2026-07-20'
  const items = mergeSchedule({
    routes: [
      route({ token: 'a'.padEnd(16, '0'), routeNumber: 'JK-R-1', routeDate: day, reportTime: '7:00 AM', reportAddress: 'A', assignees: [assignee({ staffId: 's1', name: 'Sam' })] }),
      route({ token: 'b'.padEnd(16, '0'), routeNumber: 'JK-R-2', routeDate: day, reportTime: '7:15 AM', reportAddress: 'B', assignees: [assignee({ staffId: 's1', name: 'Sam' })] }),
    ],
  })
  const conflicts = detectConflicts(items)
  const byItem = conflictsByItem(conflicts)
  assert.ok(byItem.get('route:' + 'a'.padEnd(16, '0'))!.length >= 1)
  const s = summarizeConflicts(conflicts)
  assert.equal(s.total, conflicts.length)
  assert.equal(s.errors + s.warnings, conflicts.length)
})

// ── no AI on the scheduling path (Phase 11 hard requirement) ─────────────────
test('the schedule projection + conflict modules make ZERO AI calls (static guard)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const f of ['unified.ts', 'conflicts.ts']) {
    const src = readFileSync(join(here, '..', 'app', 'lib', 'schedule', f), 'utf8')
    assert.ok(!/from ['"].*\/ai(\/|['"])/.test(src), `${f} must not import the AI layer`)
    assert.ok(!/generateText|streamText|runAiTask|gateway|openai|anthropic/i.test(src), `${f} must not call a model`)
    assert.ok(!/\bfetch\s*\(/.test(src), `${f} must not perform network I/O`)
  }
})
