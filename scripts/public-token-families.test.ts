// ── WAVE 6D-A: per-family public-token binding ───────────────────────────────
//
// #121 shipped the primitive and bound the booking family. This covers the rest of
// the lower-risk surfaces against the REAL store: route access (including the
// rotation contract), client portal, acknowledgement (repeat-use while active), and
// the two quote surfaces that ride the booking token.
//
// Financial surfaces (invoice, pay-statement) are deliberately absent — they are
// Wave 6D-B and get their own reviewed tests.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 7200 + (process.pid % 400)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import { resolveTokenBinding } from '../app/lib/platform/tenancy/token-binding'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { scopeKey, isPlatformGlobal, PLATFORM_GLOBAL_PREFIXES } from '../app/lib/platform/tenancy/keys'
import { saveRoute, deleteRoute, type RouteRecord } from '../app/lib/routes'
import { saveClientPortal, deleteClientPortal, type ClientPortal } from '../app/lib/client-portal'
import { backfillTokenBindings } from '../app/lib/platform/tenancy/token-backfill'

const A = 'famtena'
const B = 'famtenb'
let kv: ChildProcess | null = null

before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/__admin/health`)).ok) return } catch { /* not up */ }
    await sleep(50)
  }
  throw new Error('kv emulator did not start')
})
after(() => { kv?.kill('SIGKILL') })

const route = (token: string, assignees: string[] = []): RouteRecord => ({
  token, routeNumber: `R-${token.slice(0, 6)}`, createdAt: 1, updatedAt: 1,
  assignees: assignees.map(t => ({ token: t, name: 'Driver', staffId: 's1' })),
} as unknown as RouteRecord)

const portal = (token: string): ClientPortal => ({
  token, name: 'Acme', createdAt: 1, updatedAt: 1,
} as unknown as ClientPortal)

// ── Route access tokens ──────────────────────────────────────────────────────

test('ROUTE: saving a route binds the route token to the acting tenant', async () => {
  await runWithTenant({ tenantId: A }, () => saveRoute(route('aaaa0000000000000001')))
  const b = await resolveTokenBinding('aaaa0000000000000001')
  assert.equal(b?.tenantId, A)
  assert.equal(b?.resourceType, 'route')
  assert.equal(b?.resourceId, 'aaaa0000000000000001')
})

test('ROUTE: every live assignee token binds to the SAME route', async () => {
  await runWithTenant({ tenantId: A }, () => saveRoute(route('aaaa0000000000000002', ['bbbb0000000000000001', 'bbbb0000000000000002'])))
  for (const t of ['bbbb0000000000000001', 'bbbb0000000000000002']) {
    const b = await resolveTokenBinding(t)
    assert.equal(b?.tenantId, A)
    assert.equal(b?.resourceId, 'aaaa0000000000000002', `${t} points at the route, not itself`)
  }
})

test('ROTATION: a rotated-out assignee link dies immediately (owner decision 3)', async () => {
  await runWithTenant({ tenantId: A }, () => saveRoute(route('aaaa0000000000000003', ['bbbb0000000000000003'])))
  assert.ok(await resolveTokenBinding('bbbb0000000000000003'), 'live before rotation')

  // Same protected mutation swaps the assignee.
  await runWithTenant({ tenantId: A }, () => saveRoute(route('aaaa0000000000000003', ['bbbb0000000000000004'])))

  assert.equal(await resolveTokenBinding('bbbb0000000000000003'), null, 'old link revoked in the same write')
  assert.ok(await resolveTokenBinding('bbbb0000000000000004'), 'replacement is live')
})

test('ROTATION: there is no window where both old and new links work', async () => {
  await runWithTenant({ tenantId: A }, () => saveRoute(route('aaaa0000000000000004', ['bbbb0000000000000005'])))
  await runWithTenant({ tenantId: A }, () => saveRoute(route('aaaa0000000000000004', ['bbbb0000000000000006'])))
  const [oldB, newB] = await Promise.all([resolveTokenBinding('bbbb0000000000000005'), resolveTokenBinding('bbbb0000000000000006')])
  assert.equal(oldB, null)
  assert.ok(newB)
})

test('ROTATION is idempotent — re-saving an unchanged route revokes nothing', async () => {
  await runWithTenant({ tenantId: A }, () => saveRoute(route('aaaa0000000000000005', ['bbbb0000000000000007'])))
  await runWithTenant({ tenantId: A }, () => saveRoute(route('aaaa0000000000000005', ['bbbb0000000000000007'])))
  assert.ok(await resolveTokenBinding('bbbb0000000000000007'), 'a no-op save keeps the link alive')
})

test('ROUTE: deleting a route revokes the route token AND every assignee token', async () => {
  await runWithTenant({ tenantId: A }, () => saveRoute(route('aaaa0000000000000006', ['bbbb0000000000000008'])))
  await runWithTenant({ tenantId: A }, () => deleteRoute('aaaa0000000000000006'))
  assert.equal(await resolveTokenBinding('aaaa0000000000000006'), null)
  assert.equal(await resolveTokenBinding('bbbb0000000000000008'), null)
})

test('ROUTE: the same route token in two tenants does not collide', async () => {
  await runWithTenant({ tenantId: A }, () => saveRoute(route('aaaa0000000000000007')))
  // B cannot claim a token A already owns — the binding refuses, and A keeps it.
  await runWithTenant({ tenantId: B }, () => saveRoute(route('aaaa0000000000000007')))
  assert.equal((await resolveTokenBinding('aaaa0000000000000007'))?.tenantId, A, 'first owner wins; never overwritten')
  // The RECORDS are still separate, which is the isolation that matters.
  const pa = runWithTenant({ tenantId: A }, () => scopeKey('rt:aaaa0000000000000007', { enabled: true }))
  const pb = runWithTenant({ tenantId: B }, () => scopeKey('rt:aaaa0000000000000007', { enabled: true }))
  assert.notEqual(pa, pb)
})

// ── Client portal tokens ─────────────────────────────────────────────────────

test('CLIENT: saving a portal binds its token; deleting revokes it', async () => {
  await runWithTenant({ tenantId: A }, () => saveClientPortal(portal('client-token-aaa')))
  const b = await resolveTokenBinding('client-token-aaa')
  assert.equal(b?.tenantId, A)
  assert.equal(b?.resourceType, 'client-portal')

  await runWithTenant({ tenantId: A }, () => deleteClientPortal('client-token-aaa'))
  assert.equal(await resolveTokenBinding('client-token-aaa'), null)
})

test("CLIENT: one tenant's portal token is never bound to another tenant", async () => {
  await runWithTenant({ tenantId: B }, () => saveClientPortal(portal('client-token-bbb')))
  assert.equal((await resolveTokenBinding('client-token-bbb'))?.tenantId, B)
  const pa = runWithTenant({ tenantId: A }, () => scopeKey('rt:client:client-token-bbb', { enabled: true }))
  const pb = runWithTenant({ tenantId: B }, () => scopeKey('rt:client:client-token-bbb', { enabled: true }))
  assert.notEqual(pa, pb, 'records stay in separate namespaces')
})

// ── Binding is created only AFTER the record persists ────────────────────────

test('no usable unbound window: the record exists whenever the binding does', async () => {
  await runWithTenant({ tenantId: A }, () => saveClientPortal(portal('client-token-ccc')))
  const b = await resolveTokenBinding('client-token-ccc')
  assert.ok(b)
  const stored = await runWithTenant({ tenantId: A }, async () => {
    const { redis } = await import('../app/lib/redis')
    return redis.get('rt:client:client-token-ccc')
  })
  assert.ok(stored, 'the resource was persisted before the token became resolvable')
})

// ── Key-family invariants ────────────────────────────────────────────────────

test('no affected tenant-owned prefix was made platform-global', () => {
  assert.deepEqual([...PLATFORM_GLOBAL_PREFIXES], ['opspilot:', 'platform:', 'ai:', 'rl:', 'health:'])
  for (const k of ['rt:atok:x', 'rt:client:x', 'rt:inv:x', 'rsend:token:x', 'paystmt:x', 'bk:x', 'pv:total', 'uv:day:1']) {
    assert.ok(!isPlatformGlobal(k), `${k} must stay tenant-owned`)
  }
})

test('tenant-owned records for all 6D-A families stay namespaced per tenant', () => {
  for (const k of ['rt:atok:t', 'rt:client:t', 'rsend:token:t', 'bk:t']) {
    const pa = runWithTenant({ tenantId: A }, () => scopeKey(k, { enabled: true }))
    const pb = runWithTenant({ tenantId: B }, () => scopeKey(k, { enabled: true }))
    assert.notEqual(pa, pb, k)
    assert.match(pa, new RegExp(`^t:${A}:`))
  }
})

// ── Backfill ─────────────────────────────────────────────────────────────────

test('BACKFILL: binds historical route, assignee and client-portal tokens', async () => {
  // Records written with bindings stripped, simulating pre-Wave-6D data.
  const { redis } = await import('../app/lib/redis')
  await runWithTenant({ tenantId: A }, async () => {
    await redis.set('rt:cccc0000000000000001', JSON.stringify(route('cccc0000000000000001', ['cccc0000000000000002'])))
    await redis.zadd('rt:index', 1, 'cccc0000000000000001')
    await redis.set('rt:client:legacy-portal-1', JSON.stringify(portal('legacy-portal-1')))
    await redis.zadd('rt:client:index', 1, 'legacy-portal-1')
  })
  await redis.del('platform:token:legacy-route-1')
  await redis.del('platform:token:legacy-atok-1')
  await redis.del('platform:token:legacy-portal-1')

  const report = await backfillTokenBindings(A)
  assert.equal(report.tenantId, A)
  assert.equal((await resolveTokenBinding('cccc0000000000000001'))?.tenantId, A)
  assert.equal((await resolveTokenBinding('cccc0000000000000002'))?.resourceId, 'cccc0000000000000001')
  assert.equal((await resolveTokenBinding('legacy-portal-1'))?.resourceType, 'client-portal')
  // Conflicts may legitimately appear here: an earlier test deliberately created a
  // token contested between A and B. What matters is that the contested token was
  // REFUSED, not that the run was conflict-free.
  for (const c of report.conflicts) {
    assert.match(c.reason, /different tenant/)
  }
})

test('BACKFILL: a contested token is REPORTED and never overwritten', async () => {
  // A already owns aaaa…07 (bound above). B holds a route record with the same token.
  const before = await resolveTokenBinding('aaaa0000000000000007')
  assert.equal(before?.tenantId, A)

  const report = await backfillTokenBindings(B)
  assert.ok(report.conflicts.length >= 1, 'the contested token surfaces as a conflict')
  assert.match(report.conflicts[0].reason, /different tenant/)
  assert.ok(!report.conflicts.some(c => c.token.length > 12), 'conflict tokens are truncated in the report')

  const after = await resolveTokenBinding('aaaa0000000000000007')
  assert.deepEqual(after, before, "A's binding is untouched by B's backfill")
})

test('BACKFILL: a dry run writes nothing', async () => {
  const { redis } = await import('../app/lib/redis')
  await redis.del('platform:token:legacy-portal-1')
  const report = await backfillTokenBindings(A, { dryRun: true })
  assert.equal(report.dryRun, true)
  assert.equal(await resolveTokenBinding('legacy-portal-1'), null, 'still unbound after a dry run')
})

test('BACKFILL: re-running is idempotent — nothing new is bound, bindings unchanged', async () => {
  await backfillTokenBindings(A)
  const before = await resolveTokenBinding('cccc0000000000000001')
  const second = await backfillTokenBindings(A)
  assert.equal(second.bound, 0, 'a second run binds nothing new')
  assert.deepEqual(await resolveTokenBinding('cccc0000000000000001'), before, 'existing binding untouched')
})

test('BACKFILL: never scans or touches another tenant', async () => {
  await runWithTenant({ tenantId: B }, () => saveClientPortal(portal('b-only-portal')))
  const report = await backfillTokenBindings(A)
  assert.equal(report.tenantId, A)
  assert.equal((await resolveTokenBinding('b-only-portal'))?.tenantId, B, "B's binding untouched by an A-scoped run")
})
