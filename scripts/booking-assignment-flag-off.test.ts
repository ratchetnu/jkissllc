// "Off means inert" — the claim `app/lib/platform/flags.ts` makes about
// BOOKING_ASSIGNMENT_ENABLED, held to behaviorally.
//
// It was not fully true when Sprint 1 shipped. `/api/portal/jobs` gated only
// whether BOOKINGS were included, not whether the surface existed, so with the flag
// off Production crew still got a "Jobs" nav item and a whole second page showing
// exactly the work `/portal/routes` already showed. The admin booking page also
// fired a request it knew would 404 on every load.
//
// These tests pin all three: the API, the pages, and the nav.
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret-32byteslong!!'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'

const UPSTASH = 'http://fake-upstash.local'
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!

// Counts every command that reaches the store, so "the flag-off path does not even
// read the booking store" is an assertion rather than a comment.
let reads = 0

globalThis.fetch = (async (url: string, init: { body?: string }) => {
  if (url !== UPSTASH) return { ok: true, status: 200, json: async () => ({}) }
  reads++
  const [cmd, ...args] = JSON.parse(init.body as string) as string[]
  const key = args[0]
  let result: unknown = null
  switch (String(cmd).toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREVRANGE': result = []; break
    default: result = null
  }
  return { ok: true, json: async () => ({ result }) }
}) as unknown as typeof fetch

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import { GET as bookNowGET } from '../app/api/admin/book-now/route'
import { GET as jobsGET } from '../app/api/portal/jobs/route'
import { GET as jobGET } from '../app/api/portal/jobs/[id]/route'
import { portalNav } from '../app/portal/PortalShell'
import MyJobsPage from '../app/portal/jobs/page'
import JobDetailPage from '../app/portal/jobs/[id]/page'
import { bookingToScheduleItem, mergeSchedule } from '../app/lib/schedule/unified'
import { detectConflicts } from '../app/lib/schedule/conflicts'
import type { Booking } from '../app/lib/bookings'
import type { RouteRecord } from '../app/lib/routes'

const here = dirname(fileURLToPath(import.meta.url))
const CTX = { params: Promise.resolve({} as Record<string, string>) }
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) })

const crewReq = async (path: string) =>
  new NextRequest(`http://localhost${path}`, {
    headers: { cookie: `jk_admin_session=${await createUserSessionToken({ id: 'u_crewA', role: 'crew', staffId: 'crewA' })}` },
  })

const withFlag = async <T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> => {
  const prev = process.env.BOOKING_ASSIGNMENT_ENABLED
  if (value === undefined) delete process.env.BOOKING_ASSIGNMENT_ENABLED
  else process.env.BOOKING_ASSIGNMENT_ENABLED = value
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.BOOKING_ASSIGNMENT_ENABLED
    else process.env.BOOKING_ASSIGNMENT_ENABLED = prev
  }
}

// ── The API ──────────────────────────────────────────────────────────────────
test('the unified jobs feed 404s when the flag is off — and is NOT a routes feed in disguise', async () => {
  await withFlag('false', async () => {
    const res = await jobsGET(await crewReq('/api/portal/jobs'), CTX)
    assert.equal(res.status, 404)
    assert.equal((await res.json()).error, 'not_found')
  })
})

test('an ABSENT flag behaves exactly like an explicit off (Production has it unset)', async () => {
  await withFlag(undefined, async () => {
    assert.equal((await jobsGET(await crewReq('/api/portal/jobs'), CTX)).status, 404)
    assert.equal((await jobGET(await crewReq('/api/portal/jobs/x'), idCtx('x'))).status, 404)
  })
})

test('the flag-off feed does not touch the store at all', async () => {
  await withFlag('false', async () => {
    reads = 0
    await jobsGET(await crewReq('/api/portal/jobs'), CTX)
    assert.equal(reads, 0, 'no route, booking, or settings read may happen on a 404ed surface')
  })
})

test('the flag gate runs BEFORE authentication, so an anonymous probe cannot distinguish either', async () => {
  await withFlag('false', async () => {
    const anon = new NextRequest('http://localhost/api/portal/jobs')
    assert.equal((await jobsGET(anon, CTX)).status, 404, 'not 401 — the surface is absent, not protected')
  })
})

