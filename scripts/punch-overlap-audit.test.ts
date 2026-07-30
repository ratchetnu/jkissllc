// ─────────────────────────────────────────────────────────────────────────────
// Sprint 3.1 Phase A — punch-overlap measurement.
//
// Phase A measures whether D1 (the portal enforces one open punch, the public
// contractor link does not) has actually happened. It enforces nothing, so these
// tests are about counting correctly and leaking nothing.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { readFileSync } from 'node:fs'

process.env.ADMIN_SESSION_SECRET ||= 'test-admin-session-secret-32byteslong!!'
process.env.BOOKING_ASSIGNMENT_ENABLED = 'true'

const PORT = 8900 + (process.pid % 90)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { NextRequest } from 'next/server'
import {
  analysePunchOverlaps, intervalsOverlap, inferRoutePunchSurface, toPunchIntervals,
  type PunchInterval,
} from '../app/lib/timeclock/punch-overlaps'
import { buildPunchOverlapReport } from '../app/lib/timeclock/punch-overlap-scan'
import { saveRoute, type RouteRecord } from '../app/lib/routes'
import { saveBooking, type Booking } from '../app/lib/bookings'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { GET as overlapsGET } from '../app/api/admin/punch-overlaps/route'
import { createUserSessionToken } from '../app/api/admin/_lib/session'
import type { TimeEntry } from '../app/lib/timesheets'

let kv: ChildProcess | null = null
before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) break } catch { /* not up */ }
    await sleep(50)
  }
})
after(() => { kv?.kill('SIGKILL') })
beforeEach(async () => { await fetch(`http://127.0.0.1:${PORT}/__admin/flush`, { method: 'POST' }).catch(() => {}) })

const T0 = 1_785_000_000_000
const H = 3_600_000
const NOW = T0 + 100 * H

const iv = (o: Partial<PunchInterval> = {}): PunchInterval => ({
  staffKey: 's1', type: 'route', serviceDate: '2030-01-01',
  startAt: T0, endAt: T0 + H, surface: 'portal', ...o,
})

// ── interval algebra ─────────────────────────────────────────────────────────

test('BOUNDARY: intervals that merely touch do NOT overlap', () => {
  assert.equal(intervalsOverlap(0, 10, 10, 20), false, 'a clean handoff is not a double shift')
  assert.equal(intervalsOverlap(10, 20, 0, 10), false)
  assert.equal(intervalsOverlap(0, 10, 9, 20), true, 'one unit of genuine overlap counts')
})

test('NESTED: a punch entirely inside another overlaps', () => {
  const s = analysePunchOverlaps([
    iv({ startAt: T0, endAt: T0 + 8 * H }),
    iv({ startAt: T0 + 2 * H, endAt: T0 + 3 * H }),
  ], NOW)
  assert.equal(s.overlaps.pairsGlobal, 1)
  assert.equal(s.overlaps.contractorsGlobal, 1)
})

test('IDENTICAL: exact duplicate intervals overlap exactly once', () => {
  const s = analysePunchOverlaps([iv(), iv()], NOW)
  assert.equal(s.overlaps.pairsGlobal, 1, 'one PAIR, not two')
})

test('CROSS-MIDNIGHT: an overnight punch needs no special case', () => {
  // 22:00 -> 06:00 next day, against a punch starting at 02:00 that night.
  const s = analysePunchOverlaps([
    iv({ serviceDate: '2030-01-01', startAt: T0, endAt: T0 + 8 * H }),
    iv({ serviceDate: '2030-01-02', startAt: T0 + 4 * H, endAt: T0 + 5 * H }),
  ], NOW)
  assert.equal(s.overlaps.pairsGlobal, 1, 'overlap is measured on the timeline, not the date label')
  assert.equal(s.overlaps.pairsSameDate, 0, 'but the dates differ, so it is not a same-date overlap')
})

test('SEPARATE: non-overlapping punches produce nothing', () => {
  const s = analysePunchOverlaps([
    iv({ startAt: T0, endAt: T0 + H }),
    iv({ startAt: T0 + 5 * H, endAt: T0 + 6 * H }),
  ], NOW)
  assert.equal(s.overlaps.pairsGlobal, 0)
  assert.equal(s.openDuplicates.contractorsGlobal, 0)
})

