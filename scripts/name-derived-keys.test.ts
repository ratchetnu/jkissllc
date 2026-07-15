// Name-derived key remediation: the tenant boundary is an opaque id, never a
// display name — so display-name changes cannot move the boundary.
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTenantId, scopeKey, requireTenantKey, isPlatformGlobal } from '../app/lib/platform/tenancy/keys'
import { stableId, isStableId, looksNameDerived } from '../app/lib/platform/tenancy/stable-id'
import { JKISS_TENANT } from '../app/lib/platform/tenancy/jkiss'
import { bizKey, newBizId, bizIdKey, bizNameIndexKey, isNameDerivedBizKey } from '../app/lib/businesses'

test('a display name can NEVER be a tenant boundary', () => {
  // The opaque id is valid; the human name is rejected.
  assert.equal(normalizeTenantId(JKISS_TENANT.id), 'jkiss')
  assert.throws(() => normalizeTenantId(JKISS_TENANT.displayName)) // "J Kiss LLC"
})

test('changing the display name does not change tenant identity', () => {
  const renamed = { ...JKISS_TENANT, displayName: 'Totally Different Name LLC' }
  assert.equal(renamed.id, JKISS_TENANT.id, 'id is the boundary and is unchanged')
  assert.equal(normalizeTenantId(renamed.id), normalizeTenantId(JKISS_TENANT.id))
})

test('stableId produces opaque, unique, name-free ids', () => {
  const a = stableId('biz')
  assert.match(a, /^biz_[a-f0-9]{32}$/)
  assert.equal(isStableId(a), true)
  assert.notEqual(stableId('biz'), stableId('biz'))
  assert.equal(looksNameDerived(a), false)
})

test('looksNameDerived flags user-facing strings', () => {
  assert.equal(looksNameDerived('J Kiss LLC'), true)
  assert.equal(looksNameDerived('a@b.com'), true)
  assert.equal(looksNameDerived('Rooms To Go'), true)
  assert.equal(looksNameDerived(''), true)
  assert.equal(looksNameDerived('biz_ab12'), false)
})

// ── Collision proofs (audit H-KEY-1 business rates / payByBusiness, H-KEY-2 learn:*) ──
const NAME = 'Rooms To Go'
const bizRedisKey = (k: string) => `biz:${k}`   // mirrors the private KEY() in businesses.ts

test('[H-KEY-1] two tenants with the same business name COLLIDE under the current name-only key', () => {
  const tenantAKey = bizRedisKey(bizKey(NAME))
  const tenantBKey = bizRedisKey(bizKey('rooms to go'))   // different casing, same business
  assert.equal(tenantAKey, 'biz:rooms to go')
  assert.equal(tenantAKey, tenantBKey, 'same physical Redis key → tenant B overwrites tenant A')
})

test('[H-KEY-1] tenant-scoped keys make the SAME name distinct per tenant (chokepoint fix)', () => {
  const a = requireTenantKey('jkiss', bizRedisKey(bizKey(NAME)))
  const b = requireTenantKey('supercharged', bizRedisKey(bizKey(NAME)))
  assert.equal(a, 't:jkiss:biz:rooms to go')
  assert.equal(b, 't:supercharged:biz:rooms to go')
  assert.notEqual(a, b, 'tenant-scoped → no cross-tenant collision')
})

test('[H-KEY-1] `biz:` is tenant-owned (NOT platform-global) so redis.ts auto-scopes it when enabled; inert when off', () => {
  assert.equal(isPlatformGlobal(bizRedisKey(bizKey(NAME))), false)
  assert.equal(scopeKey(bizRedisKey(bizKey(NAME)), { enabled: false }), 'biz:rooms to go')            // OFF = today
  assert.equal(scopeKey(bizRedisKey(bizKey(NAME)), { enabled: true, tenantId: 'jkiss' }), 't:jkiss:biz:rooms to go')
})

test('[H-KEY-1 residual] bizKey is name-derived → unsafe identity (incl. embedded payByBusiness map key); a stableId is safe. Migration-required', () => {
  const nameKey = bizKey(NAME)                 // "rooms to go"
  assert.equal(looksNameDerived(nameKey), true, 'contains a space → name-derived')
  assert.equal(isNameDerivedBizKey(nameKey), true)

  const id = newBizId()                        // opaque, rename-safe
  assert.equal(isStableId(id), true)
  assert.equal(looksNameDerived(id), false)
  assert.equal(isNameDerivedBizKey(id), false)

  assert.equal(bizIdKey(id), `biz:id:${id}`)
  assert.equal(bizNameIndexKey(NAME), 'biz:byname:rooms to go')
})

test('[H-KEY-2] learn:* pricing state is tenant-owned → distinct per tenant when enabled, unchanged when off', () => {
  for (const key of ['learn:jobs', 'learn:calibration']) {
    assert.equal(isPlatformGlobal(key), false, `${key} must not be platform-global`)
    assert.equal(scopeKey(key, { enabled: false }), key)                                   // OFF = inert
    const a = scopeKey(key, { enabled: true, tenantId: 'jkiss' })
    const b = scopeKey(key, { enabled: true, tenantId: 'supercharged' })
    assert.equal(a, `t:jkiss:${key}`)
    assert.notEqual(a, b, "one tenant's outcomes cannot train another's estimator")
  }
})

test('[cross-check] ai:log IS platform-global (why AI needs an app-level filter); biz/learn are NOT (chokepoint scopes them)', () => {
  assert.equal(isPlatformGlobal('ai:log'), true)
  assert.equal(isPlatformGlobal('ai:call:x'), true)
  assert.equal(isPlatformGlobal('biz:x'), false)
  assert.equal(isPlatformGlobal('learn:jobs'), false)
})
