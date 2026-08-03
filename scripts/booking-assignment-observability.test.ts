// Crew activity observability — behavioral tests against the real aggregation, the
// real route handler, and the real redis chokepoint (in-memory Upstash double).
//
// Covers: aggregation, tenant isolation, authorization, pagination/completeness,
// the event cap, date boundaries, and the no-sensitive-field contract.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

process.env.KV_REST_API_URL = 'http://fake-assignment-observability.local'
process.env.KV_REST_API_TOKEN = 'test-token'
process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'

const UPSTASH = process.env.KV_REST_API_URL
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  const [command, ...args] = JSON.parse(init.body as string) as string[]
  const key = args[0]
  let result: unknown = null
  switch (command.toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZCARD': result = z(key).size; break
    case 'ZREVRANGE': {
      const ordered = [...z(key).entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
      const start = Number(args[1]); const stop = Number(args[2])
      result = ordered.slice(start, stop === -1 ? ordered.length : stop + 1)
      break
    }
    case 'EXPIRE': case 'PEXPIRE': result = 1; break
    case 'EVAL': {
      const [, , casKey, payload, expected] = args
      const raw = kv.get(casKey)
      const version = raw ? Number((JSON.parse(raw) as { version?: number }).version ?? 0) : 0
      if (version === Number(expected)) { kv.set(casKey, payload); result = 1 } else result = 0
      break
    }
  }
  return { ok: true, status: 200, json: async () => ({ result }) }
}) as unknown as typeof fetch

import {
  ASSIGNMENT_ACTIONS, DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS, SCAN_PAGE_SIZE, SCAN_MAX_PAGES,
  aggregateAssignmentActivity, resolveRange, summarizeAssignmentActivity,
  type ScanCoverage,
} from '../app/lib/booking-assignment-observability'
import { BOOKING_MAX_EVENTS, saveBooking, type Booking, type BookingEvent } from '../app/lib/bookings'
import { GET as activityGET } from '../app/api/admin/booking-assignment-activity/route'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { NextRequest } from 'next/server'
import { runWithTenant } from '../app/lib/platform/tenancy/context'

// A fixed clock for the PURE tests. `aggregateAssignmentActivity`, `resolveRange`
// and `summarizeAssignmentActivity` all accept `now` as a parameter, so every test
// that calls them directly is deterministic and stays pinned to this constant.
const NOW = 1_785_200_000_000            // fixed clock; no Date.now() in assertions
const DAY = 86_400_000

// A clock-relative base for fixtures that flow through the ROUTE HANDLER.
//
// The handler calls `summarizeAssignmentActivity(input)` with no `now`, so it always
// resolves its window from the real `Date.now()` — there is no seam to inject. A
// fixture pinned to a fixed calendar instant therefore has an EXPIRY DATE: once it
// falls outside `DEFAULT_RANGE_DAYS` the route correctly returns zero and the
// assertion fails, with no code change and no defect.
//
// That is not hypothetical. Seeding at `NOW - DAY` (2026-07-27T00:53:20Z) put these
// events outside the seven-day window from 2026-08-03T00:53:20Z onwards, and the
// suite went red on that boundary for every branch simultaneously.
//
// Captured ONCE at module load so every fixture and assertion in a run shares one
// instant; re-reading `Date.now()` per fixture could straddle the window edge
// between seeding and asserting.
const ROUTE_NOW = Date.now()
const ev = (action: string, at: number, extra: Partial<BookingEvent> = {}): BookingEvent =>
  ({ at, actor: 'crew:c1', action: action as BookingEvent['action'], result: 'c1', meta: { staffId: 'c1' }, ...extra })

const COVERAGE: ScanCoverage = {
  indexCount: 1, tokensScanned: 1, bookingsRead: 1, missingRecords: 0,
  pagesRead: 1, pageLimitReached: false, scanComplete: true,
}
const RANGE = { startMs: NOW - 7 * DAY, endMs: NOW, start: '2026-07-24', end: '2026-07-31', days: 7 }

// ── Aggregation ──────────────────────────────────────────────────────────────