test('DIFFERENT CONTRACTORS never overlap with each other', () => {
  const s = analysePunchOverlaps([
    iv({ staffKey: 'a', startAt: T0, endAt: T0 + 8 * H }),
    iv({ staffKey: 'b', startAt: T0, endAt: T0 + 8 * H }),
  ], NOW)
  assert.equal(s.overlaps.pairsGlobal, 0, 'two people working at once is normal')
})

// ── open punches, measured to the audit request time ─────────────────────────

test('OPEN punches are measured to `now`, and two open punches overlap', () => {
  const s = analysePunchOverlaps([
    iv({ startAt: T0, endAt: null }),
    iv({ startAt: T0 + 2 * H, endAt: null }),
  ], NOW)
  assert.equal(s.evaluatedAt, NOW)
  assert.equal(s.punches.open, 2)
  assert.equal(s.openDuplicates.contractorsGlobal, 1)
  assert.equal(s.openDuplicates.maxOpenForOneContractor, 2)
  assert.equal(s.overlaps.pairsGlobal, 1, 'both run to now, so they overlap')
  assert.equal(s.overlaps.pairsInvolvingOpenPunch, 1)
  assert.equal(s.openDuplicates.earliestOpenAt, T0)
  assert.equal(s.openDuplicates.latestOpenAt, T0 + 2 * H)
})

test('an open punch overlaps a CLOSED one that has not ended before it started', () => {
  const s = analysePunchOverlaps([
    iv({ startAt: T0, endAt: null }),
    iv({ startAt: T0 + H, endAt: T0 + 2 * H }),
  ], NOW)
  assert.equal(s.overlaps.pairsGlobal, 1)
  assert.equal(s.overlaps.pairsInvolvingOpenPunch, 1)
})

test('ONE open punch is not a duplicate', () => {
  const s = analysePunchOverlaps([iv({ startAt: T0, endAt: null })], NOW)
  assert.equal(s.openDuplicates.contractorsGlobal, 0)
  assert.equal(s.openDuplicates.maxOpenForOneContractor, 1)
})

// ── global vs same-service-date, the portal's day-scoped guard ────────────────

test('GLOBAL vs SAME-DATE are reported separately for open duplicates', () => {
  const s = analysePunchOverlaps([
    iv({ serviceDate: '2030-01-01', startAt: T0, endAt: null }),
    iv({ serviceDate: '2030-01-02', startAt: T0 + H, endAt: null }),
  ], NOW)
  assert.equal(s.openDuplicates.contractorsGlobal, 1, 'two open punches, any date')
  assert.equal(s.openDuplicates.contractorsSameDate, 0,
    "different dates — today's day-scoped portal guard would not have caught this")
})

test('two open punches on ONE date count in both figures', () => {
  const s = analysePunchOverlaps([
    iv({ serviceDate: '2030-01-01', startAt: T0, endAt: null }),
    iv({ serviceDate: '2030-01-01', startAt: T0 + H, endAt: null }),
  ], NOW)
  assert.equal(s.openDuplicates.contractorsGlobal, 1)
  assert.equal(s.openDuplicates.contractorsSameDate, 1)
})

// ── pair kinds ───────────────────────────────────────────────────────────────

test('PAIR KINDS split route/route, route/booking and booking/booking', () => {
  const s = analysePunchOverlaps([
    iv({ staffKey: 'a', type: 'route', startAt: T0, endAt: T0 + 8 * H }),
    iv({ staffKey: 'a', type: 'route', startAt: T0 + H, endAt: T0 + 2 * H }),
    iv({ staffKey: 'b', type: 'route', startAt: T0, endAt: T0 + 8 * H }),
    iv({ staffKey: 'b', type: 'booking', startAt: T0 + H, endAt: T0 + 2 * H }),
    iv({ staffKey: 'c', type: 'booking', startAt: T0, endAt: T0 + 8 * H }),
    iv({ staffKey: 'c', type: 'booking', startAt: T0 + H, endAt: T0 + 2 * H }),
  ], NOW)
  assert.deepEqual(s.overlaps.byPairKind, { 'route/route': 1, 'route/booking': 1, 'booking/booking': 1 })
  assert.equal(s.overlaps.pairsGlobal, 3)
  assert.equal(s.overlaps.contractorsGlobal, 3)
})

// ── attribution ──────────────────────────────────────────────────────────────

