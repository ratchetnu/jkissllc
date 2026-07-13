// Tenant-aware key API: scoping, allowlist, idempotency, fail-closed, validation.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  scopeKey, requireTenantKey, platformKey, legacyKey, keyFamily,
  isPlatformGlobal, isTenantScoped, normalizeTenantId, compareLegacyAndTenantKey,
} from '../app/lib/platform/tenancy/keys'
import { runWithTenant } from '../app/lib/platform/tenancy/context'

test('legacy mode (tenancy off) returns keys UNCHANGED', () => {
  assert.equal(scopeKey('bk:abc', { enabled: false }), 'bk:abc')
  assert.equal(scopeKey('staff:index', { enabled: false }), 'staff:index')
})

test('tenant mode scopes tenant-owned keys', () => {
  assert.equal(scopeKey('bk:abc', { enabled: true, tenantId: 'jkiss' }), 't:jkiss:bk:abc')
  assert.equal(scopeKey('rt:index', { enabled: true, tenantId: 'acme' }), 't:acme:rt:index')
})

test('platform-global families are NEVER prefixed', () => {
  for (const k of ['opspilot:waitlist:x', 'platform:tenant:jkiss', 'ai:cost:jkiss:2026', 'rl:login:1.2.3.4']) {
    assert.equal(scopeKey(k, { enabled: true, tenantId: 'jkiss' }), k)
    assert.equal(isPlatformGlobal(k), true)
  }
})

test('scoping is idempotent (already-scoped keys pass through)', () => {
  assert.equal(scopeKey('t:jkiss:bk:1', { enabled: true, tenantId: 'jkiss' }), 't:jkiss:bk:1')
  assert.equal(isTenantScoped('t:jkiss:bk:1'), true)
})

test('fail closed: tenant-owned key with no tenant context throws', () => {
  assert.throws(() => scopeKey('bk:1', { enabled: true }), /tenant context required/)
})

test('scopeKey resolves the tenant from AsyncLocalStorage context', () => {
  const scoped = runWithTenant({ tenantId: 'acme' }, () => scopeKey('bk:1', { enabled: true }))
  assert.equal(scoped, 't:acme:bk:1')
})

test('normalizeTenantId accepts opaque slugs, rejects display names', () => {
  assert.equal(normalizeTenantId('jkiss'), 'jkiss')
  assert.equal(normalizeTenantId('ACME'), 'acme')
  assert.throws(() => normalizeTenantId('J Kiss LLC'))
  assert.throws(() => normalizeTenantId('user@x.com'))
  assert.throws(() => normalizeTenantId(''))
})

test('requireTenantKey / platformKey enforce their domains', () => {
  assert.equal(requireTenantKey('jkiss', 'bk:1'), 't:jkiss:bk:1')
  assert.throws(() => requireTenantKey('jkiss', 'ai:cost:x'), /platform-global/)
  assert.equal(platformKey('ai:cost:x'), 'ai:cost:x')
  assert.throws(() => platformKey('bk:1'), /not a platform-global/)
})

test('legacyKey + keyFamily are stable helpers', () => {
  assert.equal(legacyKey('t:jkiss:bk:1'), 'bk:1')
  assert.equal(legacyKey('bk:1'), 'bk:1')
  assert.equal(keyFamily('t:jkiss:bk:1'), 'bk')
  assert.equal(keyFamily('staff:index'), 'staff')
})

test('compareLegacyAndTenantKey pairs tenant-owned keys, null for global', () => {
  assert.deepEqual(compareLegacyAndTenantKey('bk:1', { tenantId: 'jkiss' }), { legacy: 'bk:1', tenant: 't:jkiss:bk:1' })
  assert.equal(compareLegacyAndTenantKey('ai:cost:x', { tenantId: 'jkiss' }), null)
})

test('output is deterministic', () => {
  const a = scopeKey('bk:1', { enabled: true, tenantId: 'jkiss' })
  const b = scopeKey('bk:1', { enabled: true, tenantId: 'jkiss' })
  assert.equal(a, b)
})
