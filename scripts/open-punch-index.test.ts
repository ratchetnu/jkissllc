// ─────────────────────────────────────────────────────────────────────────────
// Sprint 3.1 Phase C — the open-punch index.
//
// The index replaces a scan of every route and booking with two sorted-set reads.
// That is only safe if it agrees with the complete scan, so the governing test
// here is PARITY: for every scenario, the index must answer exactly what
// `enumerateOpenPunchesFromTruth` answers. Everything else — missing, stale and
// extra entries, interrupted and concurrent backfills, corrections in both
// directions, cross-lane conflicts, dateless bookings, lock loss — exists to make
// a specific way of breaking that agreement fail loudly.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

process.env.ADMIN_SESSION_SECRET ||= 'test-admin-session-secret-32byteslong!!'

const PORT = 9100 + (process.pid % 80)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { saveRoute, type RouteRecord } from '../app/lib/routes'
import { saveBooking, type Booking } from '../app/lib/bookings'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { appendCorrection, punchId, validateCorrection } from '../app/lib/time-corrections'
import { punchBookingClock } from '../app/lib/booking-assignment'
import {
  UNDATED_BUCKET, bucketFor, indexIsAuthoritative, lookupOtherOpenPunch,
  markPunchOpen, readBucket, readPunchLocation, readReadyMarker, writeReadyMarker,
  OPEN_PUNCH_INDEX_VERSION,
} from '../app/lib/timeclock/open-punch-index'
import {
  backfillOpenPunchIndex, enumerateOpenPunchesFromTruth, reconcileOpenPunchIndex,
} from '../app/lib/timeclock/open-punch-backfill'
import { withSingleOpenPunchPolicy } from '../app/lib/timeclock/punch-policy'

const TENANT = 'jkiss'
const T = <X>(fn: () => Promise<X>) => runWithTenant({ tenantId: TENANT }, fn)

let kv: ChildProcess | null = null
before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) break } catch { /* not up */ }
    await sleep(50)
  }
})
after(() => { kv?.kill('SIGKILL') })
beforeEach(async () => {
  await fetch(`http://127.0.0.1:${PORT}/__admin/flush`, { method: 'POST' }).catch(() => {})
  process.env.OPEN_PUNCH_INDEX_ENABLED = 'true'
  process.env.SINGLE_OPEN_PUNCH_ENABLED = 'true'
  process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'
})

const DAY = '2030-03-01'
const OTHER_DAY = '2030-03-02'

const route = (over: Partial<RouteRecord> = {}): RouteRecord => ({
  token: 'r0000000000000001',
  routeNumber: 'JK-R-8001',
  businessName: 'Acme',
  routeDate: DAY,
  status: 'assigned',
  createdAt: 1,
  updatedAt: 1,
  events: [],
  audit: [],
  assignees: [{ staffId: 's1', name: 'Sam', token: 'c0000000000000001', confirmedAt: 1 }],
  ...over,
} as RouteRecord)

const booking = (over: Partial<Booking> = {}): Booking => ({
  token: 'b0000000000000001',
  bookingNumber: 'JK-B-8001',
  customerName: 'Cust',
  status: 'confirmed',
  selectedDate: DAY,
  createdAt: 1,
  updatedAt: 1,
  events: [],
  assignees: [{ staffId: 's1', name: 'Sam', token: 'k0000000000000001', confirmedAt: 1 }],
  ...over,
} as Booking)

const seedRoute = (r: RouteRecord) => T(() => saveRoute(r))
const seedBooking = (b: Booking) => T(() => saveBooking(b))
const backfill = (run = 'run1') => T(() => backfillOpenPunchIndex(run, 1_000))

/** The question enforcement actually asks, answered from the INDEX. */
const indexSays = (staffId: string, date: string, self: string) =>
  T(() => lookupOtherOpenPunch(staffId, date, self))

/** The same question answered by the COMPLETE SCAN — the definition of correct. */
async function truthSays(staffId: string, date: string, self: string): Promise<boolean> {
  const truth = await T(() => enumerateOpenPunchesFromTruth())
  assert.equal(truth.complete, true, 'truth scan must be complete for a parity comparison')
  if (!truth.complete) throw new Error('unreachable')
  return truth.punches.some(p =>
    p.staffId === staffId && p.punchId !== self &&
    (p.bucket === bucketFor(date) || p.bucket === UNDATED_BUCKET))
}

