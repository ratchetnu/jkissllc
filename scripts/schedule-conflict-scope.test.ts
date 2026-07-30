// ─────────────────────────────────────────────────────────────────────────────
// Schedule conflict scoping + stale-route auto-cancellation.
//
// Three behaviours, one suite because they share fixtures:
//   1. Conflicts before the day being VIEWED are not shown (and nothing is mutated
//      to achieve that — it is a display filter, full stop).
//   2. The missing-vehicle conflict is an EXPLICIT per-route requirement, not an
//      assumption about every route, and the same predicate blocks Confirm.
//   3. A committed route dated today with nobody on it is eligible for automatic
//      cancellation at 00:00 America/Chicago — not before, not for other days, and
//      never for a route that has crew.
//
// The Central-time logic is the part most likely to be wrong in a way nobody
// notices until March, so the DST boundaries are pinned with real UTC instants.
// ─────────────────────────────────────────────────────────────────────────────
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test from 'node:test'

import type { Booking } from '../app/lib/bookings'
import type { RouteRecord, Assignee } from '../app/lib/routes'
import {
  needsVehicleAssignment, hasVehicleOrEquipment, VEHICLE_REQUIRED_MESSAGE,
  isDispatchReady, autoCancelRoute, syncLead, rollupStatus, SYSTEM_AUTO_CANCEL_PRINCIPAL,
} from '../app/lib/routes'
import { routeToScheduleItem, mergeSchedule, itemsFrom, scheduleCounts } from '../app/lib/schedule/unified'
import { detectConflicts, filterConflictsFrom, summarizeConflicts, type Conflict } from '../app/lib/schedule/conflicts'
import {
  selectAutoCancelCandidates, isCancellationWindow, centralDate, centralHour, centralStamp,
  isLiveRoute, hasNoCrew, autoCancelAuditNote, OPS_TIMEZONE, CANCELLATION_GRACE_HOURS,
} from '../app/lib/schedule/auto-cancel'
import { isEnabled, FLAG_DEFAULTS } from '../app/lib/platform/flags'

// ── factories ────────────────────────────────────────────────────────────────
let n = 5000
const assignee = (o: Partial<Assignee> & { staffId: string }): Assignee =>
  ({ name: o.staffId, token: `t_${o.staffId}`, ...o }) as Assignee

const route = (o: Partial<RouteRecord> = {}): RouteRecord => ({
  token: (o.token ?? `rt${n++}`).padEnd(16, '0'),
  routeNumber: o.routeNumber ?? `JK-R-${n}`,
  status: 'assigned',
  businessName: 'JW Logistics',
  reportAddress: '1 Commerce St',
  reportTime: '7:00 AM',
  routeDate: '2026-07-20',
  events: [], audit: [],
  createdAt: 1, updatedAt: 1,
  ...o,
} as RouteRecord)

const booking = (o: Partial<Booking> = {}): Booking => ({
  token: (o.token ?? `bk${n++}`).padEnd(16, '0'),
  bookingNumber: o.bookingNumber ?? `JK-B-${n}`,
  customerName: 'Jane Doe', serviceType: 'junk-removal', items: [],
  invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0,
  availableDates: [], availableWindows: [], status: 'quote_received',
  payments: [], source: 'online', createdAt: 1, updatedAt: 1,
  ...o,
} as Booking)

