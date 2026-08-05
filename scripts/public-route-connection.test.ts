// ─────────────────────────────────────────────────────────────────────────────
// Legacy public route-confirmation surface — Sprint 3 connection treatment.
//
// The audit that produced this change concluded RETAIN AND HARDEN rather than
// redirect or retire, because a route assignee is not guaranteed to have a login:
// a Staff roster record and a User account are separate objects, `staff.email` is
// documented as "contact only", and creating a crew login is a distinct admin
// action (POST /api/admin/users with role='crew' + staffId). The public token is
// therefore the only way an account-less contractor can act on their route, and
// SMS delivers that link in the assignment, reminder, and details messages.
//
// These tests pin the four things that make the retry treatment safe: the verbs
// really are idempotent server-side, the token really is the credential, the token
// really is tenant-bound, and no punch is ever stored for later delivery.
// ─────────────────────────────────────────────────────────────────────────────
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

const PORT = 8700 + (process.pid % 200)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { createServer, type Server } from 'node:http'

import { NextRequest } from 'next/server'
import { saveRoute, getRouteByToken, getRouteByConfirmToken, type RouteRecord, type Assignee } from '../app/lib/routes'
import { saveBooking, type Booking } from '../app/lib/bookings'
import { punchBookingClock } from '../app/lib/booking-assignment'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { bindToken } from '../app/lib/platform/tenancy/token-binding'
import { GET, POST } from '../app/api/route/[token]/route'
import { PATCH as ADMIN_ROUTE_PATCH } from '../app/api/admin/routes/[id]/route'
import { createSessionToken } from '../app/api/admin/_lib/session'
import { appendCorrection, punchId, validateCorrection } from '../app/lib/time-corrections'
import { selectTimeEntries } from '../app/lib/timesheets'
import { buildPunchOverlapReport } from '../app/lib/timeclock/punch-overlap-scan'

// Fails the next N route WRITES while leaving every read intact. Arming this is
// the only honest way to ask "what if the save fails halfway through?" — the
// answer must be that nothing at all was persisted.
let failRouteWrites = 0
let failCorrectionReads = 0
let forceIncompleteRouteScan = 0
let forceIncompleteBookingScan = 0
let proxy: Server | null = null
const PROXY_PORT = PORT + 1
const EMULATOR_URL = `http://127.0.0.1:${PORT}`

let kv: ChildProcess | null = null
before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) break } catch { /* not up */ }
    await sleep(50)
  }
  proxy = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8')
      // The route RECORD write only — not `rt:lock:`, which must keep working so
      // the failure under test is a failed save and not a failed lock.
      const isRouteWrite = /^\["SET","rt:[a-f0-9]{16,}"/i.test(body)
      const isCorrectionRead = /tcorr:punch:/.test(body)
      const isRouteIndexCount = /^\["ZCARD","rt:index"\]$/i.test(body)
      const isBookingIndexCount = /^\["ZCARD","bk:index"\]$/i.test(body)
      if (forceIncompleteRouteScan > 0 && isRouteIndexCount) {
        forceIncompleteRouteScan--
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ result: 20_001 }))
        return
      }
      // The booking half of the same guard. The route scan runs first, so this
      // only ever fires once the route lane has already reported complete.
      if (forceIncompleteBookingScan > 0 && isBookingIndexCount) {
        forceIncompleteBookingScan--
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ result: 20_001 }))
        return
      }
      if ((failRouteWrites > 0 && isRouteWrite) || (failCorrectionReads > 0 && isCorrectionRead)) {
        if (isRouteWrite) failRouteWrites--; else failCorrectionReads--
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'INJECTED_WRITE_FAILURE' }))
        return
      }
      try {
        const up = await fetch(EMULATOR_URL + (req.url ?? '/'), {
          method: req.method, headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
          body: req.method === 'POST' && body ? body : undefined,
        })
        const text = await up.text()
        res.writeHead(up.status, { 'content-type': 'application/json' })
        res.end(text)
      } catch {
        res.writeHead(502); res.end('{"error":"proxy"}')
      }
    })
  })
  await new Promise<void>(r => proxy!.listen(PROXY_PORT, '127.0.0.1', r))
})
after(() => { kv?.kill('SIGKILL'); proxy?.close() })
beforeEach(async () => {
  failRouteWrites = 0
  failCorrectionReads = 0
  forceIncompleteRouteScan = 0
  forceIncompleteBookingScan = 0
  delete process.env.SINGLE_OPEN_PUNCH_ENABLED
  process.env.KV_REST_API_URL = EMULATOR_URL
  await fetch(`${EMULATOR_URL}/__admin/flush`, { method: 'POST' }).catch(() => {})
})

// Route + assignee tokens must satisfy /^[a-f0-9]{16,}$/.
const ROUTE_TOK = 'aaaa0000bbbb1111'
const CREW_TOK = 'cccc2222dddd3333'
const OTHER_TOK = 'eeee4444ffff5555'
const ROUTE2_TOK = '1111aaaa2222bbbb'
const CREW2_TOK = '3333cccc4444dddd'
const BOOKING_TOK = '5555eeee6666ffff'
const TENANT = 'jkiss'

const assignee = (over: Partial<Assignee> = {}): Assignee => ({
  name: 'Sam Contractor', token: CREW_TOK, staffId: 's1', ...over,
} as Assignee)

const mkRoute = (over: Partial<RouteRecord> = {}): RouteRecord => ({
  token: ROUTE_TOK, routeNumber: 'JK-R-9001', status: 'assigned',
  businessName: 'JW Logistics', reportAddress: '1 Commerce St', reportTime: '7:00 AM',
  routeDate: '2030-01-01', events: [], audit: [], createdAt: 1, updatedAt: 1,
  assignees: [assignee()], ...over,
} as RouteRecord)