/** Parity assertion — the whole point of the index. */
async function assertParity(staffId: string, date: string, self: string, label: string) {
  const [idx, truth] = [await indexSays(staffId, date, self), await truthSays(staffId, date, self)]
  assert.equal(idx.ok, true, `${label}: index lookup should succeed`)
  assert.equal(idx.ok && idx.otherOpen, truth, `${label}: index must agree with the complete scan`)
}

// ── Parity: the governing property ───────────────────────────────────────────

test('PARITY: index and complete scan agree — open, closed, cross-lane, and other-date', async () => {
  await seedRoute(route({ assignees: [{ staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 100 }] }))
  await seedRoute(route({ token: 'r0000000000000002', routeNumber: 'JK-R-8002', routeDate: OTHER_DAY,
    assignees: [{ staffId: 's1', name: 'Sam', token: 'c2', confirmedAt: 1, clockInAt: 100 }] }))
  await seedRoute(route({ token: 'r0000000000000003', routeNumber: 'JK-R-8003',
    assignees: [{ staffId: 's1', name: 'Sam', token: 'c3', confirmedAt: 1, clockInAt: 100, clockOutAt: 200 }] }))
  await seedBooking(booking())

  const r = await backfill()
  assert.equal(r.ok, true)

  await assertParity('s1', DAY, 'route:none:s1', 'open route on the day')
  await assertParity('s1', OTHER_DAY, 'route:r0000000000000002:s1', 'other-date route excludes itself')
  await assertParity('s2', DAY, 'route:none:s2', 'unrelated staff')
})

test('PARITY: a booking punch blocks a route clock-in on the same date, in both paths', async () => {
  await seedRoute(route())
  await seedBooking(booking({ assignees: [{ staffId: 's1', name: 'Sam', token: 'k1', confirmedAt: 1, clockInAt: 100 }] }))
  await backfill()

  await assertParity('s1', DAY, punchId('route', 'r0000000000000001', 's1'), 'booking blocks route')
  const idx = await indexSays('s1', DAY, punchId('route', 'r0000000000000001', 's1'))
  assert.equal(idx.ok && idx.otherOpen, true, 'the cross-lane conflict must actually block')
})

// ── Missing / stale / extra entries ──────────────────────────────────────────

test('DRIFT: a MISSING entry is reported and repaired — the dangerous direction', async () => {
  await seedRoute(route({ assignees: [{ staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 100 }] }))
  await backfill()

  // Simulate the index losing an entry that truth still says is open.
  const pid = punchId('route', 'r0000000000000001', 's1')
  await T(async () => {
    const { markPunchClosed } = await import('../app/lib/timeclock/open-punch-index')
    await markPunchClosed(pid, 's1')
  })

  const before = await T(() => reconcileOpenPunchIndex())
  assert.deepEqual(before.missing, [pid], 'a punch open in truth but absent from the index is MISSING')
  assert.equal(before.extra.length, 0)

  const after = await T(() => reconcileOpenPunchIndex({ repair: true }))
  assert.equal(after.repaired, true)
  const clean = await T(() => reconcileOpenPunchIndex())
  assert.deepEqual(clean.missing, [], 'repair must close the gap')
  await assertParity('s1', DAY, 'route:none:s1', 'after repair')
})

test('DRIFT: an EXTRA entry is reported and repaired — it wrongly blocks a real crew member', async () => {
  await seedRoute(route())            // nobody clocked in
  await backfill()
  const ghost = punchId('route', 'r0000000000000009', 's1')
  await T(() => markPunchOpen(ghost, 's1', DAY, 100))

  const blocked = await indexSays('s1', DAY, punchId('route', 'r0000000000000001', 's1'))
  assert.equal(blocked.ok && blocked.otherOpen, true, 'the phantom blocks — which is why extras matter')

  const report = await T(() => reconcileOpenPunchIndex())
  assert.deepEqual(report.extra, [ghost])
  assert.deepEqual(report.missing, [])

  await T(() => reconcileOpenPunchIndex({ repair: true }))
  await assertParity('s1', DAY, punchId('route', 'r0000000000000001', 's1'), 'after extra removed')
})