test('aggregation counts each of the five assignment actions', () => {
  const s = aggregateAssignmentActivity([{ events: [
    ev('assignment.accepted', NOW - DAY),
    ev('assignment.declined', NOW - DAY),
    ev('assignment.clock_in', NOW - DAY),
    ev('assignment.clock_out', NOW - DAY),
    ev('assignment.completion_recorded', NOW - DAY, { meta: { staffId: 'c1', requestId: 'req-aaaaaaaaaaaa01' } }),
    // Noise that must NOT be counted.
    ev('assignment.crew_added', NOW - DAY),
    ev('assignment.pay_changed', NOW - DAY),
  ] }], RANGE, COVERAGE)

  assert.equal(s.totals.accepted, 1)
  assert.equal(s.totals.declined, 1)
  assert.equal(s.totals.clockIn, 1)
  assert.equal(s.totals.clockOut, 1)
  assert.equal(s.totals.completionRecorded, 1)
  assert.equal(s.totals.events, 5, 'only the five crew actions count')
  assert.equal(ASSIGNMENT_ACTIONS.length, 5)
})

test('first/most-recent event, total, and distinct crew count', () => {
  const s = aggregateAssignmentActivity([
    { events: [ev('assignment.accepted', NOW - 5 * DAY, { meta: { staffId: 'c1' } })] },
    { events: [
      ev('assignment.clock_in', NOW - 2 * DAY, { meta: { staffId: 'c2' } }),
      ev('assignment.clock_out', NOW - DAY, { meta: { staffId: 'c2' } }),
    ] },
    // Same crew member again across bookings — distinct count must not double.
    { events: [ev('assignment.accepted', NOW - 3 * DAY, { meta: { staffId: 'c1' } })] },
  ], RANGE, COVERAGE)

  assert.equal(s.firstEventAt, NOW - 5 * DAY)
  assert.equal(s.lastEventAt, NOW - DAY)
  assert.equal(s.totals.events, 4)
  assert.equal(s.distinctCrew, 2, 'c1 and c2, counted once each')
})

test('distinct crew falls back from meta.staffId to the crew: actor prefix', () => {
  const s = aggregateAssignmentActivity([{ events: [
    { at: NOW - DAY, actor: 'crew:legacy-1', action: 'assignment.accepted' },
    { at: NOW - DAY, actor: 'crew:legacy-1', action: 'assignment.clock_in' },
    { at: NOW - DAY, actor: 'crew:legacy-2', action: 'assignment.accepted' },
  ] as BookingEvent[] }], RANGE, COVERAGE)
  assert.equal(s.distinctCrew, 2)
})

test('empty input yields zeroes and nulls, not a crash', () => {
  const s = aggregateAssignmentActivity([], RANGE, { ...COVERAGE, indexCount: 0, tokensScanned: 0, bookingsRead: 0 })
  assert.equal(s.totals.events, 0)
  assert.equal(s.firstEventAt, null)
  assert.equal(s.lastEventAt, null)
  assert.equal(s.distinctCrew, 0)
  assert.equal(s.eventCap.mayHaveDroppedEvents, false)
})

// ── Completion idempotency ───────────────────────────────────────────────────

test('completion idempotency splits exactly into distinct + duplicate, legacy apart', () => {
  const s = aggregateAssignmentActivity([{ events: [
    ev('assignment.completion_recorded', NOW - DAY, { meta: { requestId: 'req-aaaaaaaaaaaa01' } }),
    ev('assignment.completion_recorded', NOW - DAY, { meta: { requestId: 'req-aaaaaaaaaaaa01' } }), // duplicate
    ev('assignment.completion_recorded', NOW - DAY, { meta: { requestId: 'req-bbbbbbbbbbbb02' } }),
    ev('assignment.completion_recorded', NOW - DAY, { meta: {} }),                                  // legacy
    ev('assignment.completion_recorded', NOW - DAY),                                                // legacy
  ] }], RANGE, COVERAGE)

  const ci = s.completionIdempotency
  assert.equal(ci.withRequestId, 3)
  assert.equal(ci.distinctRequestIds, 2)
  assert.equal(ci.duplicateRequestIds, 1)
  assert.equal(ci.legacyWithoutRequestId, 2)
  assert.equal(ci.distinctRequestIds + ci.duplicateRequestIds, ci.withRequestId, 'the split is exact')
  assert.equal(ci.withRequestId + ci.legacyWithoutRequestId, s.totals.completionRecorded)
})

