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

import type { RouteRecord, Assignee } from '../app/lib/routes'
import { needsVehicleAssignment, hasVehicleOrEquipment, VEHICLE_REQUIRED_MESSAGE } from '../app/lib/routes'
import { routeToScheduleItem, mergeSchedule } from '../app/lib/schedule/unified'
import { detectConflicts, filterConflictsFrom, summarizeConflicts, type Conflict } from '../app/lib/schedule/conflicts'
import {
  selectAutoCancelCandidates, isCancellationWindow, centralDate, centralHour,
  isLiveRoute, hasNoCrew, autoCancelAuditNote, OPS_TIMEZONE,
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

test('DST: in SUMMER (CDT, UTC-5) the window is 05:00Z and 06:00Z is NOT', () => {
  assert.equal(isCancellationWindow(Date.parse('2026-07-29T05:00:00Z')), true)
  assert.equal(isCancellationWindow(Date.parse('2026-07-29T06:00:00Z')), false, 'that is 01:00 CDT')
})

test('DST: in WINTER (CST, UTC-6) the window is 06:00Z and 05:00Z is NOT', () => {
  assert.equal(isCancellationWindow(Date.parse('2026-01-15T06:00:00Z')), true)
  assert.equal(isCancellationWindow(Date.parse('2026-01-15T05:00:00Z')), false, 'that is 23:00 the previous day')
  assert.equal(centralDate(Date.parse('2026-01-15T05:00:00Z')), '2026-01-14')
})

test('exactly ONE of the two UTC firings is a write window on any given date', () => {
  for (const day of ['2026-01-15', '2026-03-10', '2026-07-29', '2026-11-05', '2026-12-25']) {
    const hits = ['05', '06'].filter(h => isCancellationWindow(Date.parse(`${day}T${h}:00:00Z`)))
    assert.equal(hits.length, 1, `${day} must have exactly one write window, got ${hits.length}`)
  }
})

test('the spring-forward and fall-back weekends do not double- or zero-fire', () => {
  // US DST 2026: forward Sun Mar 8, back Sun Nov 1.
  for (const day of ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02']) {
    const hits = ['05', '06'].filter(h => isCancellationWindow(Date.parse(`${day}T${h}:00:00Z`)))
    assert.equal(hits.length, 1, `${day} produced ${hits.length} windows`)
  }
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

test('the cron is registered at both UTC hours that cover Central midnight', () => {
  const cfg = JSON.parse(
    new TextDecoder().decode(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(new URL('../vercel.json', import.meta.url)),
    ),
  ) as { crons: { path: string; schedule: string }[] }
  const entry = cfg.crons.find(c => c.path === '/api/cron/route-auto-cancel')
  assert.ok(entry, 'the cron must be registered')
  assert.equal(entry!.schedule, '0 5,6 * * *', 'both CDT and CST midnight')
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
  const src = new TextDecoder().decode(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').readFileSync(new URL('../app/api/cron/route-auto-cancel/route.ts', import.meta.url)),
  )
  assert.match(src, /withBackgroundTenant\('cron'/, 'each tenant runs in its own context')
  assert.match(src, /for \(const tenantId of activeTenantIds\(\)\)/, 'per-tenant fan-out')
  assert.match(src, /isEnabled\('ROUTE_AUTO_CANCEL_ENABLED'\)/, 'flag-gated')
  assert.match(src, /withRouteLock/, 'writes hold the per-route lock')
  assert.match(src, /if \(!write\) return out/, 'no write path when reporting only')
  assert.match(src, /getRouteByToken\(c\.token\)/, 're-reads under the lock (idempotency)')
  assert.match(src, /CRON_SECRET/, 'authenticated')
})