const ctx = (token: string) => ({ params: Promise.resolve({ token }) })
const get = (token: string) => GET(new NextRequest(`http://localhost/api/route/${token}`), ctx(token) as never)
const post = (token: string, body: unknown) =>
  POST(new NextRequest(`http://localhost/api/route/${token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), ctx(token) as never)

const seed = async (r: RouteRecord = mkRoute()) => {
  await runWithTenant({ tenantId: TENANT }, async () => {
    await saveRoute(r)
    await bindToken(r.token, { tenantId: TENANT, resourceType: 'route', resourceId: r.token })
    for (const a of r.assignees ?? []) {
      await bindToken(a.token, { tenantId: TENANT, resourceType: 'route', resourceId: r.token })
    }
  })
  return r
}
const stored = (token: string) => runWithTenant({ tenantId: TENANT }, () => getRouteByToken(token))

const secondRoute = (over: Partial<RouteRecord> = {}): RouteRecord => mkRoute({
  token: ROUTE2_TOK,
  routeNumber: 'JK-R-9002',
  assignees: [assignee({ token: CREW2_TOK })],
  ...over,
})

const booking = (over: Partial<Booking> = {}): Booking => ({
  token: BOOKING_TOK,
  bookingNumber: 'JK-B-9001',
  customerName: 'Customer',
  status: 'confirmed',
  selectedDate: '2030-01-01',
  createdAt: 1,
  updatedAt: 1,
  events: [],
  assignees: [{ name: 'Sam Contractor', token: '7777aaaa8888bbbb', staffId: 's1', confirmedAt: 1 }],
  ...over,
} as Booking)

// ── Authorization: the token IS the credential ───────────────────────────────

test('AUTHZ: an unknown token is 404, and never reveals that the route exists', async () => {
  await seed()
  const res = await get('9999888877776666')
  assert.equal(res.status, 404)
  assert.deepEqual(await res.json(), { error: 'not_found' })
})

test('AUTHZ: a malformed token is refused without reaching the store', async () => {
  await seed()
  for (const bad of ['not-a-token!!', 'short', '../../etc/passwd', '']) {
    const res = await get(bad)
    assert.equal(res.status, 404, `${JSON.stringify(bad)} must be refused`)
  }
})

test('AUTHZ: a valid assignee token resolves to that assignee only', async () => {
  await seed(mkRoute({ assignees: [assignee(), assignee({ name: 'Other Crew', token: OTHER_TOK, staffId: 's2' })] }))
  const res = await get(CREW_TOK)
  assert.equal(res.status, 200)
  const { route } = await res.json()
  assert.equal(route.routeNumber, 'JK-R-9001')
  // The scrubbed projection must not carry the other contractor or any audit trail.
  const raw = JSON.stringify(route)
  assert.equal(raw.includes('Other Crew'), false, 'never exposes another contractor')
  assert.equal(raw.includes(OTHER_TOK), false, "never exposes another contractor's token")
  assert.equal(raw.includes('audit'), false, 'never exposes the audit trail')
})

test('AUTHZ: a token bound to a DIFFERENT resource type is refused', async () => {
  await seed()
  await runWithTenant({ tenantId: TENANT }, () =>
    bindToken(OTHER_TOK, { tenantId: TENANT, resourceType: 'booking', resourceId: OTHER_TOK }))
  const res = await get(OTHER_TOK)
  assert.equal(res.status, 404, "a booking token must not open the route surface (expect: 'route')")
})

test('AUTHZ: clocking and completing are refused before the route is confirmed', async () => {
  await seed()
  for (const action of ['clock_in', 'complete']) {
    const res = await post(CREW_TOK, { action })
    assert.equal(res.status, 409, `${action} requires confirmation first`)
  }
  assert.equal((await stored(ROUTE_TOK))!.assignees![0].clockInAt, undefined, 'nothing was written')
})

// ── Idempotency: what makes an automatic retry safe ──────────────────────────

test('RETRY-SAFE: confirm replayed returns already and writes no second event', async () => {
  await seed()
  const first = await post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })
  assert.equal(first.status, 200)
  const afterFirst = (await stored(ROUTE_TOK))!
  const stamp = afterFirst.assignees![0].confirmedAt
  const events = afterFirst.events!.length

  const replay = await post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).already, true, 'a replay reports already, not a new confirm')

  const after = (await stored(ROUTE_TOK))!
  assert.equal(after.assignees![0].confirmedAt, stamp, 'the FIRST confirmation timestamp survives')
  assert.equal(after.events!.length, events, 'no duplicate event')
})

test('RETRY-SAFE: decline replayed returns already and keeps the first reason', async () => {
  await seed()
  assert.equal((await post(CREW_TOK, { action: 'decline', reason: 'first' })).status, 200)
  const stamp = (await stored(ROUTE_TOK))!.assignees![0].declinedAt

  const replay = await post(CREW_TOK, { action: 'decline', reason: 'second' })
  assert.equal((await replay.json()).already, true)
  const after = (await stored(ROUTE_TOK))!
  assert.equal(after.assignees![0].declinedAt, stamp)
  assert.equal(after.assignees![0].declineReason, 'first', 'a replay cannot rewrite the reason')
})

test('RETRY-SAFE: each punch is guarded by its own stamp; the FIRST time persists', async () => {
  await seed()
  await post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })

  assert.equal((await post(CREW_TOK, { action: 'clock_in', locationDenied: true })).status, 200)
  const inAt = (await stored(ROUTE_TOK))!.assignees![0].clockInAt
  assert.ok(inAt, 'clocked in')

  const replayIn = await post(CREW_TOK, { action: 'clock_in', locationDenied: true })
  assert.equal((await replayIn.json()).already, true)
  assert.equal((await stored(ROUTE_TOK))!.assignees![0].clockInAt, inAt,
    'a replayed punch must never move the recorded work time')

  assert.equal((await post(CREW_TOK, { action: 'clock_out', locationDenied: true })).status, 200)
  const outAt = (await stored(ROUTE_TOK))!.assignees![0].clockOutAt
  const replayOut = await post(CREW_TOK, { action: 'clock_out', locationDenied: true })
  assert.equal((await replayOut.json()).already, true)
  assert.equal((await stored(ROUTE_TOK))!.assignees![0].clockOutAt, outAt)
})

// ── Sprint 3.1 phases B/C: one engine, one race-safe policy ─────────────────

test('PHASE B: the public route delegates punch mutation to shared applyPunch', () => {
  const src = readFileSync(new URL('../app/api/route/[token]/route.ts', import.meta.url), 'utf8')
  const branch = src.slice(src.indexOf('// Timeclock —'), src.indexOf('// Idempotent —'))
  assert.match(branch, /applyPunch\(assignee, clockAction, gps, Date\.now\(\)\)/)
  assert.doesNotMatch(branch, /assignee\.clock(?:In|Out)(?:At|Lat|Lng|Accuracy|LocationDenied)\s*=/,
    'the public adapter must not grow a second punch engine again')
})

test('PHASE C: default OFF preserves the public link behaviour and performs no enforcement', async () => {
  await seed(mkRoute({ assignees: [assignee({ confirmedAt: 1 })] }))
  await seed(secondRoute({ assignees: [assignee({ token: CREW2_TOK, confirmedAt: 1 })] }))

  assert.equal((await post(CREW_TOK, { action: 'clock_in', locationDenied: true })).status, 200)
  assert.equal((await post(CREW2_TOK, { action: 'clock_in', locationDenied: true })).status, 200)
  assert.ok((await stored(ROUTE_TOK))!.assignees![0].clockInAt)
  assert.ok((await stored(ROUTE2_TOK))!.assignees![0].clockInAt)
})

test('PHASE C: concurrent same-date public clock-ins converge on exactly one open punch', async () => {
  process.env.SINGLE_OPEN_PUNCH_ENABLED = 'true'
  await seed(mkRoute({ assignees: [assignee({ confirmedAt: 1 })] }))
  await seed(secondRoute({ assignees: [assignee({ token: CREW2_TOK, confirmedAt: 1 })] }))

  const responses = await Promise.all([
    post(CREW_TOK, { action: 'clock_in', locationDenied: true }),
    post(CREW2_TOK, { action: 'clock_in', locationDenied: true }),
  ])
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409])

  const open = [
    (await stored(ROUTE_TOK))!.assignees![0],
    (await stored(ROUTE2_TOK))!.assignees![0],
  ].filter(a => a.clockInAt && !a.clockOutAt)
  assert.equal(open.length, 1, 'the staff lock closes the two-job check/write race')
})

test('PHASE C: scope matches the existing portal rule — a different service date is allowed', async () => {
  process.env.SINGLE_OPEN_PUNCH_ENABLED = 'true'
  await seed(mkRoute({ assignees: [assignee({ confirmedAt: 1 })] }))
  await seed(secondRoute({
    routeDate: '2030-01-02',
    assignees: [assignee({ token: CREW2_TOK, confirmedAt: 1 })],
  }))

  assert.equal((await post(CREW_TOK, { action: 'clock_in', locationDenied: true })).status, 200)
  assert.equal((await post(CREW2_TOK, { action: 'clock_in', locationDenied: true })).status, 200)
})

test('PHASE C: booking and route lanes block each other on the same service date', async () => {
  process.env.SINGLE_OPEN_PUNCH_ENABLED = 'true'
  process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'
  try {
    await seed(mkRoute({ assignees: [assignee({ confirmedAt: 1, clockInAt: 100 })] }))
    await runWithTenant({ tenantId: TENANT }, () => saveBooking(booking()))

    const blocked = await runWithTenant({ tenantId: TENANT }, () =>
      punchBookingClock(BOOKING_TOK, 's1', 'clock_in', { locationDenied: true }))
    assert.deepEqual(blocked, { ok: false, error: 'other_open_punch' })

    await post(CREW_TOK, { action: 'clock_out', locationDenied: true })
    const allowed = await runWithTenant({ tenantId: TENANT }, () =>
      punchBookingClock(BOOKING_TOK, 's1', 'clock_in', { locationDenied: true }))
    assert.equal(allowed.ok, true)

    delete process.env.BOOKING_ASSIGNMENT_ENABLED
    await seed(secondRoute({ assignees: [assignee({ token: CREW2_TOK, confirmedAt: 1 })] }))
    const routeBlocked = await post(CREW2_TOK, { action: 'clock_in', locationDenied: true })
    assert.equal(routeBlocked.status, 409,
      'historical booking punches remain authoritative even after booking assignment is switched off')
  } finally {
    delete process.env.BOOKING_ASSIGNMENT_ENABLED
  }
})

test('PHASE C: correction-adjusted state is authoritative', async () => {
  process.env.SINGLE_OPEN_PUNCH_ENABLED = 'true'
  await seed(mkRoute({ assignees: [assignee({ confirmedAt: 1, clockInAt: 100 })] }))
  await seed(secondRoute({ assignees: [assignee({ token: CREW2_TOK, confirmedAt: 1 })] }))

  await runWithTenant({ tenantId: TENANT }, async () => {
    const value = validateCorrection(
      { correctedClockIn: 100, correctedClockOut: 200, correctionReason: 'closed by dispatch' },
      { effectiveClockIn: 100, effectiveClockOut: null },
    )
    assert.equal(value.ok, true)
    await appendCorrection({
      punchId: punchId('route', ROUTE_TOK, 's1'), staffId: 's1', workType: 'route', jobToken: ROUTE_TOK,
      original: { clockInAt: 100, clockOutAt: null },
      value: (value as { ok: true; value: never }).value,
      actor: { userId: 'u_admin', role: 'admin' },
    } as never)
  })

  const res = await post(CREW2_TOK, { action: 'clock_in', locationDenied: true })
  assert.equal(res.status, 200, 'a correction-closed punch must not remain falsely blocking')
})

test('PHASE C: incomplete correction evidence fails closed without writing', async () => {
  process.env.SINGLE_OPEN_PUNCH_ENABLED = 'true'
  await seed(mkRoute({ assignees: [assignee({ confirmedAt: 1, clockInAt: 100 })] }))
  await seed(secondRoute({ assignees: [assignee({ token: CREW2_TOK, confirmedAt: 1 })] }))
  process.env.KV_REST_API_URL = `http://127.0.0.1:${PROXY_PORT}`
  failCorrectionReads = 1

  const res = await post(CREW2_TOK, { action: 'clock_in', locationDenied: true })
  assert.equal(res.status, 503)
  assert.equal((await stored(ROUTE2_TOK))!.assignees![0].clockInAt, undefined)
})