// ── The pages ────────────────────────────────────────────────────────────────
// notFound() throws a NEXT_HTTP_ERROR_FALLBACK;404 that terminates the segment.
const throwsNotFound = (fn: () => unknown) =>
  assert.throws(fn, (e: unknown) => /NEXT_HTTP_ERROR_FALLBACK;404/.test(String((e as Error)?.message ?? e)))

test('both /portal/jobs pages 404 at the segment when the flag is off', async () => {
  await withFlag('false', () => {
    throwsNotFound(() => MyJobsPage())
    throwsNotFound(() => JobDetailPage())
  })
})

test('both /portal/jobs pages render when the flag is on', async () => {
  await withFlag('true', () => {
    assert.ok(MyJobsPage(), 'My Jobs renders')
    assert.ok(JobDetailPage(), 'the job detail screen renders')
  })
})

// ── The nav ──────────────────────────────────────────────────────────────────
test('the crew portal nav has no Jobs tab when bookings are off', () => {
  const off = portalNav(false).map(n => n.href)
  assert.ok(!off.includes('/portal/jobs'), 'a nav item must never point at a route that 404s')
  // Everything else the portal has always had is untouched.
  assert.deepEqual(off, [
    '/portal', '/portal/routes', '/portal/clock', '/portal/messages',
    '/portal/availability', '/portal/timeoff', '/portal/pay', '/portal/documents', '/portal/profile',
  ])
})

// ── The admin panel does not knock on a door it knows is locked ──────────────
test('the Book Now feed carries the flag, so the crew panel never probes a 404', async () => {
  const staff = await createUserSessionToken({ id: 'u_admin', role: 'admin' })
  const req = () => new NextRequest('http://localhost/api/admin/book-now', { headers: { cookie: `jk_admin_session=${staff}` } })

  const off = await withFlag('false', async () => await (await bookNowGET(req(), CTX)).json())
  assert.equal(off.flags.bookingAssignment, false)

  const on = await withFlag('true', async () => await (await bookNowGET(req(), CTX)).json())
  assert.equal(on.flags.bookingAssignment, true)
})

test('CrewPanel asks for nothing until the server says the surface exists', () => {
  // Structural, because the component is a client React tree with no renderer in
  // this toolchain: the guard must sit BEFORE the fetch, and the flag must arrive
  // as a prop rather than be inferred from a failed request.
  const src = readFileSync(join(here, '..', 'app', 'admin', 'operations', 'book-now', '[token]', 'CrewPanel.tsx'), 'utf8')
  assert.match(src, /enabled\s*=\s*false\s*\}/, 'the panel defaults to disabled')
  assert.match(src, /if\s*\(!enabled\)\s*return/, 'load() must bail before fetching when the flag is off')
  const load = src.slice(src.indexOf('const load = useCallback'), src.indexOf('useEffect(() => { setAvailable'))
  assert.ok(load.indexOf('if (!enabled) return') < load.indexOf('fetch('), 'the guard must precede the request')

  const page = readFileSync(join(here, '..', 'app', 'admin', 'operations', 'book-now', '[token]', 'page.tsx'), 'utf8')
  assert.match(page, /<CrewPanel token=\{token\} enabled=\{crewAssignment\} \/>/, 'the page feeds the server-resolved flag in')
  assert.match(page, /j\.flags\?\.bookingAssignment/, 'and takes it from the feed it already loads')
})

test('the Jobs tab appears — as a secondary item — only when bookings are on', () => {
  const on = portalNav(true)
  assert.ok(on.map(n => n.href).includes('/portal/jobs'))
  const jobs = on.find(n => n.href === '/portal/jobs')!
  assert.ok(!('primary' in jobs && jobs.primary), 'Jobs stays out of the 4-item mobile bottom bar')
  // The flag toggles exactly one destination, nothing else.
  assert.equal(on.length, portalNav(false).length + 1)
})

