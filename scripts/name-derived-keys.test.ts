// Name-derived key remediation: the tenant boundary is an opaque id, never a
// display name — so display-name changes cannot move the boundary.
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTenantId } from '../app/lib/platform/tenancy/keys'
import { stableId, isStableId, looksNameDerived } from '../app/lib/platform/tenancy/stable-id'
import { JKISS_TENANT } from '../app/lib/platform/tenancy/jkiss'

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