test('request ids dedupe PER BOOKING — the scope the server dedupes in', () => {
  // The same id on two DIFFERENT bookings is two distinct attempts, not a duplicate.
  const s = aggregateAssignmentActivity([
    { events: [ev('assignment.completion_recorded', NOW - DAY, { meta: { requestId: 'shared-id-0000001' } })] },
    { events: [ev('assignment.completion_recorded', NOW - DAY, { meta: { requestId: 'shared-id-0000001' } })] },
  ], RANGE, COVERAGE)
  assert.equal(s.completionIdempotency.duplicateRequestIds, 0)
  assert.equal(s.completionIdempotency.distinctRequestIds, 2)
})

test('a legacy-only completion set reports zero duplicates AND zero evaluable events', () => {
  // Guards the "never imply legacy proves exactly-once" rule: with only legacy
  // events, withRequestId is 0, so a reader cannot mistake 0 duplicates for proof.
  const s = aggregateAssignmentActivity([{ events: [
    ev('assignment.completion_recorded', NOW - DAY, { meta: {} }),
    ev('assignment.completion_recorded', NOW - DAY, { meta: {} }),
  ] }], RANGE, COVERAGE)
  assert.equal(s.completionIdempotency.duplicateRequestIds, 0)
  assert.equal(s.completionIdempotency.withRequestId, 0, 'nothing was evaluable')
  assert.equal(s.completionIdempotency.legacyWithoutRequestId, 2)
})

// ── Date boundaries ──────────────────────────────────────────────────────────

test('events exactly on each range edge are included; outside is excluded', () => {
  const s = aggregateAssignmentActivity([{ events: [
    ev('assignment.accepted', RANGE.startMs),      // inclusive lower edge
    ev('assignment.accepted', RANGE.endMs),        // inclusive upper edge
    ev('assignment.accepted', RANGE.startMs - 1),  // just before
    ev('assignment.accepted', RANGE.endMs + 1),    // just after
  ] }], RANGE, COVERAGE)
  assert.equal(s.totals.accepted, 2, 'both edges in, both neighbours out')
})

test('range defaults to seven days and refuses more than ninety', () => {
  const d = resolveRange({}, NOW)
  assert.equal(d.ok && d.days, DEFAULT_RANGE_DAYS)

  assert.equal(resolveRange({ days: 90 }, NOW).ok, true)
  assert.deepEqual(resolveRange({ days: 91 }, NOW), { ok: false, error: 'range_too_long' })
  assert.deepEqual(resolveRange({ days: 0 }, NOW), { ok: false, error: 'invalid_date' })
  assert.deepEqual(resolveRange({ days: -3 }, NOW), { ok: false, error: 'invalid_date' })
  assert.deepEqual(resolveRange({ days: 'abc' }, NOW), { ok: false, error: 'invalid_date' })
  // Pin the LITERALS, not just the constants. Every other assertion here compares
  // against DEFAULT_RANGE_DAYS/MAX_RANGE_DAYS, so they all move together if someone
  // edits the constant — the window semantics would change with nothing going red.
  assert.equal(DEFAULT_RANGE_DAYS, 7)
  assert.equal(MAX_RANGE_DAYS, 90)
})

test('explicit ranges are honoured, inverted refused, over-long refused', () => {
  const ok = resolveRange({ start: '2026-07-01', end: '2026-07-10' }, NOW)
  assert.equal(ok.ok, true)
  assert.equal(ok.ok && ok.start, '2026-07-01')
  assert.equal(ok.ok && ok.end, '2026-07-10')

  assert.deepEqual(resolveRange({ start: '2026-07-10', end: '2026-07-01' }, NOW), { ok: false, error: 'inverted_range' })
  assert.deepEqual(resolveRange({ start: '2026-01-01', end: '2026-07-01' }, NOW), { ok: false, error: 'range_too_long' })
  assert.deepEqual(resolveRange({ start: 'not-a-date', end: '2026-07-01' }, NOW), { ok: false, error: 'invalid_date' })
})

