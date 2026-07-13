// Industry pack contract: JKISS pack preservation, disabled example, config precedence.
import assert from 'node:assert/strict'
import test from 'node:test'

import { JKISS_PACK } from '../app/lib/platform/industry-packs/jkiss'
import { CLEANING_PACK } from '../app/lib/platform/industry-packs/example-cleaning'
import { availablePacks, allPacks } from '../app/lib/platform/industry-packs/registry'
import { resolveConfig, CONFIG_PRECEDENCE } from '../app/lib/platform/industry-packs/config'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'

test('J KISS pack is enabled by default and preserves current terminology', () => {
  assert.equal(JKISS_PACK.enabledByDefault, true)
  assert.equal(JKISS_PACK.terminology.jobNoun, 'Route')
  assert.equal(JKISS_PACK.terminology.workerNoun, 'Crew')
  assert.ok(JKISS_PACK.equipmentCategories.includes('Box truck'))
})

test('the example cleaning pack is disabled by default', () => {
  assert.equal(CLEANING_PACK.enabledByDefault, false)
})

test('availablePacks offers only default-on packs (example excluded)', () => {
  const ids = availablePacks().map((p) => p.id)
  assert.ok(ids.includes('jkiss-field-service'))
  assert.ok(!ids.includes('cleaning-residential'))
  assert.equal(allPacks().length, 2)
})

test('every pack only references capabilities that exist in the registry', () => {
  for (const p of allPacks()) {
    for (const capId of p.supportedCapabilities) {
      assert.ok(CAPABILITY_REGISTRY[capId], `${p.id} references unknown capability "${capId}"`)
    }
  }
})

test('config precedence: override → tenant → pack → platform', () => {
  const base = { depositPct: 0, cancellationHours: 0, label: 'base' }
  const resolved = resolveConfig(base, {
    platform: { depositPct: 10, cancellationHours: 24, label: 'platform' },
    pack: { depositPct: 15, label: 'pack' },
    tenant: { depositPct: 20 },
    override: { depositPct: 25 },
  })
  assert.equal(resolved.depositPct, 25, 'override wins')
  assert.equal(resolved.label, 'pack', 'pack beats platform when tenant/override silent')
  assert.equal(resolved.cancellationHours, 24, 'falls through to platform')
  assert.deepEqual([...CONFIG_PRECEDENCE], ['override', 'tenant', 'pack', 'platform'])
})