const conflict = (o: Partial<Conflict> = {}): Conflict => ({
  type: 'missing_crew', severity: 'warning', message: 'x', itemIds: ['route:a'], ...o,
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. PAST-CONFLICT FILTERING
// ─────────────────────────────────────────────────────────────────────────────

test('conflicts before the viewed day are hidden; the viewed day itself is kept', () => {
  const list = [
    conflict({ day: '2026-07-10' }), conflict({ day: '2026-07-27' }),
    conflict({ day: '2026-07-29' }), conflict({ day: '2026-07-30' }),
  ]
  const kept = filterConflictsFrom(list, '2026-07-29')
  assert.deepEqual(kept.map(c => c.day), ['2026-07-29', '2026-07-30'],
    'the viewed day is inclusive; strictly-earlier days drop')
})

test('the exact screenshot case: viewing 07-29 hides six 07-10..07-27 warnings', () => {
  const stale = ['2026-07-10', '2026-07-15', '2026-07-20', '2026-07-22', '2026-07-24', '2026-07-27']
    .map(day => conflict({ type: 'missing_vehicle', day }))
  const dup = conflict({ type: 'duplicate_job', day: '2026-07-08' })
  const visible = filterConflictsFrom([...stale, dup], '2026-07-29')
  assert.equal(visible.length, 0, 'nothing from before the viewed day survives')
})

test('UNDATED conflicts always survive — they are nowhere, not in the past', () => {
  // accepted_not_scheduled has no `day` by design: that IS the conflict.
  const undated = conflict({ type: 'accepted_not_scheduled', day: undefined })
  assert.deepEqual(filterConflictsFrom([undated], '2026-07-29'), [undated])
  assert.deepEqual(filterConflictsFrom([undated], '2099-01-01'), [undated])
})

test('an absent reference day disables filtering rather than hiding everything', () => {
  const list = [conflict({ day: '2020-01-01' })]
  assert.deepEqual(filterConflictsFrom(list, undefined), list)
  assert.deepEqual(filterConflictsFrom(list, ''), list)
})

test('selected-day behaviour: moving the viewed day changes what is visible', () => {
  const list = [conflict({ day: '2026-07-20' }), conflict({ day: '2026-07-25' })]
  assert.equal(filterConflictsFrom(list, '2026-07-01').length, 2, 'viewing earlier shows both')
  assert.equal(filterConflictsFrom(list, '2026-07-21').length, 1, 'viewing between shows the later')
  assert.equal(filterConflictsFrom(list, '2026-07-26').length, 0, 'viewing after shows neither')
})

test('the counts tile and the banner are computed from the SAME filtered set', () => {
  // The defect this prevents: a tile reading 7 above a list showing 1.
  const list = [
    conflict({ day: '2026-07-10', severity: 'warning' }),
    conflict({ day: '2026-07-29', severity: 'warning' }),
    conflict({ day: '2026-07-30', severity: 'error' }),
  ]
  const visible = filterConflictsFrom(list, '2026-07-29')
  const summary = summarizeConflicts(visible)
  assert.equal(summary.total, visible.length, 'tile total === rows rendered')
  assert.equal(summary.total, 2)
  assert.equal(summary.errors, 1)
  assert.equal(summary.warnings, 1)
})

test('filtering is a pure display concern — it never mutates the input', () => {
  const list = [conflict({ day: '2020-01-01' }), conflict({ day: '2099-01-01' })]
  const before = JSON.stringify(list)
  filterConflictsFrom(list, '2026-07-29')
  assert.equal(JSON.stringify(list), before, 'no historical record is touched')
})

test('detectConflicts itself stays clock-free — same input, same output, always', () => {
  const items = [routeToScheduleItem(route({ status: 'assigned', routeDate: '2020-01-01' }))]
  assert.deepEqual(detectConflicts(items), detectConflicts(items))
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. VEHICLE / EQUIPMENT IS AN EXPLICIT RULE
// ─────────────────────────────────────────────────────────────────────────────

const crewed = (o: Partial<RouteRecord> = {}) => route({
  status: 'assigned', routeDate: '2026-07-20',
  assignees: [assignee({ staffId: 's1', name: 'Alex', role: 'driver' })],
  ...o,
})

test('a route that never opted in is NEVER reported as missing a vehicle', () => {
  const item = routeToScheduleItem(crewed())
  assert.equal(item.requiresVehicle, false)
  assert.ok(!detectConflicts([item]).some(c => c.type === 'missing_vehicle'),
    'legacy routes and crew-own-equipment routes must not be nagged')
})

test('an opted-in route with neither vehicle nor equipment IS reported', () => {
  const item = routeToScheduleItem(crewed({ requiresVehicle: true }))
  assert.equal(item.requiresVehicle, true)
  assert.ok(detectConflicts([item]).some(c => c.type === 'missing_vehicle'))
})

test('either a vehicle OR an equipment asset satisfies the requirement', () => {
  for (const sat of [{ vehicle: 'Truck 1' }, { equipmentId: 'eq_9' }]) {
    const item = routeToScheduleItem(crewed({ requiresVehicle: true, ...sat }))
    assert.ok(!detectConflicts([item]).some(c => c.type === 'missing_vehicle'),
      `${JSON.stringify(sat)} should satisfy the rule`)
  }
})

test('bookings are never subject to the route-level vehicle rule', () => {
  const items = mergeSchedule({ bookings: [], routes: [crewed({ requiresVehicle: true })] })
  assert.ok(items.every(it => it.kind !== 'booking'))
  // and a merged schedule with only non-opted-in routes yields no vehicle conflicts
  const plain = mergeSchedule({ bookings: [], routes: [crewed()] })
  assert.ok(!detectConflicts(plain).some(c => c.type === 'missing_vehicle'))
})

test('needsVehicleAssignment is the ONE predicate — conflict and block agree', () => {
  assert.equal(needsVehicleAssignment({ requiresVehicle: true }), true)
  assert.equal(needsVehicleAssignment({ requiresVehicle: true, vehicle: 'Truck 1' }), false)
  assert.equal(needsVehicleAssignment({ requiresVehicle: true, equipmentId: 'eq_1' }), false)
  assert.equal(needsVehicleAssignment({ requiresVehicle: false }), false)
  assert.equal(needsVehicleAssignment({}), false, 'absent means not required')
  // whitespace is not an assignment
  assert.equal(needsVehicleAssignment({ requiresVehicle: true, vehicle: '   ' }), true)
  assert.equal(hasVehicleOrEquipment({ vehicle: '  ' }), false)
})

test('the confirm-block message names the fix, not the rule', () => {
  assert.match(VEHICLE_REQUIRED_MESSAGE, /vehicle or equipment/i)
  assert.match(VEHICLE_REQUIRED_MESSAGE, /before confirming/i)
})

test('duplicate-route warnings are unaffected by the vehicle change', () => {
  const day = '2026-07-08'
  const items = mergeSchedule({
    bookings: [],
    routes: [
      route({ token: 'dupa'.padEnd(16, '0'), routeNumber: 'JK-R-1001', businessName: 'Best Buy Warehouse (Lancaster)', routeDate: day }),
      route({ token: 'dupb'.padEnd(16, '0'), routeNumber: 'JK-R-1002', businessName: 'Best Buy Warehouse (Lancaster)', routeDate: day }),
    ],
  })
  const dups = detectConflicts(items).filter(c => c.type === 'duplicate_job')
  assert.equal(dups.length, 1, 'the duplicate warning still fires')
  assert.equal(dups[0].day, day)
  // ...and it survives filtering when the viewed day is on or before it.
  assert.equal(filterConflictsFrom(dups, day).length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. CENTRAL-TIME BOUNDARIES + DST
// ─────────────────────────────────────────────────────────────────────────────

test('centralDate/centralHour follow America/Chicago, not UTC', () => {
  // 2026-07-29T04:30:00Z is 23:30 on 07-28 Central (CDT, UTC-5).
  assert.equal(centralDate(Date.parse('2026-07-29T04:30:00Z')), '2026-07-28')
  assert.equal(centralHour(Date.parse('2026-07-29T04:30:00Z')), 23)
  // 05:00Z the same night is exactly midnight Central → the new day.
  assert.equal(centralDate(Date.parse('2026-07-29T05:00:00Z')), '2026-07-29')
  assert.equal(centralHour(Date.parse('2026-07-29T05:00:00Z')), 0)
})

test('DST: in SUMMER (CDT, UTC-5) 05:00Z is midnight and 06:00Z is the grace retry', () => {
  assert.equal(isCancellationWindow(Date.parse('2026-07-29T05:00:00Z')), true, '00:00 CDT')
  assert.equal(isCancellationWindow(Date.parse('2026-07-29T06:00:00Z')), true, '01:00 CDT — inside the grace window')
  // Both are the SAME Central date, so the retry can only ever re-attempt today.
  assert.equal(centralDate(Date.parse('2026-07-29T05:00:00Z')), '2026-07-29')
  assert.equal(centralDate(Date.parse('2026-07-29T06:00:00Z')), '2026-07-29')
})

test('DST: in WINTER (CST, UTC-6) 06:00Z is midnight and 05:00Z is the PREVIOUS day', () => {
  assert.equal(isCancellationWindow(Date.parse('2026-01-15T06:00:00Z')), true, '00:00 CST')
  assert.equal(isCancellationWindow(Date.parse('2026-01-15T05:00:00Z')), false, 'that is 23:00 the previous day')
  assert.equal(centralDate(Date.parse('2026-01-15T05:00:00Z')), '2026-01-14')
})

test('every day of the year has at least one write window across both UTC firings', () => {
  const days: string[] = []
  for (let d = new Date(Date.UTC(2026, 0, 1)); d < new Date(Date.UTC(2027, 0, 1)); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10))
  }
  const dead = days.filter(day =>
    !['05', '06'].some(h => isCancellationWindow(Date.parse(`${day}T${h}:00:00Z`))))
  assert.deepEqual(dead, [], `every day needs a window; dead days: ${dead.join(',')}`)
})

test('the spring-forward and fall-back weekends still have a window', () => {
  // US DST 2026: forward Sun Mar 8, back Sun Nov 1.
  for (const day of ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02']) {
    const hits = ['05', '06'].filter(h => isCancellationWindow(Date.parse(`${day}T${h}:00:00Z`)))
    assert.ok(hits.length >= 1, `${day} produced no window`)
  }
})

test('GRACE WINDOW: midnight through the grace period writes; after it does not', () => {
  assert.equal(CANCELLATION_GRACE_HOURS, 3)
  assert.equal(isCancellationWindow(Date.parse('2026-07-29T05:00:00Z')), true, '00:00 CDT')
  assert.equal(isCancellationWindow(Date.parse('2026-07-29T06:00:00Z')), true, '01:00 CDT — the retry')
  assert.equal(isCancellationWindow(Date.parse('2026-07-29T07:00:00Z')), true, '02:00 CDT')
  assert.equal(isCancellationWindow(Date.parse('2026-07-29T08:00:00Z')), false, '03:00 CDT — closed')
})

test('GRACE WINDOW can never reach back into history', () => {
  // Eligibility is pinned to routeDate === today Central, so a 02:00 retry sees only
  // today's routes no matter how wide the window gets.
  const late = Date.parse('2026-07-29T07:00:00Z') // 02:00 CDT on 07-29
  assert.equal(centralDate(late), '2026-07-29')
  const yesterday = route({ routeDate: '2026-07-28', status: 'assigned', assignees: [] })
  assert.deepEqual(selectAutoCancelCandidates([yesterday], late), [], 'yesterday is never swept')
})

test('midday is never a write window', () => {
  assert.equal(isCancellationWindow(Date.parse('2026-07-29T18:00:00Z')), false)
  assert.equal(OPS_TIMEZONE, 'America/Chicago')
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. AUTO-CANCEL SELECTION
// ─────────────────────────────────────────────────────────────────────────────

const MIDNIGHT_JUL29 = Date.parse('2026-07-29T05:00:00Z') // 00:00 CDT on 2026-07-29

test('a committed route dated TODAY with no crew is a candidate', () => {
  const r = route({ routeDate: '2026-07-29', status: 'assigned', assignees: [] })
  const got = selectAutoCancelCandidates([r], MIDNIGHT_JUL29)
  assert.equal(got.length, 1)
  assert.equal(got[0].routeNumber, r.routeNumber)
  assert.equal(got[0].reason, 'no_crew_at_route_day_start')
  assert.match(got[0].detail, /No crew assigned as of 00:00 America\/Chicago on 2026-07-29/)
})

test('a route WITH crew is never a candidate, whatever else is missing', () => {
  const r = route({
    routeDate: '2026-07-29', status: 'assigned', requiresVehicle: true,
    assignees: [assignee({ staffId: 's1' })],
  })
  assert.deepEqual(selectAutoCancelCandidates([r], MIDNIGHT_JUL29), [],
    'missing a vehicle is a warning; missing a person is the rule')
})

test('FUTURE routes are never cancelled early', () => {
  for (const d of ['2026-07-30', '2026-08-15', '2027-01-01']) {
    const r = route({ routeDate: d, status: 'assigned', assignees: [] })
    assert.deepEqual(selectAutoCancelCandidates([r], MIDNIGHT_JUL29), [], `${d} must be left alone`)
  }
})

test('PAST routes are never touched — history is not re-litigated', () => {
  for (const d of ['2026-07-28', '2026-07-10', '2025-01-01']) {
    const r = route({ routeDate: d, status: 'assigned', assignees: [] })
    assert.deepEqual(selectAutoCancelCandidates([r], MIDNIGHT_JUL29), [], `${d} must be left alone`)
  }
})

test('drafts are not committed work and are left alone', () => {
  const r = route({ routeDate: '2026-07-29', status: 'draft', assignees: [] })
  assert.deepEqual(selectAutoCancelCandidates([r], MIDNIGHT_JUL29), [])
})

test('already-closed routes are skipped (cancelled / completed / no_show)', () => {
  for (const status of ['cancelled', 'completed', 'no_show'] as const) {
    const r = route({ routeDate: '2026-07-29', status, assignees: [] })
    assert.deepEqual(selectAutoCancelCandidates([r], MIDNIGHT_JUL29), [], `${status} must be skipped`)
    assert.equal(isLiveRoute(r), false)
  }
})

test('selection is deterministic and stably ordered — retries match exactly', () => {
  const rs = [
    route({ routeNumber: 'JK-R-1030', routeDate: '2026-07-29', assignees: [] }),
    route({ routeNumber: 'JK-R-1017', routeDate: '2026-07-29', assignees: [] }),
    route({ routeNumber: 'JK-R-1025', routeDate: '2026-07-29', assignees: [] }),
  ]
  const a = selectAutoCancelCandidates(rs, MIDNIGHT_JUL29)
  const b = selectAutoCancelCandidates([...rs].reverse(), MIDNIGHT_JUL29)
  assert.deepEqual(a.map(c => c.routeNumber), ['JK-R-1017', 'JK-R-1025', 'JK-R-1030'])
  assert.deepEqual(a.map(c => c.routeNumber), b.map(c => c.routeNumber), 'order is input-independent')
})

test('IDEMPOTENT: a cancelled route stops being a candidate on the next pass', () => {
  const r = route({ routeDate: '2026-07-29', status: 'assigned', assignees: [] })
  assert.equal(selectAutoCancelCandidates([r], MIDNIGHT_JUL29).length, 1)
  // simulate the write the cron performs
  r.status = 'cancelled'
  assert.equal(selectAutoCancelCandidates([r], MIDNIGHT_JUL29).length, 0,
    'a retry after a successful run must select nothing')
})

test('RETRY SAFETY: crew assigned between selection and write disqualifies the route', () => {
  // The cron re-reads under the lock and re-tests these two predicates.
  const fresh = route({ routeDate: '2026-07-29', status: 'assigned', assignees: [assignee({ staffId: 's9' })] })
  assert.equal(hasNoCrew(fresh), false, 'the under-lock re-check refuses it')
  assert.equal(isLiveRoute(fresh), true)
})

test('selection is independent of the write window — a 2pm dry run still answers', () => {
  const r = route({ routeDate: '2026-07-29', status: 'assigned', assignees: [] })
  const afternoon = Date.parse('2026-07-29T19:00:00Z') // 14:00 CDT, same Central day
  assert.equal(isCancellationWindow(afternoon), false, 'not a write window...')
  assert.equal(selectAutoCancelCandidates([r], afternoon).length, 1, '...but the question is still answerable')
})

test('the audit note carries the machine reason, not just "cancelled"', () => {
  const [c] = selectAutoCancelCandidates(
    [route({ routeDate: '2026-07-29', status: 'assigned', assignees: [] })], MIDNIGHT_JUL29)
  assert.match(autoCancelAuditNote(c), /^Auto-cancelled: No crew assigned as of 00:00/)
})

test('a mixed board selects exactly the crewless routes for today', () => {
  const rs = [
    route({ routeNumber: 'A-today-nocrew', routeDate: '2026-07-29', assignees: [] }),
    route({ routeNumber: 'B-today-crewed', routeDate: '2026-07-29', assignees: [assignee({ staffId: 's1' })] }),
    route({ routeNumber: 'C-tomorrow-nocrew', routeDate: '2026-07-30', assignees: [] }),
    route({ routeNumber: 'D-past-nocrew', routeDate: '2026-07-10', assignees: [] }),
    route({ routeNumber: 'E-today-draft', routeDate: '2026-07-29', status: 'draft', assignees: [] }),
    route({ routeNumber: 'F-today-cancelled', routeDate: '2026-07-29', status: 'cancelled', assignees: [] }),
  ]
  assert.deepEqual(
    selectAutoCancelCandidates(rs, MIDNIGHT_JUL29).map(c => c.routeNumber),
    ['A-today-nocrew'])
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. ROLLOUT SAFETY
// ─────────────────────────────────────────────────────────────────────────────

test('ROUTE_AUTO_CANCEL_ENABLED exists and defaults OFF', () => {
  assert.equal(FLAG_DEFAULTS.ROUTE_AUTO_CANCEL_ENABLED, false)
  assert.equal(isEnabled('ROUTE_AUTO_CANCEL_ENABLED', {}), false, 'unset env → off')
  assert.equal(isEnabled('ROUTE_AUTO_CANCEL_ENABLED', { ROUTE_AUTO_CANCEL_ENABLED: 'false' }), false)
  assert.equal(isEnabled('ROUTE_AUTO_CANCEL_ENABLED', { ROUTE_AUTO_CANCEL_ENABLED: 'true' }), true)
})

test('FLAG OFF ⇒ no write, whatever the clock says', () => {
  // Mirrors the cron's decision: write = flagOn && inWindow && !forcedDryRun.
  const decide = (flagOn: boolean, ts: number, forcedDryRun: boolean) =>
    flagOn && isCancellationWindow(ts) && !forcedDryRun
  assert.equal(decide(false, MIDNIGHT_JUL29, false), false, 'flag off is decisive')
  assert.equal(decide(true, MIDNIGHT_JUL29, false), true)
})

test('DRY RUN ⇒ no write even with the flag on inside the window', () => {
  const decide = (flagOn: boolean, ts: number, forcedDryRun: boolean) =>
    flagOn && isCancellationWindow(ts) && !forcedDryRun
  assert.equal(decide(true, MIDNIGHT_JUL29, true), false)
})

test('OUTSIDE THE WINDOW ⇒ no write even with the flag on', () => {
  const decide = (flagOn: boolean, ts: number, forcedDryRun: boolean) =>
    flagOn && isCancellationWindow(ts) && !forcedDryRun
  assert.equal(decide(true, Date.parse('2026-07-29T19:00:00Z'), false), false)
})

test('dry-run still reports the exact candidates and reasons it would act on', () => {
  const rs = [
    route({ routeNumber: 'JK-R-2001', routeDate: '2026-07-29', assignees: [] }),
    route({ routeNumber: 'JK-R-2002', routeDate: '2026-07-29', assignees: [assignee({ staffId: 's1' })] }),
  ]
  const report = selectAutoCancelCandidates(rs, MIDNIGHT_JUL29)
  assert.equal(report.length, 1)
  assert.equal(report[0].routeNumber, 'JK-R-2001')
  assert.equal(report[0].businessName, 'JW Logistics')
  assert.equal(report[0].routeDate, '2026-07-29')
  assert.ok(report[0].detail.length > 0, 'a reason an owner can read, not just an id')
})

test('the cron is deliberately NOT scheduled in this PR', () => {
  const cfg = JSON.parse(
    new TextDecoder().decode(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(new URL('../vercel.json', import.meta.url)),
    ),
  ) as { crons: { path: string; schedule: string }[] }
  assert.equal(
    cfg.crons.some(c => c.path === '/api/cron/route-auto-cancel'), false,
    'scheduling is a SEPARATE rollout change, made only after a Preview dry run is approved')
  // ...and the other crons are untouched by this PR.
  assert.ok(cfg.crons.some(c => c.path === '/api/cron/daily'))
})

test('the DST rationale for the eventual 0 5,6 schedule still holds', () => {
  // Both 05:00Z and 06:00Z fall inside the grace window in their respective offsets,
  // so when the schedule IS registered the second firing is an idempotent retry.
  for (const day of ['2026-01-15', '2026-07-29']) {
    const hits = ['05', '06'].filter(h => isCancellationWindow(Date.parse(`${day}T${h}:00:00Z`)))
    assert.ok(hits.length >= 1, `${day} must have at least one window`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. TENANT ISOLATION
// ─────────────────────────────────────────────────────────────────────────────

test('selection never reaches across tenants — it only sees what it is handed', () => {
  // The cron reads routes INSIDE withBackgroundTenant, so tenant A's run is handed
  // tenant A's routes and cannot observe B's. Selection has no store access at all,
  // which is what makes that guarantee structural rather than a convention.
  const tenantA = [route({ routeNumber: 'A-1', routeDate: '2026-07-29', assignees: [] })]
  const tenantB = [route({ routeNumber: 'B-1', routeDate: '2026-07-29', assignees: [] })]
  assert.deepEqual(selectAutoCancelCandidates(tenantA, MIDNIGHT_JUL29).map(c => c.routeNumber), ['A-1'])
  assert.deepEqual(selectAutoCancelCandidates(tenantB, MIDNIGHT_JUL29).map(c => c.routeNumber), ['B-1'])
  assert.equal(selectAutoCancelCandidates.length, 2, 'takes (routes, now) — no tenant parameter to spoof')
})

test('the cron handler wires per-tenant context and gates the write', () => {
  // The job body now lives in lib/schedule/auto-cancel-job so the clock can be passed
  // in as a parameter; the route file is a thin entry point. These contracts follow
  // the code.
  const read = (rel: string) => new TextDecoder().decode(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').readFileSync(new URL(rel, import.meta.url)),
  )
  const src = read('../app/lib/schedule/auto-cancel-job.ts')
  const route = read('../app/api/cron/route-auto-cancel/route.ts')

  // The route reads the real clock exactly once and hands it to the job — the only
  // Production clock read in this feature.
  assert.match(route, /runAutoCancelJob\(req, Date\.now\(\)\)/, 'Production passes the real clock')
  assert.match(src, /runAutoCancelJob\(req: NextRequest, now: number\)/, 'the clock is an ordinary parameter')
  assert.ok(!/Date\.now\(\)/.test(src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')),
    'the job body never reads the clock itself')
  assert.match(src, /withBackgroundTenant\('cron'/, 'each tenant runs in its own context')
  assert.match(src, /for \(const tenantId of activeTenantIds\(\)\)/, 'per-tenant fan-out')
  assert.match(src, /isEnabled\('ROUTE_AUTO_CANCEL_ENABLED'\)/, 'flag-gated')
  assert.match(src, /withRouteLock/, 'writes hold the per-route lock')
  assert.match(src, /if \(!write\)/, 'no write path when reporting only')
  assert.match(src, /getRouteByToken\(c\.token\)/, 're-reads under the lock (idempotency)')
  assert.match(src, /CRON_SECRET/, 'authenticated')
  assert.match(src, /scanAllRoutes\(\)/, 'uses the COMPLETE scan, not a windowed list')
  assert.match(src, /if \(!scan\.complete\)/, 'a truncated scan cancels nothing')
  assert.match(src, /candidateCount: null/, 'never reports 0 candidates for a truncated scan')
  assert.match(src, /autoCancelRoute\(/, 'single attributed lifecycle write')
  assert.ok(!/setStatus\(/.test(src), 'the old two-entry setStatus+pushAudit pair is gone')
  assert.match(src, /if \(tenancyOn\)/, 'fails closed when a complete tenant sweep cannot be proven')
})


// ─────────────────────────────────────────────────────────────────────────────
// 7. CREW ROLLUP INVARIANT (documented beside rollupStatus in routes.ts)
// ─────────────────────────────────────────────────────────────────────────────

test('CREW ROLLUP INVARIANT: a crew member CAN confirm without the owner\u2019s equipment', () => {
  const r = crewed({ requiresVehicle: true })
  r.assignees![0].confirmedAt = Date.now()
  syncLead(r)  // exactly what the public crew-confirm handler does
  assert.equal(r.status, 'confirmed', 'crew acceptance is never blocked by an owner-controlled field')
})

test('CREW ROLLUP INVARIANT: ...but the route is NOT dispatch-ready', () => {
  const r = crewed({ requiresVehicle: true })
  r.assignees![0].confirmedAt = Date.now()
  syncLead(r)
  assert.equal(isDispatchReady(r), false, 'accepted \u2260 ready to run')
  const item = routeToScheduleItem(r)
  assert.equal(item.dispatchReady, false)
  assert.ok(item.attention.includes('blocked_dispatch'), 'the card carries a visible block')
  assert.ok(detectConflicts([item]).some(c => c.type === 'missing_vehicle'),
    'and the conflict persists until equipment is assigned')
})

test('CREW ROLLUP INVARIANT: assigning equipment clears the block', () => {
  const r = crewed({ requiresVehicle: true, vehicle: 'Truck 1' })
  r.assignees![0].confirmedAt = Date.now()
  syncLead(r)
  assert.equal(rollupStatus(r), 'confirmed')
  assert.equal(isDispatchReady(r), true)
  const item = routeToScheduleItem(r)
  assert.ok(!item.attention.includes('blocked_dispatch'))
  assert.ok(!detectConflicts([item]).some(c => c.type === 'missing_vehicle'))
})

test('a crew-confirmed route with NO equipment requirement is dispatch-ready', () => {
  const r = crewed()
  r.assignees![0].confirmedAt = Date.now()
  syncLead(r)
  assert.equal(isDispatchReady(r), true)
  assert.equal(routeToScheduleItem(r).dispatchReady, true)
  assert.ok(!routeToScheduleItem(r).attention.includes('blocked_dispatch'))
})

test('the no_vehicle attention chip now respects the opt-in rule too', () => {
  assert.ok(!routeToScheduleItem(crewed()).attention.includes('no_vehicle'),
    'a route that never opted in gets no permanent unclearable chip')
  assert.ok(routeToScheduleItem(crewed({ requiresVehicle: true })).attention.includes('no_vehicle'))
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. ATTENTION + CONFLICTS SHARE ONE BOUNDARY
// ─────────────────────────────────────────────────────────────────────────────

test('a PAST route cannot produce Attention > 0 while the visible conflict set is empty', () => {
  const past = route({ routeDate: '2026-07-10', status: 'assigned', requiresVehicle: true, assignees: [] })
  const items = mergeSchedule({ bookings: [], routes: [past] })
  assert.ok(scheduleCounts(items).needsAttention >= 1, 'unfiltered, it does raise attention')

  const from = '2026-07-29'
  const visibleItems = itemsFrom(items, from)
  const visibleConflicts = filterConflictsFrom(detectConflicts(items), from)
  assert.equal(summarizeConflicts(visibleConflicts).total, 0)
  assert.equal(scheduleCounts(visibleItems).needsAttention, 0,
    'THE FIX: Attention and Conflicts describe the same slice')
})

test('itemsFrom keeps UNDATED work so Pending / Unscheduled stay intact', () => {
  const acceptedNoDate = booking({ status: 'confirmed' })      // confirmed lane, no date
  const pendingIntake = booking({ status: 'quote_received' })  // pending lane, no date
  const items = mergeSchedule({ bookings: [acceptedNoDate, pendingIntake], routes: [] })
  const kept = itemsFrom(items, '2099-01-01')
  assert.equal(kept.length, items.length, 'undated work is never filtered out as "past"')
  const c = scheduleCounts(kept)
  assert.ok(c.unscheduled >= 1, 'Unscheduled still sees accepted-but-undated work')
  assert.ok(c.pending >= 1, 'Pending still sees undated intake')
})

test('itemsFrom mirrors filterConflictsFrom exactly (same boundary, same edge cases)', () => {
  const items = mergeSchedule({ bookings: [], routes: [route({ routeDate: '2026-07-20' })] })
  assert.equal(itemsFrom(items, '2026-07-20').length, 1, 'inclusive on the day itself')
  assert.equal(itemsFrom(items, '2026-07-21').length, 0)
  assert.equal(itemsFrom(items, undefined).length, 1, 'absent day disables filtering')
  assert.equal(itemsFrom(items, '').length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. ONE ATTRIBUTED LIFECYCLE EVENT
// ─────────────────────────────────────────────────────────────────────────────

test('autoCancelRoute writes exactly ONE attributed entry with everything needed', () => {
  const r = route({ routeDate: '2026-07-29', status: 'assigned', assignees: [] })
  const [c] = selectAutoCancelCandidates([r], MIDNIGHT_JUL29)
  const ok = autoCancelRoute(r, { reason: c.detail, routeDate: c.routeDate, centralAt: centralStamp(MIDNIGHT_JUL29) })
  assert.equal(ok, true)
  assert.equal(r.status, 'cancelled')
  assert.equal(r.audit.length, 1, 'ONE entry, not two')

  const e = r.audit[0]
  assert.equal(e.actor, 'system')
  assert.equal(e.actorId, SYSTEM_AUTO_CANCEL_PRINCIPAL.sub, 'attributed path used')
  assert.equal(e.actorRole, 'system')
  assert.equal(e.from, 'assigned', 'previous status')
  assert.equal(e.to, 'cancelled', 'new status')
  assert.match(e.action, /Auto-cancelled/)
  assert.match(String(e.note), /No crew assigned/, 'reason')
  assert.match(String(e.note), /Route date 2026-07-29/, 'route date')
  assert.match(String(e.note), /Executed 2026-07-29 00:00 America\/Chicago/, 'Central execution stamp')
})

test('autoCancelRoute is a no-op on an already-terminal route (retry safety)', () => {
  for (const status of ['cancelled', 'completed', 'no_show'] as const) {
    const r = route({ routeDate: '2026-07-29', status, assignees: [] })
    assert.equal(autoCancelRoute(r, { reason: 'x', routeDate: '2026-07-29', centralAt: 'y' }), false)
    assert.equal(r.audit.length, 0, 'no second entry on retry')
    assert.equal(r.status, status)
  }
})

test('centralStamp renders a Central wall-clock date and time', () => {
  assert.match(centralStamp(Date.parse('2026-07-29T05:00:00Z')), /^2026-07-29 00:00$/)
  assert.match(centralStamp(Date.parse('2026-01-15T06:30:00Z')), /^2026-01-15 00:30$/)
})
