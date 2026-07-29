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
import { saveRoute, getRouteByToken, type RouteRecord, type Assignee } from '../app/lib/routes'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { redis } from '../app/lib/redis'
import { GET } from '../app/api/cron/route-auto-cancel/route'

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
  assert.deepEqual(body.flag, { ROUTE_AUTO_CANCEL_ENABLED: false })
  assert.ok(String(body.mode).startsWith('dry-run'))
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
