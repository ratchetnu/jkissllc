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

const NOW = 1_785_200_000_000            // fixed clock; no Date.now() in assertions
const DAY = 86_400_000
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

async function seedBookings(count: number, tenant: string, eventsPer = 1): Promise<void> {
  await runWithTenant({ tenantId: tenant }, async () => {
    for (let i = 0; i < count; i++) {
      await saveBooking({
        token: `${tenant}-tok-${String(i).padStart(5, '0')}`.padEnd(64, 'x'),
        bookingNumber: `JK-${tenant}-${i}`, serviceType: 'junk_removal', status: 'confirmed',
        customerName: 'Seed Customer', createdAt: NOW - 10 * DAY, updatedAt: NOW - i,
        events: Array.from({ length: eventsPer }, () => ev('assignment.accepted', NOW - DAY)),
      } as unknown as Booking)
    }
  })
}

test('a complete scan across many pages reports scanComplete and exact totals', async () => {
  kv.clear(); zsets.clear()
  // A tiny injected page size exercises real multi-page traversal without seeding
  // hundreds of records. The production defaults are asserted separately below.
  const PAGE = 3
  const N = PAGE * 2 + 1                    // forces three pages, last one partial
  await seedBookings(N, 'tenantA')

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
  await seedBookings(4, 'tenantB')
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
  await seedBookings(9, 'tenantCap')
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
    await seedBookings(3, 'tenantX')
    await seedBookings(5, 'tenantY')

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
  await seedBookings(2, 'default')
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
      invoiceAmountCents: 45_000, createdAt: NOW - DAY, updatedAt: NOW,
      assignees: [{ staffId: 'crew-secret-1', name: 'Bob Crewman', payCents: 15_000 }],
      events: [ev('assignment.completion_recorded', NOW - 1000, { meta: { staffId: 'crew-secret-1', requestId: 'req-cccccccccccc03' } })],
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
  await seedBookings(3, 'default')
  const res = await activityGET(req(await sessionFor('admin')), { params: Promise.resolve({}) } as never)
  const body = await res.json()
  assert.equal(typeof body.summary.distinctCrew, 'number')
  // No array anywhere in the payload — arrays are how per-booking rows would appear.
  const hasArray = (v: unknown): boolean =>
    Array.isArray(v) || (v !== null && typeof v === 'object' && Object.values(v as object).some(hasArray))
  assert.equal(hasArray(body.summary), false, 'no arrays ⇒ no per-row detail')
})
