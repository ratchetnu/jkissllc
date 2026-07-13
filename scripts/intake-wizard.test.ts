// Book Now wizard's industry-pack service filter + the config shape the wizard reads.
import assert from 'node:assert/strict'
import test from 'node:test'

import { filterServicesByPack } from '../app/lib/pack-services'
import { resolveIntakeConfig } from '../app/lib/intake-config'

const SERVICES = [{ id: 'junk-removal' }, { id: 'moving' }, { id: 'freight' }]

test('filterServicesByPack shows only the pack’s matching services', () => {
  assert.deepEqual(filterServicesByPack(SERVICES, ['moving', 'freight']).map(s => s.id), ['moving', 'freight'])
})

test('filterServicesByPack falls back to the full catalog when nothing matches (junk stays default)', () => {
  assert.deepEqual(filterServicesByPack(SERVICES, ['nonexistent']).map(s => s.id), ['junk-removal', 'moving', 'freight'])
  assert.deepEqual(filterServicesByPack(SERVICES, []).map(s => s.id), ['junk-removal', 'moving', 'freight'])
})

test('the resolved intake config exposes service templates with ids the wizard filters on', () => {
  const cfg = resolveIntakeConfig()
  assert.ok(Array.isArray(cfg.serviceTemplates))
  for (const t of cfg.serviceTemplates) assert.equal(typeof t.id, 'string')
  // The wizard maps serviceTemplates → ids; that must not throw on the real config.
  const ids = cfg.serviceTemplates.map(t => t.id)
  assert.ok(Array.isArray(ids))
})
