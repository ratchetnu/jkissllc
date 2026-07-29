// ── WAVE 6C: public-token tenant binding ─────────────────────────────────────
//
// The blocker: every public token route is wrapped in `withTenantRoute`, which
// resolves the tenant from the SIGNED SESSION. A customer following a link from their
// email has none, so with TENANCY_ENABLED=true the wrapper throws before the handler
// runs — every public booking/invoice/route/quote link breaks.
//
// The fix reads a platform-global `platform:token:{token}` binding first, then enters
// that tenant. These tests exist to prove the binding is the ONLY pre-tenant read,
// that it carries no business data, and that it cannot be re-pointed.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { NextRequest, NextResponse } from 'next/server'

const PORT = 6800 + (process.pid % 400)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

import {
  bindToken, resolveTokenBinding, revokeTokenBinding, rotateTokenBinding,
  isValidPublicToken, TokenBindingConflictError,
} from '../app/lib/platform/tenancy/token-binding'
import { withPublicTokenRoute } from '../app/lib/platform/tenancy/with-public-token-route'
import { currentTenantId, runWithTenant } from '../app/lib/platform/tenancy/context'
import { scopeKey, isPlatformGlobal, PLATFORM_GLOBAL_PREFIXES } from '../app/lib/platform/tenancy/keys'
import { redis } from '../app/lib/redis'

const A = 'tokena'
const B = 'tokenb'
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

const withTenancy = async <T>(on: boolean, fn: () => Promise<T> | T): Promise<T> => {
  const prev = process.env.TENANCY_ENABLED
  process.env.TENANCY_ENABLED = on ? 'true' : 'false'
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.TENANCY_ENABLED; else process.env.TENANCY_ENABLED = prev
  }
}

const req = () => new NextRequest('http://localhost/api/booking/tok')
const ctx = (token: string) => ({ params: Promise.resolve({ token }) })

/** A handler that reports the tenant it ran in and reads a tenant-owned key. */
const probe = withPublicTokenRoute<{ token: string }>(async () => {
  const tid = currentTenantId()
  const physical = scopeKey('bk:the-booking', { enabled: true })
  return NextResponse.json({ tenantId: tid, physical })
})

// ── The binding itself ───────────────────────────────────────────────────────