test('flag off hides persisted roster crew and equipment from the schedule projection', async () => {
  const booking = {
    token: 'b'.repeat(64), bookingNumber: 'JK-B-FLAG', customerName: 'Customer',
    serviceType: 'moving', status: 'confirmed', selectedDate: '2026-07-20', selectedWindow: '8:00 AM',
    assignedTo: 'Crew One', vehicle: 'Truck One', equipmentId: 'truck-1',
    assignees: [{ staffId: 'crew-1', name: 'Crew One', token: 'private-job-token' }],
    items: [], payments: [], availableDates: [], availableWindows: [],
    invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0, createdAt: 1, updatedAt: 1,
  } as unknown as Booking

  await withFlag('false', () => {
    const item = bookingToScheduleItem(booking)
    assert.deepEqual(item.crew, [])
    assert.equal(item.vehicle, undefined)
    assert.equal(item.equipmentId, undefined)
    assert.deepEqual(item.equipment, [])
    assert.ok(!item.attention.includes('no_crew'), 'hidden assignments do not become a false missing-crew warning')
    assert.equal(item.crewComplete, true, 'the retained assignment remains staffed without exposing identities')
  })

  await withFlag(undefined, () => {
    const item = bookingToScheduleItem(booking)
    assert.deepEqual(item.crew, [], 'an absent Production flag is identical to explicit false')
    assert.equal(item.equipmentId, undefined)
  })

  await withFlag('true', () => {
    const item = bookingToScheduleItem(booking)
    assert.equal(item.crew[0]?.staffId, 'crew-1')
    assert.equal(item.vehicle, 'Truck One')
    assert.equal(item.equipmentId, 'truck-1')
  })
})

test('flag off removes cross-lane conflicts created only by booking assignments', async () => {
  const booking = {
    token: 'c'.repeat(64), bookingNumber: 'JK-B-CONFLICT', customerName: 'Customer',
    serviceType: 'moving', status: 'confirmed', selectedDate: '2026-07-20', selectedWindow: '8:00 AM',
    assignedTo: 'Crew One', vehicle: 'Truck One', equipmentId: 'truck-1',
    assignees: [{ staffId: 'crew-1', name: 'Crew One', token: 'private-job-token' }],
    items: [], payments: [], availableDates: [], availableWindows: [],
    invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0, createdAt: 1, updatedAt: 1,
  } as unknown as Booking
  const route = {
    token: 'r'.repeat(16), routeNumber: 'JK-R-CONFLICT', status: 'assigned', routeDate: '2026-07-20', reportTime: '8:00 AM',
    businessName: 'Business', reportAddress: 'Address', vehicle: 'Truck One', equipmentId: 'truck-1',
    assignees: [{ staffId: 'crew-1', name: 'Crew One', token: 'route-token' }], events: [], audit: [], createdAt: 1, updatedAt: 1,
  } as unknown as RouteRecord

  await withFlag('true', () => {
    const types = detectConflicts(mergeSchedule({ bookings: [booking], routes: [route] })).map(c => c.type)
    assert.ok(types.includes('crew_overlap'))
    assert.ok(types.includes('equipment_overlap'))
  })
  await withFlag('false', () => {
    const types = detectConflicts(mergeSchedule({ bookings: [booking], routes: [route] })).map(c => c.type)
    assert.ok(!types.includes('crew_overlap'))
    assert.ok(!types.includes('equipment_overlap'))
    assert.ok(!types.includes('vehicle_overlap'))
    assert.ok(!types.includes('missing_crew'))
  })
})

// Routes are NOT part of the booking-assignment model, so the flag must not move
// route detection in either direction. Suppressing a booking's hidden crew is the
// whole job; a short-handed route stays quiet and an empty route stays flagged, and
// both answers have to be identical with the flag on and off.
test('route missing-crew detection is identical with the flag on and off', async () => {
  const base = {
    reportTime: '8:00 AM', businessName: 'Business', reportAddress: 'Address',
    vehicle: 'Truck One', routeDate: '2026-07-20', status: 'assigned',
    requiresHelper: true, events: [], audit: [], createdAt: 1, updatedAt: 1,
  }
  const shortHanded = {
    ...base, token: 's'.repeat(16), routeNumber: 'JK-R-SHORT',
    assignees: [{ staffId: 'crew-1', name: 'Crew One', role: 'driver', token: 't1' }],
  } as unknown as RouteRecord
  const unstaffed = {
    ...base, token: 'u'.repeat(16), routeNumber: 'JK-R-EMPTY', assignees: [],
  } as unknown as RouteRecord

  const missingCrewFor = (r: RouteRecord) =>
    detectConflicts(mergeSchedule({ routes: [r] })).filter(c => c.type === 'missing_crew')

  for (const flag of ['true', 'false'] as const) {
    await withFlag(flag, () => {
      assert.equal(missingCrewFor(shortHanded).length, 0,
        `short-handed route must not be flagged (flag=${flag})`)
      assert.equal(missingCrewFor(unstaffed).length, 1,
        `genuinely unstaffed route must still be flagged (flag=${flag})`)
    })
  }
})