test('DRIFT: a MISFILED entry (right punch, wrong bucket) is detected and moved', async () => {
  await seedRoute(route({ assignees: [{ staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 100 }] }))
  await backfill()
  const pid = punchId('route', 'r0000000000000001', 's1')
  await T(() => markPunchOpen(pid, 's1', OTHER_DAY, 100))   // relocate it wrongly

  const report = await T(() => reconcileOpenPunchIndex())
  assert.equal(report.misfiled.length, 1)
  assert.equal(report.misfiled[0].punchId, pid)
  assert.equal(report.misfiled[0].expected, DAY)

  await T(() => reconcileOpenPunchIndex({ repair: true }))
  assert.equal(await T(() => readPunchLocation(pid)), DAY, 'repair refiles it under the true date')
  const stale = await T(() => readBucket('s1', OTHER_DAY))
  assert.equal(stale.includes(pid), false, 'and clears it from the wrong bucket')
})

// ── Backfill: interrupted, repeated, concurrent ──────────────────────────────

test('BACKFILL: the completion marker is written LAST, so an interrupted run is never authoritative', async () => {
  await seedRoute(route({ assignees: [{ staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 100 }] }))
  assert.equal(await T(() => readReadyMarker()), null, 'no marker before a run')
  assert.equal(await T(() => indexIsAuthoritative()), false, 'and therefore not authoritative')

  await backfill()
  const marker = await T(() => readReadyMarker())
  assert.equal(marker?.version, OPEN_PUNCH_INDEX_VERSION)
  assert.equal(marker?.openPunchesIndexed, 1)
  assert.equal(await T(() => indexIsAuthoritative()), true)
})

test('BACKFILL: a marker from an older layout version is NOT authoritative', async () => {
  await seedRoute(route())
  await backfill()
  await T(() => writeReadyMarker({
    version: OPEN_PUNCH_INDEX_VERSION + 1, completedAt: 1, routesScanned: 0,
    bookingsScanned: 0, openPunchesIndexed: 0, runId: 'future',
  }))
  assert.equal(await T(() => readReadyMarker()), null, 'a version this code does not understand reads as absent')
  assert.equal(await T(() => indexIsAuthoritative()), false)
})

test('BACKFILL: re-running is idempotent and clears entries that truth no longer holds', async () => {
  await seedRoute(route({ assignees: [{ staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 100 }] }))
  const first = await backfill('run1')
  assert.equal(first.ok && first.marker.openPunchesIndexed, 1)

  // The crew member clocks out; a second backfill must retract the entry.
  await seedRoute(route({ assignees: [{ staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 100, clockOutAt: 200 }] }))
  const second = await backfill('run2')
  assert.equal(second.ok, true)
  assert.equal(second.ok && second.marker.openPunchesIndexed, 0)
  assert.equal(second.ok && second.removedStale, 1, 'the stale entry is removed, not left to block')

  const report = await T(() => reconcileOpenPunchIndex())
  assert.deepEqual([report.missing, report.extra], [[], []])
})

test('BACKFILL: a concurrent second run is refused by the lease rather than interleaved', async () => {
  await seedRoute(route({ assignees: [{ staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 100 }] }))
  const [a, b] = await Promise.all([backfill('runA'), backfill('runB')])
  const outcomes = [a, b]
  assert.equal(outcomes.filter(r => r.ok).length, 1, 'exactly one run may hold the lease')
  const refused = outcomes.find(r => !r.ok)
  assert.equal(refused && !refused.ok && refused.block, 'busy')
})

test('BACKFILL: an incomplete truth scan refuses to mark the index ready', async () => {
  await seedRoute(route())
  // A booking token indexed with no readable record makes the scan incomplete.
  await T(async () => {
    const { redis } = await import('../app/lib/redis')
    await redis.zadd('bk:index', 5, 'ghost-booking-token')
  })
  const r = await backfill()
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.block, 'incomplete')
  assert.equal(await T(() => readReadyMarker()), null, 'no marker after a failed run')
  assert.equal(await T(() => indexIsAuthoritative()), false)
})

// ── Corrections in both directions ───────────────────────────────────────────