test('a valid token resolves to its owning tenant', async () => {
  await bindToken('tok-alpha-1', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  const b = await resolveTokenBinding('tok-alpha-1')
  assert.equal(b?.tenantId, A)
  assert.equal(b?.resourceType, 'booking')
})

test('the binding lives in the PLATFORM keyspace and holds no business data', async () => {
  assert.ok(isPlatformGlobal('platform:token:x'))
  const raw = await redis.get('platform:token:tok-alpha-1')
  const parsed = JSON.parse(raw!)
  assert.deepEqual(Object.keys(parsed).sort(), ['createdAt', 'resourceId', 'resourceType', 'tenantId'])
})

test('bk: was NOT made platform-global', () => {
  assert.deepEqual([...PLATFORM_GLOBAL_PREFIXES], ['opspilot:', 'platform:', 'ai:', 'rl:', 'health:'])
  assert.ok(!isPlatformGlobal('bk:anything'))
})

test('binding is idempotent for the same tenant', async () => {
  const first = await bindToken('tok-idem', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  const second = await bindToken('tok-idem', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  assert.deepEqual(second, first, 're-binding identically returns the existing record')
})

test('re-binding a live token to a DIFFERENT tenant is REFUSED, never overwritten', async () => {
  await bindToken('tok-contested', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  await assert.rejects(
    () => bindToken('tok-contested', { tenantId: B, resourceType: 'booking', resourceId: 'bk1' }),
    TokenBindingConflictError,
  )
  assert.equal((await resolveTokenBinding('tok-contested'))?.tenantId, A, 'still bound to A')
})

test('the conflict error never names the tenant that holds the token', async () => {
  await bindToken('tok-secret', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  const err = await bindToken('tok-secret', { tenantId: B, resourceType: 'booking', resourceId: 'x' }).catch(e => e)
  assert.ok(!String(err.message).includes(A), 'no cross-tenant identifier in the message')
})

test('revocation removes the binding; the token stops resolving', async () => {
  await bindToken('tok-revoke', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  await revokeTokenBinding('tok-revoke')
  assert.equal(await resolveTokenBinding('tok-revoke'), null)
})

test('rotation binds the new token and retires the old one', async () => {
  await bindToken('tok-old-rotate', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  await rotateTokenBinding('tok-old-rotate', 'tok-new-rotate', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  assert.equal(await resolveTokenBinding('tok-old-rotate'), null)
  assert.equal((await resolveTokenBinding('tok-new-rotate'))?.tenantId, A)
})

test('malformed tokens are rejected before any lookup', async () => {
  for (const bad of ['', 'short', '../../etc/passwd', 'has spaces', 'a'.repeat(200), 'tok;DEL']) {
    assert.equal(isValidPublicToken(bad), false, `${bad} must not be a token`)
    assert.equal(await resolveTokenBinding(bad), null)
  }
})

// ── The route wrapper ────────────────────────────────────────────────────────

test('ROUTE: a token runs the handler inside its OWN tenant', async () => {
  await bindToken('tok-run-a', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  const res = await withTenancy(true, () => probe(req(), ctx('tok-run-a')))
  const j = await (res as Response).json()
  assert.equal(j.tenantId, A)
  assert.equal(j.physical, `t:${A}:bk:the-booking`)
})

test('ROUTE: the same logical booking id in two tenants does not collide', async () => {
  await bindToken('tok-run-b', { tenantId: B, resourceType: 'booking', resourceId: 'bk1' })
  const ra = await withTenancy(true, () => probe(req(), ctx('tok-run-a')))
  const rb = await withTenancy(true, () => probe(req(), ctx('tok-run-b')))
  const [ja, jb] = [await (ra as Response).json(), await (rb as Response).json()]
  assert.notEqual(ja.physical, jb.physical)
  assert.equal(ja.physical, `t:${A}:bk:the-booking`)
  assert.equal(jb.physical, `t:${B}:bk:the-booking`)
})

test("ROUTE: tenant A's token cannot reach tenant B — it only ever enters A", async () => {
  const res = await withTenancy(true, () => probe(req(), ctx('tok-run-a')))
  const j = await (res as Response).json()
  assert.notEqual(j.tenantId, B)
  assert.ok(!String(j.physical).includes(B))
})

test('ROUTE: a forged header or body tenantId has no effect', async () => {
  await bindToken('tok-forge', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  const forged = new NextRequest('http://localhost/api/booking/tok', {
    method: 'POST',
    headers: { 'x-tenant-id': B, 'x-tenant': B },
    body: JSON.stringify({ tenantId: B }),
  })
  const res = await withTenancy(true, () => probe(forged, ctx('tok-forge')))
  assert.equal((await (res as Response).json()).tenantId, A)
})

test('ROUTE: an unknown token 404s under tenancy and never runs the handler', async () => {
  let ran = false
  const h = withPublicTokenRoute<{ token: string }>(async () => { ran = true; return NextResponse.json({}) })
  const res = await withTenancy(true, () => h(req(), ctx('tok-does-not-exist')))
  assert.equal((res as Response).status, 404)
  assert.equal(ran, false, 'the handler must not execute without a tenant')
})

test('ROUTE: a revoked token behaves exactly like an unknown one (no existence leak)', async () => {
  await bindToken('tok-gone', { tenantId: A, resourceType: 'booking', resourceId: 'bk1' })
  await revokeTokenBinding('tok-gone')
  const revoked = await withTenancy(true, () => probe(req(), ctx('tok-gone')))
  const unknown = await withTenancy(true, () => probe(req(), ctx('tok-never-existed')))
  assert.equal((revoked as Response).status, (unknown as Response).status)
  assert.equal((revoked as Response).status, 404)
})

test('ROUTE: a missing/malformed token 404s', async () => {
  for (const bad of ['', 'x', 'has spaces']) {
    const res = await withTenancy(true, () => probe(req(), ctx(bad)))
    assert.equal((res as Response).status, 404)
  }
})

test('ROUTE: a token minted for another surface is refused', async () => {
  await bindToken('tok-invoice', { tenantId: A, resourceType: 'route-invoice', resourceId: 'inv1' })
  const bookingOnly = withPublicTokenRoute<{ token: string }>(
    async () => NextResponse.json({ ok: true }), { expect: 'booking' },
  )
  const res = await withTenancy(true, () => bookingOnly(req(), ctx('tok-invoice')))
  assert.equal((res as Response).status, 404)
})

test('ROUTE: no context-less bk:* read is possible — the handler always has a tenant', async () => {
  const h = withPublicTokenRoute<{ token: string }>(async () => {
    assert.ok(currentTenantId(), 'handler always runs inside a tenant')
    return NextResponse.json({ tid: currentTenantId() })
  })
  const res = await withTenancy(true, () => h(req(), ctx('tok-run-a')))
  assert.equal((await (res as Response).json()).tid, A)
})

// ── Compatibility ────────────────────────────────────────────────────────────

test('COMPAT: with tenancy OFF an UNBOUND legacy token still works (reference tenant)', async () => {
  const res = await withTenancy(false, () => probe(req(), ctx('tok-legacy-unbound')))
  assert.equal((res as Response).status, 200)
  assert.equal((await (res as Response).json()).tenantId, 'jkiss')
})

test('COMPAT: with tenancy ON an unbound token FAILS CLOSED rather than guessing', async () => {
  const res = await withTenancy(true, () => probe(req(), ctx('tok-legacy-unbound')))
  assert.equal((res as Response).status, 404, 'the reference tenant is a guess, not an answer')
})

test('COMPAT: a bound token works identically with tenancy off', async () => {
  const res = await withTenancy(false, () => probe(req(), ctx('tok-run-b')))
  assert.equal((res as Response).status, 200)
})

test('the tenant context does not escape the wrapper', async () => {
  await withTenancy(true, () => probe(req(), ctx('tok-run-a')))
  assert.equal(currentTenantId(), undefined)
})

test('an outer tenant context is restored after the wrapper returns', async () => {
  const after = await runWithTenant({ tenantId: 'outer' }, async () => {
    await withTenancy(true, () => probe(req(), ctx('tok-run-a')))
    return currentTenantId()
  })
  assert.equal(after, 'outer')
})