test('ATTRIBUTION: portal punches are identified by actorId or the portal wording', () => {
  assert.equal(inferRoutePunchSurface([{ action: 'Sam Crew clocked in from the portal', actorId: 'u_1' }], 'Sam Crew'), 'portal')
  assert.equal(inferRoutePunchSurface([{ action: 'Sam Crew clocked in from the portal' }], 'Sam Crew'), 'portal')
})

test('ATTRIBUTION: public-link punches carry neither marker', () => {
  assert.equal(inferRoutePunchSurface([{ action: 'Sam Crew clocked in · 32.77000, -96.79000' }], 'Sam Crew'), 'link')
})

test('ATTRIBUTION: a rolled-off or foreign audit trail is unattributable, not guessed', () => {
  assert.equal(inferRoutePunchSurface([], 'Sam Crew'), 'unattributable')
  assert.equal(inferRoutePunchSurface([{ action: 'Other Person clocked in · x' }], 'Sam Crew'), 'unattributable')
  assert.equal(inferRoutePunchSurface([{ action: 'route created' }], 'Sam Crew'), 'unattributable')
  assert.equal(inferRoutePunchSurface([{ action: 'Sam Crew clocked in · x' }], ''), 'unattributable')
})

test('ATTRIBUTION: overlap pairs are bucketed by BOTH sides, unattributable first', () => {
  const s = analysePunchOverlaps([
    iv({ staffKey: 'a', surface: 'link', startAt: T0, endAt: T0 + 8 * H }),
    iv({ staffKey: 'a', surface: 'portal', startAt: T0 + H, endAt: T0 + 2 * H }),
    iv({ staffKey: 'b', surface: 'portal', startAt: T0, endAt: T0 + 8 * H }),
    iv({ staffKey: 'b', surface: 'portal', startAt: T0 + H, endAt: T0 + 2 * H }),
    iv({ staffKey: 'c', surface: 'unattributable', startAt: T0, endAt: T0 + 8 * H }),
    iv({ staffKey: 'c', surface: 'link', startAt: T0 + H, endAt: T0 + 2 * H }),
  ], NOW)
  assert.equal(s.attribution.inferred, true)
  assert.equal(s.attribution.overlapPairsWithAnyLinkSide, 1)
  assert.equal(s.attribution.overlapPairsBothPortal, 1)
  assert.equal(s.attribution.overlapPairsWithUnattributableSide, 1, 'unknown wins over a link guess')
  assert.deepEqual(s.attribution.punchesBySurface, { link: 2, portal: 3, unattributable: 1 })
})

// ── invalid punches ──────────────────────────────────────────────────────────

test('INVALID punches are excluded from the timeline but still counted', () => {
  const entries = [
    { type: 'route', staffId: 's1', date: '2030-01-01', clockInAt: null, clockOutAt: null, punchId: 'route:a:s1' },
    { type: 'route', staffId: 's1', date: '2030-01-01', clockInAt: T0 + H, clockOutAt: T0, punchId: 'route:b:s1' },
    { type: 'route', staffId: 's1', date: '2030-01-01', clockInAt: T0, clockOutAt: T0 + H, punchId: 'route:c:s1' },
  ] as unknown as TimeEntry[]
  const intervals = toPunchIntervals(entries, new Map())
  assert.equal(intervals.length, 1, 'a null clock-in and a reversed punch are not placeable')
  assert.equal(intervals[0].surface, 'unattributable', 'no attribution supplied ⇒ unknown')
})

// ── end to end, through the real store ───────────────────────────────────────

const route = (o: Partial<RouteRecord>): RouteRecord => ({
  token: 'r'.repeat(16), routeNumber: 'JK-R-1', status: 'assigned', businessName: 'JW',
  reportAddress: '1 St', reportTime: '7:00 AM', routeDate: '2030-01-01',
  events: [], audit: [], createdAt: 1, updatedAt: 1, ...o,
} as RouteRecord)

