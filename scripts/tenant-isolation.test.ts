// Tenant isolation properties: no cross-tenant access, fail-closed, authoritative
// session identity, forged headers ignored, platform-global allowlist.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

import { scopeKey } from '../app/lib/platform/tenancy/keys'
import { runWithTenant } from '../app/lib/platform/tenancy/context'
import { createUserSessionToken, getPrincipal, requireTenantSession, COOKIE_NAME } from '../app/api/admin/_lib/session'

// A tiny in-memory KV keyed by the PHYSICAL (scoped) key — models real isolation.
function store() {
  const m = new Map<string, string>()
  return {
    set: (logicalKey: string, tenantId: string, v: string) => m.set(scopeKey(logicalKey, { enabled: true, tenantId }), v),
    get: (logicalKey: string, tenantId: string) => m.get(scopeKey(logicalKey, { enabled: true, tenantId })) ?? null,
  }
}

test('Tenant A and Tenant B resolve to DIFFERENT physical keys', () => {
  const a = scopeKey('bk:1', { enabled: true, tenantId: 'alpha' })
  const b = scopeKey('bk:1', { enabled: true, tenantId: 'bravo' })
  assert.notEqual(a, b)
})

test('Tenant A cannot READ Tenant B records', () => {
  const kv = store()
  kv.set('bk:1', 'bravo', 'BRAVO-SECRET')
  assert.equal(kv.get('bk:1', 'alpha'), null, 'alpha must not see bravo data')
  assert.equal(kv.get('bk:1', 'bravo'), 'BRAVO-SECRET')
})

test('Tenant A cannot OVERWRITE Tenant B records', () => {
  const kv = store()
  kv.set('bk:1', 'bravo', 'BRAVO')
  kv.set('bk:1', 'alpha', 'ALPHA') // writes to a different physical key
  assert.equal(kv.get('bk:1', 'bravo'), 'BRAVO', 'bravo value is untouched')
  assert.equal(kv.get('bk:1', 'alpha'), 'ALPHA')
})

test('missing tenant context fails closed (no silent global write)', () => {
  assert.throws(() => scopeKey('bk:1', { enabled: true }), /tenant context required/)
})

test('platform-global keys stay accessible with no tenant', () => {
  assert.equal(scopeKey('ai:cost:x', { enabled: true }), 'ai:cost:x')
  assert.equal(scopeKey('rl:login:ip', { enabled: true }), 'rl:login:ip')
})

test('session tenant identity is authoritative; a forged x-tenant-id header is ignored', async () => {
  const token = await createUserSessionToken({ id: 'u1', role: 'admin', tenantId: 'jkiss' })
  const req = new NextRequest('http://localhost/api/admin/x', {
    headers: { cookie: `${COOKIE_NAME}=${token}`, 'x-tenant-id': 'evil-tenant' },
  })
  const who = await getPrincipal(req)
  assert.equal(who?.tenantId, 'jkiss', 'tenant comes from the signed token, not the header')
  const tp = await requireTenantSession(req)
  assert.ok(!(tp instanceof NextResponse))
  if (!(tp instanceof NextResponse)) assert.equal(tp.tenantId, 'jkiss')
})

test('legacy mode preserves single-tenant behavior; tenant mode scopes', () => {
  assert.equal(scopeKey('bk:1', { enabled: false }), 'bk:1')
  const scoped = runWithTenant({ tenantId: 'jkiss' }, () => scopeKey('bk:1', { enabled: true }))
  assert.equal(scoped, 't:jkiss:bk:1')
})
