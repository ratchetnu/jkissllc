// Dense-material evidence gate — the guard so the model's vague concreteOrSoil flag
// only forces a weight-risk review when real construction/demolition material is present.
import assert from 'node:assert/strict'
import test from 'node:test'
import { hasDenseMaterialEvidence } from '../app/lib/pricing/dense-material'

const item = (category: string, label: string) => ({ category: category as never, label })

test('genuine dense construction/demolition material IS evidence', () => {
  assert.equal(hasDenseMaterialEvidence([item('construction_debris', 'broken concrete slab')]), true)
  assert.equal(hasDenseMaterialEvidence([item('dense_material', 'bags of soil')]), true)
  assert.equal(hasDenseMaterialEvidence([item('household_trash', 'pile of bricks')]), true)   // via label
  assert.equal(hasDenseMaterialEvidence([item('yard_debris', 'gravel and pavers')]), true)
  assert.equal(hasDenseMaterialEvidence([item('misc', 'roofing shingles')]), true)
})

test('ordinary furniture/appliances/boxes/mattress/brush are NOT dense evidence', () => {
  for (const it of [
    item('furniture', 'leather sofa'), item('appliance', 'refrigerator'), item('household_trash', 'moving boxes'),
    item('furniture', 'mattress and box spring'), item('yard_debris', 'tree branches and brush'),
    item('furniture', 'closet organizer'), item('furniture', 'desk with drawers'), item('appliance', 'washer'),
  ]) {
    assert.equal(hasDenseMaterialEvidence([it]), false, it.label)
  }
})

test('empty inventory is not evidence', () => {
  assert.equal(hasDenseMaterialEvidence([]), false)
})