test('END TO END: two open route punches for one contractor are found and reported', async () => {
  await runWithTenant({ tenantId: 'jkiss' }, async () => {
    await saveRoute(route({
      token: 'a'.repeat(16), routeNumber: 'JK-R-A',
      assignees: [{ name: 'Sam Crew', token: 'ta'.padEnd(16, '0'), staffId: 's1', confirmedAt: T0, clockInAt: T0 }],
      audit: [{ at: T0, actor: 'contractor', action: 'Sam Crew clocked in · 32.77000, -96.79000' }],
    } as unknown as Partial<RouteRecord>))
    await saveRoute(route({
      token: 'b'.repeat(16), routeNumber: 'JK-R-B',
      assignees: [{ name: 'Sam Crew', token: 'tb'.padEnd(16, '0'), staffId: 's1', confirmedAt: T0, clockInAt: T0 + H }],
      audit: [{ at: T0, actor: 'contractor', action: 'Sam Crew clocked in from the portal', actorId: 'u_1' }],
    } as unknown as Partial<RouteRecord>))
  })

  const rep = await runWithTenant({ tenantId: 'jkiss' }, () => buildPunchOverlapReport(NOW))
  assert.equal(rep.summary.openDuplicates.contractorsGlobal, 1)
  assert.equal(rep.summary.openDuplicates.contractorsSameDate, 1)
  assert.equal(rep.summary.overlaps.pairsGlobal, 1)
  assert.equal(rep.summary.overlaps.byPairKind['route/route'], 1)
  assert.equal(rep.summary.attribution.overlapPairsWithAnyLinkSide, 1, 'one side was the public link')
  assert.equal(rep.coverage.routes.scanComplete, true)
  assert.equal(rep.coverage.authoritative, true)
})

test('END TO END: a clean store reports zero and stays authoritative', async () => {
  const rep = await runWithTenant({ tenantId: 'jkiss' }, () => buildPunchOverlapReport(NOW))
  assert.equal(rep.summary.punches.total, 0)
  assert.equal(rep.summary.openDuplicates.contractorsGlobal, 0)
  assert.equal(rep.summary.overlaps.pairsGlobal, 0)
  assert.equal(rep.coverage.authoritative, true)
})

test('END TO END: booking punches are attributed to the portal by construction', async () => {
  await runWithTenant({ tenantId: 'jkiss' }, async () => {
    await saveBooking({
      token: 'c'.repeat(64), bookingNumber: 'JK-B-1', serviceType: 'junk_removal', status: 'confirmed',
      customerName: 'Cust', createdAt: 1, updatedAt: 1, selectedDate: '2030-01-01',
      assignees: [{ staffId: 's9', name: 'Bee Crew', confirmedAt: T0, clockInAt: T0 }],
    } as unknown as Booking)
  })
  const rep = await runWithTenant({ tenantId: 'jkiss' }, () => buildPunchOverlapReport(NOW))
  assert.equal(rep.summary.attribution.punchesBySurface.portal, 1)
  assert.equal(rep.summary.attribution.punchesBySurface.link, 0)
})

// ── tenancy ──────────────────────────────────────────────────────────────────

test('TENANCY: one tenant never counts another tenant’s punches', async () => {
  const prev = process.env.TENANCY_ENABLED
  process.env.TENANCY_ENABLED = 'true'
  try {
    await runWithTenant({ tenantId: 'tenX' }, () => saveRoute(route({
      token: 'x'.repeat(16), routeNumber: 'JK-R-X',
      assignees: [
        { name: 'X One', token: 'x1'.padEnd(16, '0'), staffId: 'sx', confirmedAt: T0, clockInAt: T0 },
        { name: 'X One', token: 'x2'.padEnd(16, '0'), staffId: 'sx', confirmedAt: T0, clockInAt: T0 },
      ],
    } as unknown as Partial<RouteRecord>)))
    await runWithTenant({ tenantId: 'tenY' }, () => saveRoute(route({
      token: 'y'.repeat(16), routeNumber: 'JK-R-Y',
      assignees: [{ name: 'Y One', token: 'y1'.padEnd(16, '0'), staffId: 'sy', confirmedAt: T0, clockInAt: T0 }],
    } as unknown as Partial<RouteRecord>)))

    const x = await runWithTenant({ tenantId: 'tenX' }, () => buildPunchOverlapReport(NOW))
    const y = await runWithTenant({ tenantId: 'tenY' }, () => buildPunchOverlapReport(NOW))
    assert.equal(x.coverage.routes.indexCount, 1, 'tenX sees only its own index')
    assert.equal(y.coverage.routes.indexCount, 1, 'tenY sees only its own index')
    assert.equal(y.summary.punches.open, 1, "tenY never sees tenX's second punch")
    assert.equal(y.summary.openDuplicates.contractorsGlobal, 0)
  } finally {
    if (prev === undefined) delete process.env.TENANCY_ENABLED; else process.env.TENANCY_ENABLED = prev
  }
})

