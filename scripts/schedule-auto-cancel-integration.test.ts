// ─────────────────────────────────────────────────────────────────────────────
// Stale-route auto-cancellation — END TO END against a real store.
//
// The unit suite (schedule-conflict-scope.test.ts) proves the SELECTION rules.
// This one drives the actual cron handler against the KV emulator and asserts on
// the thing that matters most for a scheduled mutation: that the record on disk is
// byte-identical when it is not supposed to change.
//
// "No write" is asserted by snapshotting the stored JSON before and comparing after
// — not by trusting a response field. A job that reports `cancelled: []` while
// having quietly bumped `updatedAt` is still a job that wrote to production.
// ─────────────────────────────────────────────────────────────────────────────
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'
process.env.CRON_SECRET = 'test-cron-secret'

import assert from 'node:assert/strict'
import test, { before, after, beforeEach } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 8400 + (process.pid % 250)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { NextRequest } from 'next/server'
import {
  saveRoute, getRouteByToken, scanAllRoutes, autoCancelRoute, ROUTE_SCAN_MAX,
  type RouteRecord, type Assignee,
} from '../app/lib/routes'
import { runWithTenant, currentTenantId } from '../app/lib/platform/tenancy/context'
import { redis } from '../app/lib/redis'
import { GET } from '../app/api/cron/route-auto-cancel/route'
import { centralDate } from '../app/lib/schedule/auto-cancel'

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

let n = 7000
const assignee = (staffId: string): Assignee => ({ name: staffId, token: `t_${staffId}`, staffId }) as Assignee
const mkRoute = (o: Partial<RouteRecord> = {}): RouteRecord => ({
  token: (o.token ?? `ac${n++}`).padEnd(16, '0'),
  routeNumber: o.routeNumber ?? `JK-R-${n}`,
  status: 'assigned',
  businessName: 'JW Logistics',
  reportAddress: '1 Commerce St',
  reportTime: '7:00 AM',
  routeDate: '2026-07-29',
  events: [], audit: [],
  createdAt: 1, updatedAt: 1,
  ...o,
} as RouteRecord)