test('PHASE C: an incomplete route scan fails closed without writing', async () => {
  process.env.SINGLE_OPEN_PUNCH_ENABLED = 'true'
  await seed(mkRoute({ assignees: [assignee({ confirmedAt: 1 })] }))
  process.env.KV_REST_API_URL = `http://127.0.0.1:${PROXY_PORT}`
  forceIncompleteRouteScan = 1

  const res = await post(CREW_TOK, { action: 'clock_in', locationDenied: true })
  assert.equal(res.status, 503)
  assert.match((await res.json()).error, /verify your other punches/i)
  assert.equal((await stored(ROUTE_TOK))!.assignees![0].clockInAt, undefined)
})

// The booking lane needs its own case: the route scan can report complete while
// the booking scan cannot, and that is the branch MOST likely to fire in the
// field, because `bk:index` is scored by updatedAt and any concurrent booking
// write reorders it mid-scan. Missing booking evidence must fail closed too.
test('PHASE C: an incomplete booking scan fails closed without writing', async () => {
  process.env.SINGLE_OPEN_PUNCH_ENABLED = 'true'
  await seed(mkRoute({ assignees: [assignee({ confirmedAt: 1 })] }))
  process.env.KV_REST_API_URL = `http://127.0.0.1:${PROXY_PORT}`
  forceIncompleteBookingScan = 1

  const res = await post(CREW_TOK, { action: 'clock_in', locationDenied: true })
  assert.equal(res.status, 503)
  assert.match((await res.json()).error, /verify your other punches/i)
  assert.equal((await stored(ROUTE_TOK))!.assignees![0].clockInAt, undefined)
})