async function correct(pid: string, staffId: string, serviceDate: string,
                      original: { clockInAt: number | null; clockOutAt: number | null },
                      corrected: { correctedClockIn: number | null; correctedClockOut: number | null }) {
  await T(async () => {
    const v = validateCorrection(
      { ...corrected, correctionReason: 'dispatch adjustment' },
      { effectiveClockIn: original.clockInAt, effectiveClockOut: original.clockOutAt },
    )
    assert.equal(v.ok, true)
    await appendCorrection({
      punchId: pid, staffId, workType: pid.startsWith('booking') ? 'booking' : 'route',
      jobToken: pid.split(':')[1], serviceDate, original,
      value: (v as { ok: true; value: never }).value,
      actor: { sub: 'u_admin', role: 'admin' }, now: 5_000,
    } as never)
  })
}

test('CORRECTION-CLOSED: a correction that closes a shift retracts the index entry', async () => {
  await seedRoute(route({ assignees: [{ staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 100 }] }))
  await backfill()
  const pid = punchId('route', 'r0000000000000001', 's1')
  assert.equal(await T(() => readPunchLocation(pid)), DAY, 'open before the correction')

  await correct(pid, 's1', DAY, { clockInAt: 100, clockOutAt: null },
                { correctedClockIn: 100, correctedClockOut: 200 })

  assert.equal(await T(() => readPunchLocation(pid)), null, 'a corrected-closed punch leaves the index')
  await assertParity('s1', DAY, 'route:none:s1', 'after correction closed the shift')
})

test('CORRECTION-OPENED: a correction that reopens a shift adds the index entry back', async () => {
  await seedRoute(route({ assignees: [{ staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 100, clockOutAt: 200 }] }))
  await backfill()
  const pid = punchId('route', 'r0000000000000001', 's1')
  assert.equal(await T(() => readPunchLocation(pid)), null, 'closed before the correction')

  await correct(pid, 's1', DAY, { clockInAt: 100, clockOutAt: 200 },
                { correctedClockIn: 100, correctedClockOut: null })

  assert.equal(await T(() => readPunchLocation(pid)), DAY, 'a corrected-open punch re-enters the index')
  await assertParity('s1', DAY, 'route:none:s1', 'after correction reopened the shift')
})

// ── Dateless bookings ────────────────────────────────────────────────────────

test('DATELESS: an undated OPEN punch blocks every date — it never disappears from enforcement', async () => {
  await seedRoute(route())
  await seedBooking(booking({
    selectedDate: undefined, availableDates: [],
    assignees: [{ staffId: 's1', name: 'Sam', token: 'k1', confirmedAt: 1, clockInAt: 100 }],
  } as Partial<Booking>))
  await backfill()

  const pid = punchId('booking', 'b0000000000000001', 's1')
  assert.equal(await T(() => readPunchLocation(pid)), UNDATED_BUCKET, 'filed under the undated bucket')

  for (const date of [DAY, OTHER_DAY, '2031-12-25']) {
    const idx = await indexSays('s1', date, punchId('route', 'r0000000000000001', 's1'))
    assert.equal(idx.ok && idx.otherOpen, true, `an undated open punch must block ${date}`)
    await assertParity('s1', date, punchId('route', 'r0000000000000001', 's1'), `undated blocks ${date}`)
  }
})

test('DATELESS: clocking IN to an undated job is refused permanently, not retryably', async () => {
  await seedBooking(booking({ selectedDate: undefined, availableDates: [] } as Partial<Booking>))
  const r = await T(() => punchBookingClock('b0000000000000001', 's1', 'clock_in', { locationDenied: true }))
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.error, 'undated_job',
    'the same-service-date rule is undefined without a date, so opening a new punch is refused')
})

// ── Simultaneous clock-ins, lock loss ────────────────────────────────────────