// ── Event cap ────────────────────────────────────────────────────────────────

test('bookings sitting at the event cap are reported as a lower bound', () => {
  const atCap = { events: Array.from({ length: BOOKING_MAX_EVENTS }, () => ev('assignment.clock_in', NOW - DAY)) }
  const under = { events: [ev('assignment.clock_in', NOW - DAY)] }
  const s = aggregateAssignmentActivity([atCap, under], RANGE, COVERAGE)
  assert.equal(s.eventCap.maxEventsPerBooking, BOOKING_MAX_EVENTS)
  assert.equal(s.eventCap.bookingsAtCap, 1)
  assert.equal(s.eventCap.mayHaveDroppedEvents, true)

  const clean = aggregateAssignmentActivity([under], RANGE, COVERAGE)
  assert.equal(clean.eventCap.bookingsAtCap, 0)
  assert.equal(clean.eventCap.mayHaveDroppedEvents, false)
})

// ── Pagination + scan completeness (through the real store) ──────────────────

// `at` is REQUIRED and has no default. A default is what let a fixture silently
// belong to a different clock than the assertion that reads it back: pass NOW-
// relative for tests that inject NOW, ROUTE_NOW-relative for tests that go through
// the route handler. Making it explicit means the mismatch cannot recur silently.
async function seedBookings(count: number, tenant: string, eventsPer: number, at: number): Promise<void> {
  await runWithTenant({ tenantId: tenant }, async () => {
    for (let i = 0; i < count; i++) {
      await saveBooking({
        token: `${tenant}-tok-${String(i).padStart(5, '0')}`.padEnd(64, 'x'),
        bookingNumber: `JK-${tenant}-${i}`, serviceType: 'junk_removal', status: 'confirmed',
        // Every timestamp derives from `at`, so a fixture belongs entirely to one
        // clock. `createdAt`/`updatedAt` are not read by the range filter, but
        // keeping them consistent stops a future assertion tripping over a record
        // that claims to have been updated before it was created.
        customerName: 'Seed Customer', createdAt: at - 9 * DAY, updatedAt: at + i,
        events: Array.from({ length: eventsPer }, () => ev('assignment.accepted', at)),
      } as unknown as Booking)
    }
  })
}

// ── The seven-day boundary, pinned at arbitrary dates ────────────────────────
//
// `summarizeAssignmentActivity` takes `now`, so these assertions are independent of
// when the suite runs. They are the reason a broken window calculation cannot hide:
// the route-level tests above prove the fixture is visible, these prove it is
// visible for the RIGHT reason and stops being visible at exactly the right instant.
//
// Each case runs at several instants decades apart, so a fix that merely re-pins the
// fixture to a newer calendar date would not satisfy them.
const BOUNDARY_CLOCKS: [string, number][] = [
  ['2026-08-03', Date.UTC(2026, 7, 3, 12)],
  ['2027-01-01', Date.UTC(2027, 0, 1, 12)],
  ['2030-06-15', Date.UTC(2030, 5, 15, 12)],
  ['2099-12-31', Date.UTC(2099, 11, 31, 12)],
]

test('an event just INSIDE the seven-day window is counted, at any date', async () => {
  for (const [label, clock] of BOUNDARY_CLOCKS) {
    kv.clear(); zsets.clear()
    // One second inside the lower edge.
    await seedBookings(2, 'boundary', 1, clock - DEFAULT_RANGE_DAYS * DAY + 1000)
    const r = await runWithTenant({ tenantId: 'boundary' }, () =>
      summarizeAssignmentActivity({}, clock))
    assert.equal(r.ok, true, `${label}: range must resolve`)
    assert.equal(r.ok && r.summary.totals.accepted, 2, `${label}: just-inside events must be counted`)
  }
})