test('PHASE C: flag OFF retains the pre-Phase-C route adapter contract', () => {
  const publicRoute = readFileSync(new URL('../app/api/route/[token]/route.ts', import.meta.url), 'utf8')
  assert.match(publicRoute,
    /isEnabled\('SINGLE_OPEN_PUNCH_ENABLED'\)\s*&&\s*route\.routeDate !== first\.route\.routeDate/)

  const portalRoute = readFileSync(new URL('../app/api/portal/clock/route.ts', import.meta.url), 'utf8')
  assert.match(portalRoute,
    /isEnabled\('SINGLE_OPEN_PUNCH_ENABLED'\)\s*&&\s*route\.routeDate !== target\.routeDate/)
  assert.match(portalRoute,
    /: NextResponse\.json\(\{ error: 'Could not clock — please try again\.' \}, \{ status: 500 \}\)/,
    'the legacy flag-off failure status and copy remain present')
})

test('RETRY-SAFE: completion is status-idempotent, so a replay cannot restamp it', async () => {
  await seed()
  await post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })
  assert.equal((await post(CREW_TOK, { action: 'complete', note: 'first' })).status, 200)
  const first = (await stored(ROUTE_TOK))!
  const completedAt = first.completedAt

  const replay = await post(CREW_TOK, { action: 'complete', note: 'second' })
  assert.equal((await replay.json()).already, true)
  const after = (await stored(ROUTE_TOK))!
  assert.equal(after.completedAt, completedAt, 'the first completion time survives')
  assert.equal(after.completionNote, 'first', 'a replay cannot rewrite the note')
})

// ── Tenancy: the token carries its own scope ─────────────────────────────────

test('TENANCY: a token bound to another tenant does not open this route', async () => {
  const prev = process.env.TENANCY_ENABLED
  process.env.TENANCY_ENABLED = 'true'
  try {
    await seed()
    // Same token shape, bound to a DIFFERENT tenant: resolution must not fall back
    // to the ambient tenant or to an unscoped read.
    await runWithTenant({ tenantId: 'other' }, () =>
      bindToken(OTHER_TOK, { tenantId: 'other', resourceType: 'route', resourceId: OTHER_TOK }))
    const res = await get(OTHER_TOK)
    assert.equal(res.status, 404, 'a foreign-tenant token resolves to nothing here')
  } finally {
    if (prev === undefined) delete process.env.TENANCY_ENABLED; else process.env.TENANCY_ENABLED = prev
  }
})

test('TENANCY: the handler is wrapped so its body runs inside the token’s tenant', () => {
  const src = readFileSync(new URL('../app/api/route/[token]/route.ts', import.meta.url), 'utf8')
  assert.match(src, /withPublicTokenRoute\(/, 'both verbs are tenant-wrapped')
  assert.equal((src.match(/withPublicTokenRoute\(/g) ?? []).length, 2, 'GET and POST')
  assert.equal((src.match(/\{ expect: 'route' \}/g) ?? []).length, 2,
    'both refuse a token minted for another surface')
})

// ── Compatibility: existing contractor links keep working ────────────────────

test('COMPATIBILITY: the wire contract for an existing link is unchanged', async () => {
  await seed()
  const res = await get(CREW_TOK)
  assert.equal(res.status, 200)
  const body = await res.json()
  // The shape an already-delivered SMS link depends on.
  assert.ok(body.route, 'route projection present')
  assert.equal(typeof body.disclaimer, 'string', 'disclaimer still returned')
  for (const f of ['token', 'routeNumber', 'status', 'businessName', 'reportAddress', 'reportTime', 'routeDate', 'dispatchReady']) {
    assert.ok(f in body.route, `PublicRoute still carries ${f}`)
  }
  // And every verb an existing link can invoke still answers.
  await post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })
  for (const action of ['clock_in', 'clock_out', 'complete']) {
    const r = await post(CREW_TOK, { action, locationDenied: true })
    assert.ok(r.status === 200 || r.status === 409, `${action} still handled (got ${r.status})`)
  }
})

test('COMPATIBILITY: link_opened is still stamped on first open', async () => {
  await seed()
  assert.equal((await stored(ROUTE_TOK))!.assignees![0].linkOpenedAt, undefined)
  await get(CREW_TOK)
  const after = await getRouteByConfirmToken(CREW_TOK).catch(() => null)
    ?? await runWithTenant({ tenantId: TENANT }, () => getRouteByConfirmToken(CREW_TOK))
  assert.ok(after?.assignee.linkOpenedAt, 'first open is recorded')
})

// ── The client contract: retry allowlist and no queued punches ───────────────