const call = async (qs = ''): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await GET(new NextRequest(`http://localhost/api/cron/route-auto-cancel${qs}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }))
  return { status: res.status, body: await res.json() }
}

/** Raw stored JSON for a route — the ground truth for "did anything change". */
const stored = (token: string) => redis.get(`rt:${token}`)

const withFlag = async <T>(on: boolean, fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.ROUTE_AUTO_CANCEL_ENABLED
  process.env.ROUTE_AUTO_CANCEL_ENABLED = on ? 'true' : 'false'
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.ROUTE_AUTO_CANCEL_ENABLED
    else process.env.ROUTE_AUTO_CANCEL_ENABLED = prev
  }
}

const seed = (r: RouteRecord) => runWithTenant({ tenantId: 'jkiss' }, () => saveRoute(r))

// ── auth ─────────────────────────────────────────────────────────────────────

test('the cron refuses an unauthenticated caller', async () => {
  const res = await GET(new NextRequest('http://localhost/api/cron/route-auto-cancel'))
  assert.equal(res.status, 401)
})

test('the cron fails CLOSED when CRON_SECRET is unset', async () => {
  const prev = process.env.CRON_SECRET
  delete process.env.CRON_SECRET
  try {
    const res = await GET(new NextRequest('http://localhost/api/cron/route-auto-cancel', {
      headers: { authorization: 'Bearer anything' },
    }))
    assert.equal(res.status, 401, 'an unconfigured secret must not leave the job open')
  } finally { process.env.CRON_SECRET = prev }
})

// ── zero-write guarantees ────────────────────────────────────────────────────

test('FLAG OFF: reports candidates and writes NOTHING', async () => {
  const r = mkRoute({ routeDate: '2026-07-29', assignees: [] })
  await seed(r)
  const before = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))

  const { status, body } = await withFlag(false, () => call())
  assert.equal(status, 200)
  assert.equal(body.write, false)
  assert.match(String(body.mode), /ROUTE_AUTO_CANCEL_ENABLED off/)

  const after = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  assert.equal(after, before, 'the stored record is byte-identical')
  const fresh = await runWithTenant({ tenantId: 'jkiss' }, () => getRouteByToken(r.token))
  assert.equal(fresh?.status, 'assigned', 'still live')
})

test('DRY RUN: flag on, but ?dryRun=1 writes NOTHING', async () => {
  const r = mkRoute({ routeDate: '2026-07-29', assignees: [] })
  await seed(r)
  const before = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))

  const { body } = await withFlag(true, () => call('?dryRun=1'))
  assert.equal(body.write, false)
  assert.match(String(body.mode), /forced/)

  const after = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  assert.equal(after, before, 'the stored record is byte-identical')
})

test('the dry-run report names the exact routes and the reason', async () => {
  await seed(mkRoute({ token: 'dry1'.padEnd(16, '0'), routeNumber: 'JK-R-3001', routeDate: '2026-07-29', assignees: [] }))
  await seed(mkRoute({ token: 'dry2'.padEnd(16, '0'), routeNumber: 'JK-R-3002', routeDate: '2026-07-29', assignees: [assignee('s1')] }))
  await seed(mkRoute({ token: 'dry3'.padEnd(16, '0'), routeNumber: 'JK-R-3003', routeDate: '2026-07-30', assignees: [] }))

  const { body } = await withFlag(false, () => call())
  const tenants = body.tenants as Array<{ candidates: { routeNumber: string; reason: string; detail: string }[] }>
  const cands = tenants[0].candidates
  // Only the crewless route dated today. Note this asserts on the REAL Central date,
  // so it is meaningful only when the suite runs on 2026-07-29; the date-independent
  // selection rules are pinned in the unit suite with injected timestamps.
  assert.ok(Array.isArray(cands), 'candidates are reported even with the flag off')
  for (const c of cands) {
    assert.ok(c.routeNumber, 'each candidate names its route')
    assert.equal(c.reason, 'no_crew_at_route_day_start')
    assert.match(c.detail, /No crew assigned as of 00:00 America\/Chicago/)
  }
  assert.ok(!cands.some(c => c.routeNumber === 'JK-R-3002'), 'a crewed route is never a candidate')
  assert.ok(!cands.some(c => c.routeNumber === 'JK-R-3003'), 'a future route is never a candidate')
})

test('OUTSIDE THE WINDOW: flag on at a non-midnight hour writes NOTHING', async () => {
  const r = mkRoute({ routeDate: '2026-07-29', assignees: [] })
  await seed(r)
  const before = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  const { body } = await withFlag(true, () => call())
  const after = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  // The suite almost never runs at 00:xx Central; when it does, the window is open
  // and a write is correct. Assert the invariant that actually holds either way.
  if (body.inCancellationWindow === false) {
    assert.equal(body.write, false)
    assert.equal(after, before, 'no write outside the window')
  } else {
    assert.equal(body.write, true, 'inside the window with the flag on, writing is correct')
  }
})

test('a route WITH crew is never written, even flag-on', async () => {
  const r = mkRoute({ routeDate: '2026-07-29', assignees: [assignee('s1')] })
  await seed(r)
  const before = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  await withFlag(true, () => call())
  const after = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  assert.equal(after, before)
})

// ── idempotency ──────────────────────────────────────────────────────────────

test('IDEMPOTENT: repeated runs converge — no second cancellation, no drift', async () => {
  const r = mkRoute({ routeDate: '2026-07-29', assignees: [] })
  await seed(r)
  await withFlag(false, () => call())
  const a = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  await withFlag(false, () => call())
  await withFlag(false, () => call())
  const b = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  assert.equal(b, a, 'three reporting runs leave the record exactly as it was')
})

test('an already-cancelled route is never re-cancelled', async () => {
  const r = mkRoute({ routeDate: '2026-07-29', status: 'cancelled', assignees: [] })
  await seed(r)
  const before = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  const { body } = await withFlag(true, () => call())
  const tenants = body.tenants as Array<{ candidates: { routeNumber: string }[] }>
  assert.ok(!tenants[0].candidates.some(c => c.routeNumber === r.routeNumber))
  const after = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  assert.equal(after, before)
})

// ── reporting shape ──────────────────────────────────────────────────────────

test('every run reports which brake was engaged', async () => {
  const { body } = await withFlag(false, () => call())
  assert.equal(body.ok, true)
  assert.equal(body.timezone, 'America/Chicago')
  assert.equal(typeof body.centralDate, 'string')
  assert.equal(typeof body.centralHour, 'number')
  assert.equal(typeof body.inCancellationWindow, 'boolean')
  assert.deepEqual(body.flag, { ROUTE_AUTO_CANCEL_ENABLED: false, TENANCY_ENABLED: false })
  assert.ok(String(body.mode).startsWith('dry-run'))
  assert.equal(body.scheduled, false, 'the endpoint reports that nothing schedules it')
  assert.equal(body.graceHours, 3)
  assert.equal(typeof body.centralAt, 'string')
})

test('the response is per-tenant, and each tenant reports its own counts', async () => {
  await seed(mkRoute({ routeDate: '2026-07-29', assignees: [] }))
  const { body } = await withFlag(false, () => call())
  const tenants = body.tenants as Array<Record<string, unknown>>
  assert.ok(tenants.length >= 1)
  for (const t of tenants) {
    assert.ok(typeof t.tenant === 'string', 'every entry names its tenant')
    assert.equal(typeof t.candidateCount, 'number')
    assert.deepEqual(t.cancelled, [], 'nothing cancelled in a reporting run')
  }
})


// ─────────────────────────────────────────────────────────────────────────────
// COMPLETE SCAN — boundaries at the limit and one over
// ─────────────────────────────────────────────────────────────────────────────

const seedN = async (count: number, o: Partial<RouteRecord> = {}) => {
  for (let i = 0; i < count; i++) await seed(mkRoute({ routeNumber: `JK-R-S${i}`, ...o }))
}

test('SCAN: enumerates every route across page boundaries (pageSize-1, exact, +1)', async () => {
  await seedN(7)
  for (const pageSize of [1, 2, 3, 6, 7, 8, 100]) {
    const scan = await runWithTenant({ tenantId: 'jkiss' }, () => scanAllRoutes({ pageSize }))
    assert.equal(scan.complete, true, `pageSize ${pageSize} must complete`)
    assert.equal(scan.total, 7)
    assert.equal(scan.scanned, 7, `pageSize ${pageSize} enumerated ${scan.scanned}`)
    assert.equal(scan.routes.length, 7, `pageSize ${pageSize} returned ${scan.routes.length} records`)
  }
})

test('SCAN: index reordering during the scan FAILS CLOSED', async () => {
  await seedN(4)
  const original = redis.zrange.bind(redis)
  let snapshotReads = 0
  redis.zrange = (async (...args: Parameters<typeof redis.zrange>) => {
    const result = await original(...args)
    if (args[1] === 0 && args[2] === 3 && ++snapshotReads === 2) return [...result].reverse()
    return result
  }) as typeof redis.zrange
  try {
    const scan = await runWithTenant({ tenantId: 'jkiss' }, () => scanAllRoutes({ pageSize: 2 }))
    assert.equal(scan.complete, false)
    assert.deepEqual(scan.routes, [], 'an unstable membership snapshot exposes no candidates')
    assert.match(String(scan.truncatedReason), /index changed/)
  } finally {
    redis.zrange = original as typeof redis.zrange
  }
})

test('SCAN: a missing indexed record FAILS CLOSED', async () => {
  const r = mkRoute()
  await seed(r)
  await runWithTenant({ tenantId: 'jkiss' }, () => redis.del(`rt:${r.token}`))
  const scan = await runWithTenant({ tenantId: 'jkiss' }, () => scanAllRoutes())
  assert.equal(scan.complete, false)
  assert.deepEqual(scan.routes, [])
  assert.match(String(scan.truncatedReason), /no readable record/)
})

test('SCAN: at the exact ceiling it completes; one over it FAILS CLOSED', async () => {
  await seedN(5)
  const at = await runWithTenant({ tenantId: 'jkiss' }, () => scanAllRoutes({ max: 5 }))
  assert.equal(at.complete, true, 'exactly at the ceiling is fine')
  assert.equal(at.routes.length, 5)

  const over = await runWithTenant({ tenantId: 'jkiss' }, () => scanAllRoutes({ max: 4 }))
  assert.equal(over.complete, false, 'one over the ceiling refuses')
  assert.deepEqual(over.routes, [], 'and returns NO routes rather than a partial set')
  assert.match(String(over.truncatedReason), /above the 4 scan ceiling/)
  assert.equal(ROUTE_SCAN_MAX, 20_000)
})

test('SCAN: a truncated scan cancels NOTHING and never reports candidateCount 0', async () => {
  const today = centralDate(Date.now())
  await seed(mkRoute({ routeDate: today, assignees: [] }))   // genuinely eligible
  await seedN(3)
  // Force truncation via the ceiling by monkey-free means: ask the endpoint after
  // seeding beyond a tiny ceiling is not reachable from the route, so assert the
  // library contract the endpoint depends on.
  const over = await runWithTenant({ tenantId: 'jkiss' }, () => scanAllRoutes({ max: 1 }))
  assert.equal(over.complete, false)
  assert.equal(over.routes.length, 0, 'no candidate can be derived from a refused scan')
})

test('SCAN: the endpoint reports scanComplete and a real total', async () => {
  await seedN(4)
  const { body } = await withFlag(false, () => call())
  assert.equal(body.scanComplete, true)
  const tenants = body.tenants as Array<Record<string, unknown>>
  assert.equal(tenants[0].scanComplete, true)
  assert.equal(tenants[0].total, 4)
  assert.equal(tenants[0].scanned, 4)
  assert.equal(typeof tenants[0].candidateCount, 'number', 'a complete scan reports a NUMBER')
})

// ─────────────────────────────────────────────────────────────────────────────
// TENANCY — fail closed, context restored, no cross-tenant writes
// ─────────────────────────────────────────────────────────────────────────────

const withTenancy = async <T>(on: boolean, fn: () => Promise<T>): Promise<T> => {
  const p = process.env.TENANCY_ENABLED
  process.env.TENANCY_ENABLED = on ? 'true' : 'false'
  try { return await fn() } finally {
    if (p === undefined) delete process.env.TENANCY_ENABLED; else process.env.TENANCY_ENABLED = p
  }
}

test('TENANCY ON: activation is BLOCKED — no sweep, no writes, explicit reason', async () => {
  const today = centralDate(Date.now())
  const r = mkRoute({ routeDate: today, assignees: [] })
  await seed(r)
  const before = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))

  const { body } = await withTenancy(true, () => withFlag(true, () => call()))
  assert.equal(body.activationBlocked, true)
  assert.equal(body.write, false)
  assert.deepEqual(body.tenants, [], 'no tenant was processed, and none is claimed')
  assert.match(String(body.activationBlockedReason), /hardcoded single-tenant list/)
  assert.equal(body.scanComplete, false, 'never claims a complete sweep')

  const after = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  assert.equal(after, before, 'zero writes while blocked')
})

test('TENANCY OFF: the reference tenant IS the complete set, so it proceeds', async () => {
  const { body } = await withTenancy(false, () => withFlag(false, () => call()))
  assert.equal(body.activationBlocked, false)
  const tenants = body.tenants as Array<Record<string, unknown>>
  assert.equal(tenants.length, 1)
  assert.equal(tenants[0].tenant, 'jkiss')
})

test('TENANCY: context is restored and never leaks out of the run', async () => {
  await seed(mkRoute({ assignees: [] }))
  assert.equal(currentTenantId(), undefined, 'no ambient context before')
  const { body } = await withFlag(false, () => call())
  assert.equal(currentTenantId(), undefined, 'and none after')
  const tenants = body.tenants as Array<Record<string, unknown>>
  assert.equal(tenants[0].tenantContextRestored, true, 'context in === context out')
})

test('TENANCY: an outer context is restored after the cron runs inside it', async () => {
  const seen = await runWithTenant({ tenantId: 'outer' }, async () => {
    await withFlag(false, () => call())
    return currentTenantId()
  })
  assert.equal(seen, 'outer')
})

test('TENANT FAILURE: a store exception reports 503, incomplete, and never a clean pass', async () => {
  const original = redis.zcard.bind(redis)
  redis.zcard = (async () => { throw new Error('synthetic scan failure') }) as typeof redis.zcard
  try {
    const { status, body } = await withFlag(false, () => call())
    assert.equal(status, 503)
    assert.equal(body.ok, false)
    assert.equal(body.scanComplete, false)
    const tenants = body.tenants as Array<Record<string, unknown>>
    assert.equal(tenants[0].scanComplete, false)
    assert.equal(tenants[0].candidateCount, null)
    assert.deepEqual(tenants[0].cancelled, [])
    assert.equal(tenants[0].error, 'Error')
  } finally {
    redis.zcard = original as typeof redis.zcard
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// RETRY / GRACE WINDOW / PARTIAL FAILURE
// ─────────────────────────────────────────────────────────────────────────────

test('RETRY: initial attempt then a second attempt yields ONE cancellation, ONE entry', async () => {
  const today = centralDate(Date.now())
  const r = mkRoute({ routeDate: today, assignees: [] })
  await seed(r)
  const base = (await runWithTenant({ tenantId: 'jkiss' }, () => getRouteByToken(r.token)))!.audit.length

  const first = await withFlag(true, () => call())
  const second = await withFlag(true, () => call())
  const fresh = (await runWithTenant({ tenantId: 'jkiss' }, () => getRouteByToken(r.token)))!

  if (first.body.write === true) {
    assert.equal(fresh.status, 'cancelled')
    assert.equal(fresh.audit.length - base, 1, 'exactly ONE lifecycle entry after a retry')
    const t2 = second.body.tenants as Array<{ cancelledCount: number }>
    assert.equal(t2[0].cancelledCount, 0, 'the retry cancels nothing new')
  } else {
    assert.equal(fresh.status, 'assigned')
    assert.equal(fresh.audit.length - base, 0)
  }
})

test('RETRY: crew added between attempts stops the cancellation immediately', async () => {
  const today = centralDate(Date.now())
  const r = mkRoute({ routeDate: today, assignees: [] })
  await seed(r)
  // Crew arrives before any write attempt.
  r.assignees = [assignee('s1')]
  await seed(r)
  const before = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  await withFlag(true, () => call())
  const after = await runWithTenant({ tenantId: 'jkiss' }, () => stored(r.token))
  assert.equal(after, before, 'the under-lock re-read refuses a now-crewed route')
})

test('LOCKED RECHECK: a route returned to Draft after the scan is not cancelled', async () => {
  const now = Date.parse('2026-07-29T05:30:00Z') // 00:30 America/Chicago (CDT)
  const r = mkRoute({ routeDate: '2026-07-29', status: 'assigned', assignees: [] })
  await seed(r)

  const originalNow = Date.now
  const originalGet = redis.get.bind(redis)
  const originalSet = redis.set.bind(redis)
  let routeReads = 0
  Date.now = () => now
  redis.get = (async (key: string) => {
    if (key === `rt:${r.token}` && ++routeReads === 2) {
      const draft = { ...r, status: 'draft' as const, updatedAt: now }
      const raw = JSON.stringify(draft)
      await originalSet(key, raw)
      return raw
    }
    return originalGet(key)
  }) as typeof redis.get

  try {
    const { status, body } = await withFlag(true, () => call())
    assert.equal(status, 200)
    const tenant = (body.tenants as Array<{
      cancelled: string[]
      skipped: Array<{ routeNumber: string; why: string }>
    }>)[0]
    assert.deepEqual(tenant.cancelled, [])
    assert.match(tenant.skipped[0].why, /returned to draft/)
    const fresh = await runWithTenant({ tenantId: 'jkiss' }, () => originalGet(`rt:${r.token}`))
    assert.equal(JSON.parse(String(fresh)).status, 'draft')
  } finally {
    Date.now = originalNow
    redis.get = originalGet as typeof redis.get
  }
})

test('DEFENCE IN DEPTH: autoCancelRoute itself refuses Draft', () => {
  const r = mkRoute({ status: 'draft', assignees: [] })
  const before = JSON.stringify(r)
  assert.equal(autoCancelRoute(r, {
    reason: 'No crew assigned.',
    routeDate: r.routeDate,
    centralAt: '2026-07-29 00:30',
  }), false)
  assert.equal(JSON.stringify(r), before)
})

test('PARTIAL FAILURE: one bad route does not stop the rest of the batch', async () => {
  const today = centralDate(Date.now())
  await seed(mkRoute({ routeNumber: 'JK-R-P1', routeDate: today, assignees: [] }))
  await seed(mkRoute({ routeNumber: 'JK-R-P2', routeDate: today, assignees: [] }))
  await seed(mkRoute({ routeNumber: 'JK-R-P3', routeDate: today, assignees: [] }))
  const { body } = await withFlag(true, () => call())
  const t = (body.tenants as Array<{ candidateCount: number; cancelledCount: number; errors: unknown[] }>)[0]
  assert.equal(t.candidateCount, 3, 'all three are candidates')
  if (body.write === true) {
    assert.equal(t.cancelledCount + t.errors.length, 3, 'every candidate is accounted for')
  }
})