test('an event just OUTSIDE the seven-day window is excluded, at any date', async () => {
  for (const [label, clock] of BOUNDARY_CLOCKS) {
    kv.clear(); zsets.clear()
    // One second beyond the lower edge.
    await seedBookings(2, 'boundary', 1, clock - DEFAULT_RANGE_DAYS * DAY - 1000)
    const r = await runWithTenant({ tenantId: 'boundary' }, () =>
      summarizeAssignmentActivity({}, clock))
    assert.equal(r.ok, true, `${label}: range must resolve`)
    assert.equal(r.ok && r.summary.totals.accepted, 0, `${label}: just-outside events must be excluded`)
  }
})

test('the default-window fixture stays inside the window however far the clock advances', async () => {
  // The regression that produced this test: a fixture pinned to a fixed calendar
  // instant drifts out of the default window and the suite goes red with no code
  // change. Seeding relative to the clock the route will use must survive any date.
  for (const [label, clock] of [...BOUNDARY_CLOCKS, ['+100y', Date.UTC(2126, 0, 1, 12)] as [string, number]]) {
    kv.clear(); zsets.clear()
    await seedBookings(2, 'drift', 1, clock - DAY)
    const r = await runWithTenant({ tenantId: 'drift' }, () =>
      summarizeAssignmentActivity({}, clock))
    assert.equal(r.ok && r.summary.totals.accepted, 2, `${label}: a clock-relative fixture never expires`)
  }
})

test('a complete scan across many pages reports scanComplete and exact totals', async () => {
  kv.clear(); zsets.clear()
  // A tiny injected page size exercises real multi-page traversal without seeding
  // hundreds of records. The production defaults are asserted separately below.
  const PAGE = 3
  const N = PAGE * 2 + 1                    // forces three pages, last one partial
  await seedBookings(N, 'tenantA', 1, NOW - DAY)

  const r = await runWithTenant({ tenantId: 'tenantA' }, () => summarizeAssignmentActivity({ days: 30 }, NOW, { pageSize: PAGE }))
  assert.equal(r.ok, true)
  const s = r.ok ? r.summary : null
  assert.ok(s)
  assert.equal(s!.coverage.indexCount, N)
  assert.equal(s!.coverage.tokensScanned, N)
  assert.equal(s!.coverage.bookingsRead, N)
  assert.equal(s!.coverage.missingRecords, 0)
  assert.equal(s!.coverage.pageLimitReached, false)
  assert.equal(s!.coverage.scanComplete, true)
  assert.ok(s!.coverage.pagesRead >= 3, 'more than one page was needed')
  assert.equal(s!.totals.accepted, N, 'every seeded event counted exactly once')
})

test('an indexed booking whose record is gone makes totals a lower bound', async () => {
  kv.clear(); zsets.clear()
  await seedBookings(4, 'tenantB', 1, NOW - DAY)
  // Drop one record but leave its index entry — a real orphan.
  const orphan = [...kv.keys()].find(k => k.startsWith('bk:') && !k.startsWith('bk:num:') && k !== 'bk:index')
  assert.ok(orphan)
  kv.delete(orphan!)

  const r = await runWithTenant({ tenantId: 'tenantB' }, () => summarizeAssignmentActivity({ days: 30 }, NOW))
  const s = r.ok ? r.summary : null
  assert.ok(s)
  assert.equal(s!.coverage.indexCount, 4)
  assert.equal(s!.coverage.missingRecords, 1)
  assert.equal(s!.coverage.bookingsRead, 3)
  assert.equal(s!.coverage.scanComplete, false, 'incomplete coverage must be reported')
  assert.equal(s!.totals.accepted, 3, 'and the total is a lower bound')
})

test('hitting the page ceiling is never silent — it forces scanComplete false', async () => {
  kv.clear(); zsets.clear()
  await seedBookings(9, 'tenantCap', 1, NOW - DAY)
  // pageSize 2 × maxPages 2 can see at most 4 of 9 — the ceiling stops it early.
  const r = await runWithTenant({ tenantId: 'tenantCap' }, () =>
    summarizeAssignmentActivity({ days: 30 }, NOW, { pageSize: 2, maxPages: 2 }))
  const s = r.ok ? r.summary : null
  assert.ok(s)
  assert.equal(s!.coverage.indexCount, 9)
  assert.equal(s!.coverage.pageLimitReached, true)
  assert.equal(s!.coverage.scanComplete, false, 'a truncated scan must never claim completeness')
  assert.equal(s!.coverage.tokensScanned, 4)
  assert.equal(s!.totals.accepted, 4, 'and its totals are an explicit lower bound')
})