test('CLIENT: only the four idempotent verbs may retry; completion may not', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  assert.match(src, /RETRY_SAFE_ACTIONS = new Set\(\['confirm', 'decline', 'clock_in', 'clock_out'\]\)/)
  assert.doesNotMatch(src, /RETRY_SAFE_ACTIONS = new Set\(\[[^\]]*'complete'/, 'completion is not retry-safe here')
  // Every mutation decides via the allowlist — never a bare `true`.
  const calls = src.match(/allowMutationRetry: [^,\n]+/g) ?? []
  assert.ok(calls.length >= 3, 'each mutation states its retry stance')
  for (const c of calls) {
    assert.match(c, /RETRY_SAFE_ACTIONS\.has\(/, `must consult the allowlist, got: ${c}`)
  }
})

test('CLIENT: offline refuses a punch outright and NEVER queues it', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|serviceWorker/,
    'a stored punch would record the reconnect time as the work time')
  assert.doesNotMatch(src, /\bqueue\b/i, 'nothing is deferred for later delivery')
  // The punch path refuses before it sets a busy flag, so a refusal cannot strand
  // the controls in a permanently-disabled state.
  const clockFn = src.slice(src.indexOf('async function clock('), src.indexOf('async function submitComplete('))
  assert.match(clockFn, /if \(offline\)[\s\S]{0,200}return/, 'offline is refused first')
  assert.ok(clockFn.indexOf('if (offline)') < clockFn.indexOf('setClocking(action)'),
    'the refusal precedes the busy flag')
})

test('CLIENT: going offline keeps the route visible and disables every action', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  assert.match(src, /if \(!offline\) void load\(\)/, 'reloads on reconnect, not on going offline')
  assert.doesNotMatch(src, /setRoute\(null\)/, 'offline never discards the loaded route')
  assert.match(src, /You’re offline\. Your route stays visible/)
  assert.match(src, /aria-live="polite"/, 'the retry notice is announced')
  // Confirm, decline, both punches, the picker and the completion submit all refuse.
  assert.ok((src.match(/\|\| offline/g) ?? []).length >= 6, 'every action control is gated on offline')
  // A dropped read must not be reported as a dead link. That classification moved
  // into app/route/[token]/load.ts and is proven behaviourally against an injected
  // fetcher in scripts/public-route-load-classification.test.ts — this string
  // assertion used to vouch for a message the user never actually saw, because the
  // render guard was `notFound || !route`.
  assert.match(src, /if \(notFound\) return wrap\(/, 'missing-link card is gated on a real 404 alone')
  assert.doesNotMatch(src, /if \(notFound \|\| !route\)/, 'the defect this replaced')
})


// ─────────────────────────────────────────────────────────────────────────────
// Completing a route closes the completing crew member's OPEN punch.
//
// Completion used to leave the punch open forever — nothing anywhere set
// `clockOutAt` on completion — so anyone who clocked in and then finished from
// this link stayed on the clock indefinitely. That is the guaranteed outcome of
// the normal sequence, and it produced the one stale punch found in Production.
// ─────────────────────────────────────────────────────────────────────────────

