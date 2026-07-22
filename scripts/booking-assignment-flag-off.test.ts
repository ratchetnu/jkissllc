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