test('the production paging defaults are the bounded constants, not the test knobs', () => {
  assert.equal(SCAN_PAGE_SIZE, 250)
  assert.equal(SCAN_MAX_PAGES, 40)
  // Injection must not be able to weaken production: omitting opts uses these.
  const src = readFileSync(new URL('../app/lib/booking-assignment-observability.ts', import.meta.url), 'utf8')
  assert.match(src, /opts\.pageSize \?\? SCAN_PAGE_SIZE/)
  assert.match(src, /opts\.maxPages \?\? SCAN_MAX_PAGES/)
})

// ── Tenant isolation ─────────────────────────────────────────────────────────

test('TENANCY: one tenant never sees another tenant’s events', async () => {
  kv.clear(); zsets.clear()
  process.env.TENANCY_ENABLED = 'true'
  try {
    await seedBookings(3, 'tenantX', 1, NOW - DAY)
    await seedBookings(5, 'tenantY', 1, NOW - DAY)

    const x = await runWithTenant({ tenantId: 'tenantX' }, () => summarizeAssignmentActivity({ days: 30 }, NOW))
    const y = await runWithTenant({ tenantId: 'tenantY' }, () => summarizeAssignmentActivity({ days: 30 }, NOW))
    assert.ok(x.ok && y.ok)
    const sx = x.ok ? x.summary : null
    const sy = y.ok ? y.summary : null

    assert.equal(sx!.coverage.indexCount, 3, 'tenantX sees only its own index')
    assert.equal(sx!.totals.accepted, 3)
    assert.equal(sy!.coverage.indexCount, 5, 'tenantY sees only its own index')
    assert.equal(sy!.totals.accepted, 5)
    assert.notEqual(sx!.totals.accepted, sx!.totals.accepted + sy!.totals.accepted)
  } finally {
    delete process.env.TENANCY_ENABLED
  }
})

test('TENANCY: the module cannot name, take, or set a tenant, so it cannot widen scope', () => {
  // Scope comes ONLY from the ambient context the redis chokepoint reads. If this
  // module could accept or establish a tenant id it could aggregate across tenants;
  // it references neither the concept nor the context helpers.
  const src = readFileSync(new URL('../app/lib/booking-assignment-observability.ts', import.meta.url), 'utf8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  assert.doesNotMatch(code, /tenantId/, 'no tenant id parameter or literal')
  assert.doesNotMatch(code, /runWithTenant|currentTenantId|getTenantContext/, 'never establishes or reads tenant context itself')
  // And it reaches the store only through the tenant-scoped bookings helpers.
  assert.match(code, /from '\.\/bookings'/)
  assert.doesNotMatch(code, /from '\.\/redis'/, 'no direct chokepoint access — key literals stay in bookings.ts')
  assert.equal(aggregateAssignmentActivity.length, 3, 'pure aggregation takes exactly its three inputs')
})

// ── Authorization ────────────────────────────────────────────────────────────

const req = (cookie?: string, qs = '') =>
  new NextRequest(`http://localhost/api/admin/booking-assignment-activity${qs}`, {
    method: 'GET',
    headers: cookie ? { cookie: `jk_admin_session=${cookie}` } : {},
  })

const sessionFor = (role: 'admin' | 'manager' | 'crew') =>
  createUserSessionToken({ id: `u_${role}`, role, staffId: role === 'crew' ? 'c1' : undefined })

test('AUTHZ: unauthenticated is 401', async () => {
  kv.clear(); zsets.clear()
  const res = await activityGET(req(), { params: Promise.resolve({}) } as never)
  assert.equal(res.status, 401)
})

test('AUTHZ: manager and crew are 403 — audit:view is admin-only', async () => {
  kv.clear(); zsets.clear()
  for (const role of ['manager', 'crew'] as const) {
    const res = await activityGET(req(await sessionFor(role)), { params: Promise.resolve({}) } as never)
    assert.equal(res.status, 403, `${role} must be refused`)
  }
})

test('AUTHZ: admin is 200 and receives the summary', async () => {
  kv.clear(); zsets.clear()
  await seedBookings(2, 'default', 1, ROUTE_NOW - DAY)
  const res = await activityGET(req(await sessionFor('admin')), { params: Promise.resolve({}) } as never)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.ok(body.summary)
  assert.equal(body.summary.range.days, DEFAULT_RANGE_DAYS, 'defaults to seven days')
})

test('AUTHZ: an over-long range is refused with 400, not silently clamped', async () => {
  kv.clear(); zsets.clear()
  const res = await activityGET(req(await sessionFor('admin'), '?days=365'), { params: Promise.resolve({}) } as never)
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'range_too_long')
})