test('SIMULTANEOUS: two same-date clock-ins under the index converge on exactly one open punch', async () => {
  await seedRoute(route())
  await seedRoute(route({ token: 'r0000000000000002', routeNumber: 'JK-R-8002',
    assignees: [{ staffId: 's1', name: 'Sam', token: 'c2', confirmedAt: 1 }] }))
  await backfill()

  let wins = 0
  const attempt = (tok: string) => T(async () =>
    withSingleOpenPunchPolicy('clock_in',
      { type: 'route', jobToken: tok, staffId: 's1', serviceDate: DAY },
      async () => {
        wins++
        await markPunchOpen(punchId('route', tok, 's1'), 's1', DAY, 100)
        return 'written'
      }))

  const results = await Promise.all([attempt('r0000000000000001'), attempt('r0000000000000002')])
  assert.equal(wins, 1, 'the per-staff lock serialises the check-then-write')
  assert.equal(results.filter(r => r.ok).length, 1)
  const loser = results.find(r => !r.ok)
  assert.ok(loser && !loser.ok && ['other_open_punch', 'busy'].includes(loser.block))
})

test('FAIL-CLOSED: an index read failure blocks the write instead of guessing', async () => {
  await seedRoute(route())
  await backfill()
  const saved = process.env.KV_REST_API_URL
  try {
    const r = await T(async () => {
      // Point the store at a dead port AFTER authority was established, so the
      // lookup itself is what fails.
      process.env.KV_REST_API_URL = 'http://127.0.0.1:1'
      return lookupOtherOpenPunch('s1', DAY, 'route:x:s1')
    })
    assert.equal(r.ok, false, 'a transport error must not read as "nobody else is clocked in"')
  } finally {
    process.env.KV_REST_API_URL = saved
  }
})

// ── Flag-OFF compatibility ───────────────────────────────────────────────────

test('FLAG-OFF: with the index flag off, no index key is written and nothing is authoritative', async () => {
  process.env.OPEN_PUNCH_INDEX_ENABLED = 'false'
  await seedRoute(route({ assignees: [{ staffId: 's1', name: 'Sam', token: 'c1', confirmedAt: 1, clockInAt: 100 }] }))

  const { syncPunchIndex } = await import('../app/lib/timeclock/open-punch-index')
  await T(() => syncPunchIndex({
    punchId: punchId('route', 'r0000000000000001', 's1'), staffId: 's1',
    serviceDate: DAY, open: true, clockInAt: 100,
  }))
  assert.deepEqual(await T(() => readBucket('s1', DAY)), [], 'no bucket entry')
  assert.equal(await T(() => readPunchLocation(punchId('route', 'r0000000000000001', 's1'))), null)
  assert.equal(await T(() => indexIsAuthoritative()), false, 'never authoritative with the flag off')
})

test('FLAG-OFF: a ready marker alone does not make the index authoritative', async () => {
  await seedRoute(route())
  await backfill()
  assert.equal(await T(() => indexIsAuthoritative()), true)
  process.env.OPEN_PUNCH_INDEX_ENABLED = 'false'
  assert.equal(await T(() => indexIsAuthoritative()), false,
    'the flag gates the READ as well as the write')
})

// ── The operational surface ──────────────────────────────────────────────────

test('API: the index surface is closed to anonymous callers on both verbs', async () => {
  const { GET, POST } = await import('../app/api/admin/operations/punch-index/route')
  const { NextRequest } = await import('next/server')
  const url = 'http://localhost/api/admin/operations/punch-index'

  const get = await T(async () => GET(new NextRequest(url), { params: Promise.resolve({}) } as never))
  assert.equal(get.status, 401, 'reading the parity report requires a session')

  const post = await T(async () => POST(
    new NextRequest(url, { method: 'POST', body: JSON.stringify({ action: 'backfill' }) }),
    { params: Promise.resolve({}) } as never))
  assert.equal(post.status, 401, 'running a backfill requires a session')

  assert.equal(await T(() => readReadyMarker()), null, 'and the refused call wrote nothing')
})

// ── Bucket reference encoding ────────────────────────────────────────────────

test('ENCODING: a staffId containing separators still round-trips through the bucket registry', async () => {
  const { encodeBucketRef, decodeBucketRef } = await import('../app/lib/timeclock/open-punch-index')
  for (const staffId of ['s1', 'staff:with:colons', 'staff with spaces', 'sräng']) {
    for (const bucket of [DAY, UNDATED_BUCKET]) {
      assert.deepEqual(decodeBucketRef(encodeBucketRef(staffId, bucket)), { staffId, bucket },
        `${staffId} / ${bucket} must survive the round trip`)
    }
  }
})
