// Platform feature-flag foundation: default states + env parsing + override safety.
import assert from 'node:assert/strict'
import test from 'node:test'

import { isEnabled, allFlags, FLAG_DEFAULTS, ALL_FLAGS } from '../app/lib/platform/flags'

test('all sprint flags default OFF except the inert capability registry', () => {
  const d = allFlags({}) // empty env → pure defaults
  assert.equal(d.TENANCY_ENABLED, false)
  assert.equal(d.AI_WORKFORCE_ENABLED, false)
  assert.equal(d.APPROVAL_QUEUE_ENABLED, false)
  assert.equal(d.INDUSTRY_PACKS_ENABLED, false)
  assert.equal(d.INSIGHTS_UI_ENABLED, false)
  assert.equal(d.DESIGN_SYSTEM_REFERENCE_ENABLED, false)
  // The registry is inert data; enabling it changes no behavior, so it defaults true.
  assert.equal(d.CAPABILITY_REGISTRY_ENABLED, true)
})

test('defaults table and flag list agree', () => {
  assert.deepEqual(new Set(ALL_FLAGS), new Set(Object.keys(FLAG_DEFAULTS)))
})

test('env override parses common truthy/falsy spellings', () => {
  assert.equal(isEnabled('TENANCY_ENABLED', { TENANCY_ENABLED: 'true' }), true)
  assert.equal(isEnabled('TENANCY_ENABLED', { TENANCY_ENABLED: '1' }), true)
  assert.equal(isEnabled('TENANCY_ENABLED', { TENANCY_ENABLED: 'ON' }), true)
  assert.equal(isEnabled('CAPABILITY_REGISTRY_ENABLED', { CAPABILITY_REGISTRY_ENABLED: 'false' }), false)
  assert.equal(isEnabled('CAPABILITY_REGISTRY_ENABLED', { CAPABILITY_REGISTRY_ENABLED: '0' }), false)
})

test('unrecognized value falls back to the default, never crashes', () => {
  assert.equal(isEnabled('TENANCY_ENABLED', { TENANCY_ENABLED: 'maybe' }), false)
  assert.equal(isEnabled('CAPABILITY_REGISTRY_ENABLED', { CAPABILITY_REGISTRY_ENABLED: 'maybe' }), true)
})

test('isEnabled reads the passed env map, not the real process.env', () => {
  // Proves tests can never accidentally depend on ambient env.
  assert.equal(isEnabled('TENANCY_ENABLED', { TENANCY_ENABLED: 'true' }), true)
  assert.equal(isEnabled('TENANCY_ENABLED', {}), false)
})