// ── Flag independence (intentional) ──────────────────────────────────────────

test('the audit view is independent of BOOKING_ASSIGNMENT_ENABLED — history survives rollback', async () => {
  kv.clear(); zsets.clear()
  await seedBookings(2, 'default', 1, ROUTE_NOW - DAY)
  const prev = process.env.BOOKING_ASSIGNMENT_ENABLED
  try {
    // With the flag OFF every other booking-crew surface 404s. This one must not:
    // the moment you most need the assignment history is during or after a rollback.
    process.env.BOOKING_ASSIGNMENT_ENABLED = 'false'
    const res = await activityGET(req(await sessionFor('admin')), { params: Promise.resolve({}) } as never)
    assert.equal(res.status, 200, 'audit history stays readable with the flag off')
    const body = await res.json()
    assert.equal(body.summary.totals.accepted, 2, 'and still reports the real historical counts')
  } finally {
    process.env.BOOKING_ASSIGNMENT_ENABLED = prev
  }

  // And the route must not consult the flag at all — a future edit adding a gate
  // would silently delete the evidence during a rollback.
  const route = readFileSync(new URL('../app/api/admin/booking-assignment-activity/route.ts', import.meta.url), 'utf8')
  const code = route.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, /BOOKING_ASSIGNMENT_ENABLED/, 'no flag gate in the handler')
  assert.doesNotMatch(code, /isEnabled/, 'no flag read at all')
})

// ── Refresh control layout contract ──────────────────────────────────────────

test('the Refresh control is inline-flex, centered, non-wrapping, and 44px', () => {
  const src = readFileSync(new URL('../app/admin/operations/crew-activity/page.tsx', import.meta.url), 'utf8')
  // Isolate the Refresh button so these assertions cannot pass on some other control.
  const start = src.indexOf('aria-label="Refresh crew activity"')
  assert.ok(start > 0, 'Refresh button found')
  const btn = src.slice(src.lastIndexOf('<button', start), src.indexOf('</button>', start))

  // As a plain inline button with a margin-spaced SVG it wrapped onto two lines,
  // putting the icon above the label. These four properties are the fix.
  assert.match(btn, /display: 'inline-flex'/)
  assert.match(btn, /alignItems: 'center'/)
  assert.match(btn, /justifyContent: 'center'/)
  assert.match(btn, /whiteSpace: 'nowrap'/)
  assert.match(btn, /flexShrink: 0/, 'must not be squeezed again at narrow widths')
  assert.match(btn, /minHeight: 44/, 'tap target preserved')
  // Spacing now comes from flex gap, not an icon margin that inline layout could break.
  assert.match(btn, /gap: 6/)
  assert.doesNotMatch(btn, /marginRight/, 'no margin-based icon spacing')
  assert.doesNotMatch(btn, /verticalAlign/, 'no inline-layout hacks left behind')
  assert.match(btn, /aria-hidden="true"/, 'decorative icon stays out of the a11y tree')
})

