// Tenancy foundation: seed, principal, key-namespacing contract, cross-tenant denial,
// and the tenant-aware session guard. NOTHING here writes to Redis or wires into a
// live path — it validates the typed foundation.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

import { DEFAULT_TENANT_ID } from '../app/lib/platform/tenancy/types'
import { JKISS_TENANT } from '../app/lib/platform/tenancy/jkiss'
import { buildTenantPrincipal, isSameTenant } from '../app/lib/platform/tenancy/principal'
import { tenantKey, resolveTenantId, assertTenant } from '../app/lib/platform/tenancy/tenant-store'
import { runWithTenant, getTenantContext, currentTenantId } from '../app/lib/platform/tenancy/context'
import { COMPANY } from '../app/lib/company'
import { createUserSessionToken, requireTenantSession, COOKIE_NAME } from '../app/api/admin/_lib/session'

test('reference tenant id is stable and NOT derived from the display name', () => {
  assert.equal(DEFAULT_TENANT_ID, 'jkiss')
  assert.equal(JKISS_TENANT.id, 'jkiss')
  assert.notEqual(JKISS_TENANT.id, JKISS_TENANT.displayName)
})

test('J KISS tenant seed mirrors company.ts byte-for-byte', () => {
  assert.equal(JKISS_TENANT.displayName, COMPANY.legalName)
  assert.equal(JKISS_TENANT.legal.dotNumber, COMPANY.usdot)
  assert.equal(JKISS_TENANT.legal.mcNumber, COMPANY.mc)
  assert.equal(JKISS_TENANT.brand.primaryColor, COMPANY.brand.red)
  assert.equal(JKISS_TENANT.brand.emailFromAddress, COMPANY.emailFrom)
})

test('tenantKey is backward-compatible: tenancy OFF returns the key UNCHANGED', () => {
  assert.equal(tenantKey('jkiss', 'bk:index', { enabled: false }), 'bk:index')
  assert.equal(tenantKey(null, 'staff:index', { enabled: false }), 'staff:index')
})

test('tenantKey isolates namespaces when tenancy is ON', () => {
  assert.equal(tenantKey('jkiss', 'bk:1', { enabled: true }), 't:jkiss:bk:1')
  assert.equal(tenantKey('acme', 'bk:1', { enabled: true }), 't:acme:bk:1')
  // Same logical key, two tenants → two physically distinct keys (no collision).
  assert.notEqual(tenantKey('jkiss', 'bk:1', { enabled: true }), tenantKey('acme', 'bk:1', { enabled: true }))
})

test('tenantKey fails closed on a missing tenant when tenancy is ON', () => {
  assert.throws(() => tenantKey(undefined, 'bk:1', { enabled: true }))
  assert.throws(() => assertTenant(''))
})

test('resolveTenantId never silently defaults to a shared tenant when tenancy is ON', () => {
  assert.equal(resolveTenantId(null, { enabled: false }), DEFAULT_TENANT_ID) // continuity when off
  assert.equal(resolveTenantId('acme', { enabled: true }), 'acme')
  assert.equal(resolveTenantId(null, { enabled: true }), null) // fail closed, not a default
})

test('buildTenantPrincipal materializes the role permission set', () => {
  const admin = buildTenantPrincipal({ sub: 'owner', role: 'admin' })
  assert.equal(admin.tenantId, DEFAULT_TENANT_ID)
  assert.equal(admin.authSource, 'legacy-admin')
  assert.ok(admin.permissions.includes('settings:manage'))
  assert.ok(admin.permissions.includes('roles:manage'))

  const crew = buildTenantPrincipal({ sub: 'u_9', role: 'crew', staffId: 's_9' })
  assert.equal(crew.staffId, 's_9')
  assert.equal(crew.authSource, 'password')
  assert.ok(crew.permissions.includes('self:view'))
  assert.ok(!crew.permissions.includes('settings:manage'), 'crew must not hold admin perms')
})

test('cross-tenant denial: principals in different tenants are never same-tenant', () => {
  const a = buildTenantPrincipal({ sub: 'u1', role: 'manager' }, { tenantId: 'jkiss' })
  const b = buildTenantPrincipal({ sub: 'u2', role: 'manager' }, { tenantId: 'acme' })
  assert.equal(isSameTenant(a, a), true)
  assert.equal(isSameTenant(a, b), false)
})

test('tenant context flows through an async scope and is absent outside it', () => {
  assert.equal(getTenantContext(), undefined)
  const seen = runWithTenant({ tenantId: 'acme' }, () => currentTenantId())
  assert.equal(seen, 'acme')
  assert.equal(currentTenantId(), undefined, 'context must not leak past its scope')
})

test('requireTenantSession resolves the tenant from the signed token (default tenant)', async () => {
  const token = await createUserSessionToken({ id: 'u_1', role: 'manager' })
  const req = new NextRequest('http://localhost/api/admin/x', { headers: { cookie: `${COOKIE_NAME}=${token}` } })
  const who = await requireTenantSession(req)
  assert.ok(!(who instanceof NextResponse))
  if (!(who instanceof NextResponse)) {
    assert.equal(who.tenantId, 'jkiss')
    assert.equal(who.role, 'manager')
    assert.ok(who.permissions.length > 0)
  }
})

test('requireTenantSession carries an explicit synthetic tenant end-to-end', async () => {
  const token = await createUserSessionToken({ id: 'u_2', role: 'admin', tenantId: 'acme' })
  const req = new NextRequest('http://localhost/api/admin/x', { headers: { cookie: `${COOKIE_NAME}=${token}` } })
  const who = await requireTenantSession(req)
  assert.ok(!(who instanceof NextResponse))
  if (!(who instanceof NextResponse)) assert.equal(who.tenantId, 'acme')
})

test('requireTenantSession 401s with no session — never a shared/anon principal', async () => {
  const req = new NextRequest('http://localhost/api/admin/x')
  const res = await requireTenantSession(req)
  assert.ok(res instanceof NextResponse)
  if (res instanceof NextResponse) assert.equal(res.status, 401)
})