test('TENANCY: the scan module names no tenant and cannot widen its own scope', () => {
  const src = readFileSync(new URL('../app/lib/timeclock/punch-overlap-scan.ts', import.meta.url), 'utf8')
  const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  assert.doesNotMatch(code, /tenantId/)
  assert.doesNotMatch(code, /runWithTenant|currentTenantId/)
})

// ── authorization ────────────────────────────────────────────────────────────

const req = () => new NextRequest('http://localhost/api/admin/punch-overlaps')
const authed = async (role: 'admin' | 'manager' | 'crew') =>
  new NextRequest('http://localhost/api/admin/punch-overlaps', {
    headers: { cookie: `jk_admin_session=${await createUserSessionToken({ id: `u_${role}`, role, staffId: role === 'crew' ? 's1' : undefined })}` },
  })

test('AUTHZ: unauthenticated is 401', async () => {
  const res = await overlapsGET(req(), { params: Promise.resolve({}) } as never)
  assert.equal(res.status, 401)
})

test('AUTHZ: manager and crew are 403 — audit:view is admin-only', async () => {
  for (const role of ['manager', 'crew'] as const) {
    const res = await overlapsGET(await authed(role), { params: Promise.resolve({}) } as never)
    assert.equal(res.status, 403, `${role} must be refused`)
  }
})

test('AUTHZ: admin receives the report', async () => {
  const res = await overlapsGET(await authed('admin'), { params: Promise.resolve({}) } as never)
  assert.equal(res.status, 200)
  const b = await res.json()
  assert.equal(b.ok, true)
  assert.ok(b.summary && b.coverage)
})

// ── no sensitive data ────────────────────────────────────────────────────────

test('NO LEAK: the payload is numbers, booleans and timestamps only', async () => {
  await runWithTenant({ tenantId: 'jkiss' }, () => saveRoute(route({
    token: 'l'.repeat(16), routeNumber: 'JK-R-SECRET', businessName: 'Secret Client Co',
    reportAddress: '999 Hidden Way',
    assignees: [{ name: 'Private Person', token: 'lk'.padEnd(16, '0'), staffId: 'staff-secret-1', confirmedAt: T0, clockInAt: T0, clockInLat: 32.77, clockInLng: -96.79 }],
  } as unknown as Partial<RouteRecord>)))

  const res = await overlapsGET(await authed('admin'), { params: Promise.resolve({}) } as never)
  const raw = JSON.stringify(await res.json())
  for (const secret of ['Private Person', 'staff-secret-1', 'JK-R-SECRET', 'Secret Client Co', '999 Hidden Way', '32.77', '-96.79', 'l'.repeat(16), 'lk']) {
    assert.equal(raw.includes(secret), false, `must not contain ${secret}`)
  }

  const leaves: unknown[] = []
  const walk = (v: unknown) => {
    if (v === null || typeof v !== 'object') { leaves.push(v); return }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x)
  }
  walk(JSON.parse(raw))
  for (const leaf of leaves) {
    const okLeaf = typeof leaf === 'number' || typeof leaf === 'boolean' || leaf === null
    assert.ok(okLeaf, `unexpected non-numeric leaf: ${JSON.stringify(leaf)}`)
  }
})

test('NO LEAK: no arrays anywhere ⇒ no per-record rows', async () => {
  const res = await overlapsGET(await authed('admin'), { params: Promise.resolve({}) } as never)
  const body = await res.json()
  const hasArray = (v: unknown): boolean =>
    Array.isArray(v) || (v !== null && typeof v === 'object' && Object.values(v as object).some(hasArray))
  assert.equal(hasArray(body.summary), false)
  assert.equal(hasArray(body.coverage), false)
})

// ── read-only ────────────────────────────────────────────────────────────────

test('READ-ONLY: the measurement writes nothing and enforces nothing', () => {
  for (const f of ['../app/lib/timeclock/punch-overlaps.ts', '../app/lib/timeclock/punch-overlap-scan.ts', '../app/api/admin/punch-overlaps/route.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8')
    const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    assert.doesNotMatch(code, /saveRoute\(|saveBooking\(|redis\.(set|del|zadd|zrem|incr)/, `${f} must not write`)
    assert.doesNotMatch(code, /isEnabled\(|hasOtherOpenPunch|clockedVia/, `${f} must not gate or enforce`)
  }
})