test('every control in the range row keeps a 44px minimum tap target', () => {
  const src = readFileSync(new URL('../app/admin/operations/crew-activity/page.tsx', import.meta.url), 'utf8')
  const row = src.slice(src.indexOf('role="group" aria-label="Date range"'), src.indexOf('</fieldset>'))
  const buttons = row.split('<button').slice(1)
  assert.equal(buttons.length, 2, 'the mapped range pill plus Refresh')
  for (const b of buttons) assert.match(b, /minHeight: 44/)
})

// ── No sensitive fields ──────────────────────────────────────────────────────

test('NO LEAK: the response contains only numbers, booleans, and date strings', async () => {
  kv.clear(); zsets.clear()
  await runWithTenant({ tenantId: 'default' }, async () => {
    await saveBooking({
      token: 'leak-check-token'.padEnd(64, 'z'), bookingNumber: 'JK-LEAK-1',
      serviceType: 'junk_removal', status: 'confirmed',
      customerName: 'Jane Q Customer', jobSiteAddress: '123 Secret Lane',
      customerEmail: 'jane@example.com', customerPhone: '555-0100',
      completionNote: 'gate code 9182', completionPhotos: ['https://blob.example/proof.jpg'],
      // ROUTE_NOW: read back through the route handler. The leak assertions do not
      // depend on the count, but an expired fixture would make this test silently
      // inspect an EMPTY payload — passing for the wrong reason.
      invoiceAmountCents: 45_000, createdAt: ROUTE_NOW - DAY, updatedAt: ROUTE_NOW,
      assignees: [{ staffId: 'crew-secret-1', name: 'Bob Crewman', payCents: 15_000 }],
      events: [ev('assignment.completion_recorded', ROUTE_NOW - 1000, { meta: { staffId: 'crew-secret-1', requestId: 'req-cccccccccccc03' } })],
    } as unknown as Booking)
  })

  const res = await activityGET(req(await sessionFor('admin')), { params: Promise.resolve({}) } as never)
  assert.equal(res.status, 200)
  const raw = JSON.stringify(await res.json())

  for (const secret of [
    'Jane Q Customer', '123 Secret Lane', 'jane@example.com', '555-0100',
    'gate code 9182', 'blob.example', 'leak-check-token', 'JK-LEAK-1',
    'crew-secret-1', 'Bob Crewman', '45000', '15000', 'req-cccccccccccc03',
  ]) {
    assert.equal(raw.includes(secret), false, `response must not contain ${secret}`)
  }

  // Every leaf must be a number, boolean, null, or a plain YYYY-MM-DD date.
  const summary = JSON.parse(raw).summary as Record<string, unknown>
  const leaves: unknown[] = []
  const walk = (v: unknown) => {
    if (v === null || typeof v !== 'object') { leaves.push(v); return }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x)
  }
  walk(summary)
  for (const leaf of leaves) {
    const okLeaf = typeof leaf === 'number' || typeof leaf === 'boolean' || leaf === null
      || (typeof leaf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(leaf))
    assert.ok(okLeaf, `unexpected leaf in response: ${JSON.stringify(leaf)}`)
  }
})

test('NO LEAK: crew identity is a count, and no per-booking rows are returned', async () => {
  kv.clear(); zsets.clear()
  await seedBookings(3, 'default', 1, ROUTE_NOW - DAY)
  const res = await activityGET(req(await sessionFor('admin')), { params: Promise.resolve({}) } as never)
  const body = await res.json()
  // Assert the seeded data actually came back FIRST. Without this the leak checks
  // below are satisfied by an empty payload — so an expired or mis-clocked fixture
  // would make this test pass for the wrong reason, proving nothing about leakage.
  assert.equal(body.summary.totals.accepted, 3, 'the seeded events must be in range')
  assert.equal(typeof body.summary.distinctCrew, 'number')
  assert.ok(body.summary.distinctCrew >= 1, 'and must describe real crew activity')
  // No array anywhere in the payload — arrays are how per-booking rows would appear.
  const hasArray = (v: unknown): boolean =>
    Array.isArray(v) || (v !== null && typeof v === 'object' && Object.values(v as object).some(hasArray))
  assert.equal(hasArray(body.summary), false, 'no arrays ⇒ no per-row detail')
})
