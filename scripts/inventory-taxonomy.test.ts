// Governed inventory taxonomy: normalization, free-text classification, and the
// AI-vocabulary bridge — all pure + hermetic.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  INVENTORY_CATEGORIES, INVENTORY_TAXONOMY, taxonomyEntry,
  normalizeToInventoryCategory, classifyFreeText, inventoryCategoryForJunk,
} from '../app/lib/ai/inventory-taxonomy'

test('every governed category has complete, self-consistent pricing facts', () => {
  for (const key of INVENTORY_CATEGORIES) {
    const e = INVENTORY_TAXONOMY[key]
    assert.equal(e.key, key)
    assert.ok(e.perUnitVolumeCubicYards > 0, `${key} needs a positive volume`)
    assert.ok(e.label.length > 0)
    // Hazardous is always special-handling; dense material is always heavy.
    if (e.hazardous) assert.equal(e.specialHandling, true, `${key} hazardous ⇒ special handling`)
    if (e.denseDebris) assert.equal(e.heavy, true, `${key} dense ⇒ heavy`)
  }
})

test('the full section-4 vocabulary is present', () => {
  const required = [
    'furniture', 'mattress', 'appliance', 'electronics', 'yard_debris', 'household_trash',
    'garage_items', 'construction_debris', 'flooring', 'cabinets_fixtures', 'tires',
    'exercise_equipment', 'safe_dense_object', 'hot_tub', 'piano', 'dense_material', 'hazardous', 'other',
  ]
  for (const r of required) assert.ok((INVENTORY_CATEGORIES as string[]).includes(r), `missing ${r}`)
})

test('normalizeToInventoryCategory accepts governed keys, AI vocab, and hyphen/space variants', () => {
  assert.equal(normalizeToInventoryCategory('furniture'), 'furniture')
  assert.equal(normalizeToInventoryCategory('hot-tub'), 'hot_tub')
  assert.equal(normalizeToInventoryCategory('yard_waste'), 'yard_debris')   // AI JunkCategory
  assert.equal(normalizeToInventoryCategory('construction_debris'), 'construction_debris')
  assert.equal(normalizeToInventoryCategory('GARAGE ITEMS'), 'garage_items')
})

test('"Other" free text is normalized into a governed category before pricing', () => {
  assert.equal(normalizeToInventoryCategory('other', 'old paint cans and motor oil'), 'hazardous')
  assert.equal(normalizeToInventoryCategory('other', 'broken concrete slab'), 'dense_material')
  assert.equal(normalizeToInventoryCategory('other', 'a Yamaha upright piano'), 'piano')
  assert.equal(normalizeToInventoryCategory('other', 'gun safe'), 'safe_dense_object')
  assert.equal(normalizeToInventoryCategory('unrecognizable gibberish zzz'), 'other')
})

test('classifyFreeText keyword routing', () => {
  assert.equal(classifyFreeText('treadmill and dumbbells'), 'exercise_equipment')
  assert.equal(classifyFreeText('refrigerator'), 'appliance')
  assert.equal(classifyFreeText('four tires'), 'tires')
  assert.equal(classifyFreeText('roofing shingles'), 'dense_material')
})

test('AI JunkCategory → governed InventoryCategory bridge', () => {
  assert.equal(inventoryCategoryForJunk('furniture'), 'furniture')
  assert.equal(inventoryCategoryForJunk('hot_tub'), 'hot_tub')
  assert.equal(inventoryCategoryForJunk('unknown'), 'other')
  assert.equal(taxonomyEntry('hazardous').disposalClass, 'hazardous')
})