const confirmed = async () => post(CREW_TOK, { action: 'confirm', disclaimerAccepted: true })
const clockIn = () => post(CREW_TOK, { action: 'clock_in', locationDenied: true })
const complete = (extra: Record<string, unknown> = {}) => post(CREW_TOK, { action: 'complete', ...extra })
const adminComplete = async () => {
  const session = await createSessionToken()
  return ADMIN_ROUTE_PATCH(new NextRequest(`http://localhost/api/admin/routes/${ROUTE_TOK}`, {
    method: 'PATCH',
    headers: {
      cookie: `jk_admin_session=${session}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'status', status: 'completed' }),
  }), { params: Promise.resolve({ id: ROUTE_TOK }) })
}
const me = async () => (await stored(ROUTE_TOK))!.assignees![0]
const events = async (t: string) => ((await stored(ROUTE_TOK))!.events ?? []).filter(e => e.type === t).length
const audits = async (re: RegExp) => ((await stored(ROUTE_TOK))!.audit ?? []).filter(a => re.test(a.action)).length

test('AUTO CLOCK-OUT: an open punch is closed at the SAME instant as completion', async () => {
  await seed(); await confirmed(); await clockIn()
  assert.equal((await me()).clockOutAt, undefined, 'open before completion')

  const res = await complete({ note: 'done' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).clockedOut, true)

  const r = (await stored(ROUTE_TOK))!
  const a = r.assignees![0]
  assert.ok(a.clockOutAt, 'the punch was closed')
  assert.equal(a.clockOutAt, r.completedAt, 'ONE timestamp for completion and clock-out')
  assert.equal(a.clockOutLocationDenied, true, 'an automatic punch records no GPS')
  assert.equal(r.status, 'completed')
})

test('AUTO CLOCK-OUT: no punch means none is created', async () => {
  await seed(); await confirmed()
  const res = await complete()
  assert.equal(res.status, 200)
  assert.equal((await res.json()).clockedOut, false)
  const a = await me()
  assert.equal(a.clockInAt, undefined, 'no clock-in was invented')
  assert.equal(a.clockOutAt, undefined, 'no clock-out was invented')
  assert.equal(await events('clock_out'), 0, 'and no clock_out event')
})

test('AUTO CLOCK-OUT: an existing clock-out is never overwritten', async () => {
  await seed(); await confirmed(); await clockIn()
  await post(CREW_TOK, { action: 'clock_out', locationDenied: true })
  const original = (await me()).clockOutAt
  assert.ok(original)

  await complete()
  assert.equal((await me()).clockOutAt, original, 'the explicit clock-out survives')
  assert.equal(await events('clock_out'), 1, 'no second clock_out event')
})

test('AUTO CLOCK-OUT: a CORRECTION-closed punch is not overwritten', async () => {
  await seed(); await confirmed(); await clockIn()
  const a0 = await me()
  const pid = punchId('route', ROUTE_TOK, a0.staffId!)
  const closeAt = a0.clockInAt! + 3_600_000
  await runWithTenant({ tenantId: TENANT }, async () => {
    const v = validateCorrection(
      { correctedClockIn: a0.clockInAt!, correctedClockOut: closeAt, correctionReason: 'admin closed it' },
      { effectiveClockIn: a0.clockInAt!, effectiveClockOut: null },
    )
    assert.equal(v.ok, true)
    await appendCorrection({
      punchId: pid, staffId: a0.staffId!, workType: 'route', jobToken: ROUTE_TOK,
      original: { clockInAt: a0.clockInAt!, clockOutAt: null },
      value: (v as { ok: true; value: never }).value,
      actor: { userId: 'u_admin', role: 'admin' },
    } as never)
  })

  const res = await complete()
  assert.equal(res.status, 200)
  assert.equal((await res.json()).clockedOut, false, 'the effective punch was already closed')
  assert.equal((await me()).clockOutAt, undefined, 'the RAW stamp stays null — the correction owns this punch')
  assert.equal(await events('clock_out'), 0)
})

test('AUTO CLOCK-OUT: a correction-masked OPEN punch blocks completion instead of lying', async () => {
  await seed(); await confirmed(); await clockIn()
  const a0 = await me()
  const pid = punchId('route', ROUTE_TOK, a0.staffId!)
  const correctedIn = a0.clockInAt! + 60_000
  await runWithTenant({ tenantId: TENANT }, async () => {
    const v = validateCorrection(
      {
        correctedClockIn: correctedIn,
        correctedClockOut: null,
        correctionReason: 'Actual start was one minute later',
      },
      { effectiveClockIn: a0.clockInAt!, effectiveClockOut: null },
    )
    assert.equal(v.ok, true)
    await appendCorrection({
      punchId: pid, staffId: a0.staffId!, workType: 'route', jobToken: ROUTE_TOK,
      original: { clockInAt: a0.clockInAt!, clockOutAt: null },
      value: (v as { ok: true; value: never }).value,
      actor: { userId: 'u_admin', role: 'admin' },
    } as never)
  })

  const res = await complete()
  const body = await res.json()
  assert.equal(res.status, 409)
  assert.equal(body.code, 'corrected_punch_open')

  const r = (await stored(ROUTE_TOK))!
  assert.notEqual(r.status, 'completed', 'the route remains live')
  assert.equal(r.completedAt, undefined, 'no completion stamp is written')
  assert.equal(r.assignees![0].clockOutAt, undefined, 'no ineffective raw clock-out is written')
  assert.equal(await events('completed'), 0)

  const report = await runWithTenant({ tenantId: TENANT }, () => buildPunchOverlapReport(Date.now()))
  assert.equal(report.summary.punches.open, 1, 'the report and response agree that the punch is open')
})

test('ADMIN COMPLETION: an open crew punch blocks route completion without inventing payroll time', async () => {
  await seed(); await confirmed(); await clockIn()
  const before = (await me()).clockInAt

  const res = await adminComplete()
  const body = await res.json()
  assert.equal(res.status, 409)
  assert.equal(body.code, 'open_punches')
  assert.match(body.error, /Sam Contractor/)

  const r = (await stored(ROUTE_TOK))!
  assert.notEqual(r.status, 'completed')
  assert.equal(r.completedAt, undefined)
  assert.equal(r.assignees![0].clockInAt, before)
  assert.equal(r.assignees![0].clockOutAt, undefined)
})

test('AUTO CLOCK-OUT: repeated completion is idempotent — first timestamps win', async () => {
  await seed(); await confirmed(); await clockIn()
  await complete({ note: 'first' })
  const r1 = (await stored(ROUTE_TOK))!
  const firstCompleted = r1.completedAt
  const firstOut = r1.assignees![0].clockOutAt

  const again = await complete({ note: 'second' })
  assert.equal((await again.json()).already, true)

  const r2 = (await stored(ROUTE_TOK))!
  assert.equal(r2.completedAt, firstCompleted, 'completion time preserved')
  assert.equal(r2.assignees![0].clockOutAt, firstOut, 'clock-out time preserved')
  assert.equal(r2.completionNote, 'first', 'the replay cannot rewrite the note')
  assert.equal(await events('clock_out'), 1, 'exactly one clock_out event')
  assert.equal(await events('completed'), 1, 'exactly one completed event')
  assert.equal(await audits(/clocked out automatically/), 1, 'one automatic clock-out audit entry')
  assert.equal(await audits(/marked the route complete/), 1)
})

test('AUTO CLOCK-OUT: explicit clock-out remains available BEFORE completion', async () => {
  await seed(); await confirmed(); await clockIn()
  const res = await post(CREW_TOK, { action: 'clock_out', locationDenied: true })
  assert.equal(res.status, 200)
  assert.ok((await me()).clockOutAt, 'the explicit path still works')
  assert.notEqual((await stored(ROUTE_TOK))!.status, 'completed', 'and does not complete the route')
  assert.equal(await events('completed'), 0, 'clocking out is not completing')
})

test('AUTO CLOCK-OUT: concurrent completion and explicit clock-out converge on one punch', async () => {
  await seed(); await confirmed(); await clockIn()
  const [a, b] = await Promise.all([
    complete(),
    post(CREW_TOK, { action: 'clock_out', locationDenied: true }),
  ])
  assert.ok([200, 503].includes(a.status), `completion status ${a.status}`)
  assert.ok([200, 409, 503].includes(b.status), `clock-out status ${b.status}`)

  const r = (await stored(ROUTE_TOK))!
  const outs = (r.events ?? []).filter(e => e.type === 'clock_out').length
  assert.ok(outs <= 1, `at most one clock_out event, got ${outs}`)
  assert.ok(r.assignees![0].clockOutAt, 'the punch is closed exactly once')
})

test('AUTO CLOCK-OUT: an ALREADY-completed route is untouched by a later completion', async () => {
  await seed(mkRoute({ status: 'completed', assignees: [assignee({ confirmedAt: 1, clockInAt: 1 })] }))
  const before = JSON.stringify(await stored(ROUTE_TOK))
  const res = await complete()
  assert.equal((await res.json()).already, true)
  assert.equal(JSON.stringify(await stored(ROUTE_TOK)), before, 'byte-identical — no clock-out written')
})

test('AUTO CLOCK-OUT: token and tenant isolation are unchanged', async () => {
  await seed(); await confirmed(); await clockIn()
  for (const bad of ['9999888877776666', 'not-a-token!!', '']) {
    const res = await POST(new NextRequest(`http://localhost/api/route/${bad}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'complete' }),
    }), ctx(bad) as never)
    assert.equal(res.status, 404, `${JSON.stringify(bad)} must be an indistinguishable 404`)
  }
  assert.equal((await me()).clockOutAt, undefined, 'no foreign request touched the punch')
})

