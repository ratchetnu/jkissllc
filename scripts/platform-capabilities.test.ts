// Capability registry: integrity, role visibility, tenant enablement, AI eligibility.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CAPABILITY_IDS } from '../app/lib/platform/capabilities/types'
import { CAPABILITY_REGISTRY, allCapabilities } from '../app/lib/platform/capabilities/registry'
import { validateCapabilityRegistry } from '../app/lib/platform/capabilities/validate'
import {
  capabilitiesForRole, isCapabilityEnabledForTenant, aiEligibleCapabilities,
} from '../app/lib/platform/capabilities'

test('registry is structurally valid (deps resolve, no cycles, keys match ids)', () => {
  assert.deepEqual(validateCapabilityRegistry(), [])
})

test('every declared capability id has an entry', () => {
  for (const id of CAPABILITY_IDS) assert.ok(CAPABILITY_REGISTRY[id], `missing ${id}`)
  assert.equal(allCapabilities().length, CAPABILITY_IDS.length)
})

test('role visibility: crew sees crew surfaces but not the management workspace', () => {
  const crew = capabilitiesForRole('crew').map((c) => c.id)
  assert.ok(crew.includes('crew-portal'))
  assert.ok(crew.includes('availability'))
  assert.ok(!crew.includes('management-workspace'), 'crew must not see the ops workspace')
})

test('tenant enablement: jkiss uses core caps; an unknown tenant gets nothing yet', () => {
  assert.equal(isCapabilityEnabledForTenant('routes', { id: 'jkiss' }), true)
  assert.equal(isCapabilityEnabledForTenant('bookings', { id: 'jkiss' }), true)
  assert.equal(isCapabilityEnabledForTenant('routes', { id: 'acme' }), false)
  // A planned-but-absent capability is not enabled even for jkiss.
  assert.equal(isCapabilityEnabledForTenant('expenses', { id: 'jkiss' }), false)
})

test('AI-eligible capabilities each declare at least one AI action', () => {
  const eligible = aiEligibleCapabilities()
  assert.ok(eligible.length > 0)
  for (const c of eligible) assert.ok(c.aiActions.length > 0)
})

test('dependency example resolves (memberships → organizations, roles)', () => {
  assert.deepEqual(CAPABILITY_REGISTRY['memberships'].dependencies.sort(), ['identity', 'organizations', 'roles'])
})