test('AUTO CLOCK-OUT: Timesheets and Punch Overlaps both see the closed punch', async () => {
  await seed(); await confirmed(); await clockIn()
  await complete()

  const r = (await stored(ROUTE_TOK))!
  const entries = selectTimeEntries([r], [], {})
  assert.equal(entries.length, 1)
  assert.equal(entries[0].status, 'complete', 'Timesheets sees it closed')
  assert.equal(entries[0].clockOutAt, r.completedAt)

  const rep = await runWithTenant({ tenantId: TENANT }, () => buildPunchOverlapReport(Date.now()))
  assert.equal(rep.summary.punches.open, 0, 'Punch Overlaps reports no open punch')
  assert.equal(rep.summary.punches.complete, 1)
  assert.equal(rep.summary.openDuplicates.contractorsGlobal, 0)
})

test('AUTO CLOCK-OUT: the handler decides on the EFFECTIVE punch and fails closed', () => {
  const src = readFileSync(new URL('../app/api/route/[token]/route.ts', import.meta.url), 'utf8')
  const branch = src.slice(src.indexOf("if (action === 'complete')"), src.indexOf("// Timeclock —"))
  assert.match(branch, /effectivePunch\(/, 'corrections are consulted')
  assert.match(branch, /eff\.clockInAt != null && eff\.clockOutAt == null/, 'never creates a punch')
  assert.match(branch, /const completedAt = Date\.now\(\)/, 'one timestamp')
  assert.match(branch, /assignee\.clockOutAt = completedAt/, 'the same instant closes the punch')
  assert.doesNotMatch(branch, /clockOutAt = Date\.now\(\)/, 'never a second clock read')
  // Corrections load failure must refuse to complete, not complete blindly.
  const failClosed = branch.slice(branch.indexOf('} catch {'), branch.indexOf('const photos'))
  assert.match(failClosed, /status: 503/, 'a corrections read failure refuses to complete')
  assert.doesNotMatch(failClosed, /punchOpen = |saveRoute/, 'and does not fall through to completing')
  // Exactly one save commits both mutations.
  assert.equal((branch.match(/await saveRoute\(route\)/g) ?? []).length, 1, 'one save = atomic')
})

test('AUTO CLOCK-OUT: the completion notice is CONDITIONAL, and worded as a condition', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')

  // Rendered only when the raw stamps show an open punch…
  assert.match(src, /const willClockOut = !!route\?\.clockInAt && !route\?\.clockOutAt/)
  assert.match(src, /\{willClockOut && \(/, 'the notice is conditional, not always-on')
  assert.match(src, /role="status"/, 'and is announced, not silent')

  // …but worded as a CONDITION, never an assertion. The client reads raw stamps while
  // the server decides on the effective punch, so the two can legitimately disagree
  // (an admin correction may have closed a punch whose raw clock-out is still null).
  // Hedged copy is true under both readings; an assertion would be false under one.
  const notice = src.slice(src.indexOf('{willClockOut && ('), src.indexOf('<textarea'))
  assert.match(notice, /If you’re still clocked in, completing this route will clock you out automatically\./)
  assert.doesNotMatch(notice, /You’re still clocked in/, 'never asserts the punch state')
  assert.doesNotMatch(notice, /correction|effective/i, 'no correction data reaches the public page')
})

test('AUTO CLOCK-OUT: the public projection exposes NO correction or effective-punch data', () => {
  const api = readFileSync(new URL('../app/api/route/[token]/route.ts', import.meta.url), 'utf8')
  const pub = api.slice(api.indexOf('const pub = '), api.indexOf('const pub = ') + 1200)
  for (const banned of ['effectivePunch', 'listCorrections', 'correction', 'punchOpen']) {
    assert.equal(pub.includes(banned), false, `pub() must not expose ${banned}`)
  }
  // The additive completion flag is a plain boolean, not a punch object.
  assert.match(api, /clockedOut: punchOpen/)
})

// ── The completion button is ONE stable target at every width ───────────────
//
// Every number here was MEASURED in Chrome against the Preview deployment, with
// the centred column constrained to a true 320 px viewport (320 − 36 px of main
// padding), in the page's own 800-weight 14.5 px system font. Chrome cannot be
// resized below ~400 px, so the column is constrained instead — the layout is
// fluid, so that reproduces the completion row exactly.
//
//   completion row        238 px   (the card adds ~23 px of padding each side)
//   primary button        145 px   (flex: 1, beside an 83 px Cancel and a 10 px gap)
//   TEXT ROOM             119 px   (145 − 13 px padding each side)
//
// Measured label advance widths:
const LABEL_WIDTH_320: Record<string, number> = {
  'Mark Route Complete': 156,        // current
  'Submit — Route Done': 156,        // what it replaced, on main — identical width
  'Submit — Done & Clock Out': 198,  // the rejected clock-out variant
  'Complete Route': 116,
  'Mark Complete': 110,
}
const TEXT_ROOM_320 = 119
const ROW_CHROME = 82        // measured: viewport − row width (main padding + card padding)
const COMPLETE_BUTTON = 'Mark Route Complete'

test('BUTTON: the completion label is UNCONDITIONAL — one label at every width', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  const label = src.slice(src.indexOf("busy === 'complete' ? 'Submitting…'"), src.indexOf("busy === 'complete' ? 'Submitting…'") + 90)
  assert.match(label, new RegExp(`'Submitting…' : '${COMPLETE_BUTTON}'`), 'exactly one completion label')
  assert.doesNotMatch(label, /willClockOut/, 'the label never varies on punch state')
  assert.equal(src.includes('Submit — Done & Clock Out'), false, 'the wrapping clock-out variant is gone')
})

test('BUTTON: the label is no WIDER than the one it replaced', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  const m = src.match(/busy === 'complete' \? 'Submitting…' : '([^']+)'/)
  assert.ok(m, 'the completion label must be a plain string literal')
  const current = m![1]
  // Changing the copy without re-measuring is the failure mode this catches.
  assert.ok(current in LABEL_WIDTH_320,
    `"${current}" has no measured width — re-measure at 320 px and add it to LABEL_WIDTH_320`)
  assert.ok(LABEL_WIDTH_320[current] <= LABEL_WIDTH_320['Submit — Route Done'],
    `"${current}" (${LABEL_WIDTH_320[current]}px) is wider than the label it replaced`)
})

test('BUTTON: stacked at 320 px, the label fits ONE line with room to spare', () => {
  // Side by side the primary button gets 119px of text room for a 156px label, so it
  // wrapped. Stacked full-width it gets the whole row: 238 − 26px padding = 212px.
  const stackedTextRoom = 320 - ROW_CHROME - 26
  assert.ok(stackedTextRoom >= LABEL_WIDTH_320['Mark Route Complete'],
    `${stackedTextRoom}px of stacked text room must hold the ${LABEL_WIDTH_320['Mark Route Complete']}px label on one line`)
  // No overflow either: the label is comfortably inside the card, not spilling out.
  assert.ok(LABEL_WIDTH_320['Mark Route Complete'] < stackedTextRoom,
    'and it must not merely touch the edge')
})

test('BUTTON: the completion controls clear a 44 px tap target from their OWN styles', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  const rowStart = src.indexOf('<div className="route-complete-actions">')
  const row = src.slice(rowStart, src.indexOf('</div>', src.indexOf('Cancel', rowStart)))
  const buttons = [...row.matchAll(/padding: '(\d+)px(?: (\d+)px)?'[^}]*?fontSize: ([\d.]+)/g)]
  assert.equal(buttons.length, 2, `expected both completion buttons, found ${buttons.length}`)
  for (const [, padY, , fontSize] of buttons) {
    // height = padding top+bottom + one line box (≈1.2 × font-size, the UA default).
    // Stacked, the label is ONE line, so this is the real height — not the two-line
    // 70px that the side-by-side row happened to produce.
    const height = 2 * Number(padY) + Math.ceil(Number(fontSize) * 1.2)
    assert.ok(height >= 44, `a completion control is only ${height}px tall`)
  }
})

// ── Responsive: stacked where the row cannot fit, side by side where it can ──
//
// Measured in Chrome at real viewports (a same-origin iframe, so the media query
// genuinely applies rather than a container being narrowed):
//
//                          320 px          375 px
//   available row width    238 px          293 px
//   the pair needs         275 px          275 px     (182 + 10 gap + 83)
//   verdict                cannot fit      fits
//
// So the breakpoint is 375px — the narrowest width where the row is honest.
const BREAKPOINT = 375
const PAIR_NEEDS = 275       // measured: primary(156 label + 26 padding) + gap(10) + Cancel(83)

test('RESPONSIVE: the breakpoint is where the row genuinely stops fitting', () => {
  assert.ok(BREAKPOINT - ROW_CHROME >= PAIR_NEEDS,
    `at ${BREAKPOINT}px the row has ${BREAKPOINT - ROW_CHROME}px but needs ${PAIR_NEEDS}px`)
  assert.ok(320 - ROW_CHROME < PAIR_NEEDS,
    'at 320px the row must NOT fit — otherwise stacking is gratuitous')
  // And the reason it cannot fit: side by side, the primary button's text room is
  // narrower than the label itself. That is the whole case for stacking.
  assert.ok(TEXT_ROOM_320 < LABEL_WIDTH_320['Mark Route Complete'],
    `side-by-side text room (${TEXT_ROOM_320}px) must be short of the label (${LABEL_WIDTH_320['Mark Route Complete']}px)`)
})

test('RESPONSIVE: the stylesheet stacks by default and RESTORES the row at 375px', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  const block = css.slice(css.indexOf('.route-complete-actions'))
  assert.ok(block.length > 0, 'the completion row must be styled by class, not inline')

  // Mobile-first: the BASE state is stacked, matching .cc-crew-grid / .cc-stat-grid.
  const base = block.slice(0, block.indexOf('@media'))
  assert.match(base, /flex-direction: column/, 'base state is stacked')
  assert.match(base, /\.route-complete-actions > button \{ width: 100%; \}/, 'stacked buttons are full width')

  // …and the row is RESTORED at the breakpoint, never the other way round.
  assert.match(block, new RegExp(`@media \\(min-width: ${BREAKPOINT}px\\)`), `restores at ${BREAKPOINT}px`)
  const wide = block.slice(block.indexOf('@media'))
  assert.match(wide, /flex-direction: row/, 'side by side at 375px and up')
  assert.match(wide, /width: auto/, 'and no longer full width')
  assert.match(wide, /:first-child \{ flex: 1; \}/, 'the primary button takes the slack')
  assert.doesNotMatch(block, /max-width:/, 'mobile-first only — no desktop-first override')
})

test('RESPONSIVE: layout lives in the STYLESHEET, and DOM/tab order is unchanged', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  const rowStart = src.indexOf('<div className="route-complete-actions">')
  assert.ok(rowStart > 0, 'the row carries the class')
  const row = src.slice(rowStart, src.indexOf('</div>', src.indexOf('Cancel', rowStart)))

  // Order is submit-then-cancel in BOTH layouts, because only flex-direction changes.
  assert.ok(row.indexOf('submitComplete') < row.indexOf('setCompleteMode(false)'),
    'the primary action stays first in the DOM')
  // `(?<!b)` so this catches a real `order:` property without matching `border:`.
  assert.doesNotMatch(row, /(?<!b)order:/, 'no visual reordering that would desync tab order')
  // An inline style would beat the class and the media query could never reach it —
  // which is exactly how this regresses silently.
  assert.doesNotMatch(row, /display: 'flex'/, 'no inline display')
  assert.doesNotMatch(row, /flex: 1/, 'no inline flex')
  assert.doesNotMatch(row, /width: '100%'/, 'no inline width')
})

test('BUTTON: completion is still SINGLE-ATTEMPT (PR #136 behaviour survives)', () => {
  const src = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  assert.match(src, /allowMutationRetry: RETRY_SAFE_ACTIONS\.has\('complete'\)/)
  assert.doesNotMatch(src, /RETRY_SAFE_ACTIONS = new Set\(\[[^\]]*'complete'/)
})
