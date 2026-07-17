// Deterministic specialty taxonomy — the guard against generic descriptors triggering
// a piano-level specialty (the bug that forced 100% of real jobs to manual review).
import assert from 'node:assert/strict'
import test from 'node:test'
import { matchSpecialty, detectSpecialty } from '../app/lib/estimation/specialty-taxonomy'

test('TRUE specialties are matched (certified/heavy/vehicle)', () => {
  for (const s of ['top-freezer refrigerator', 'mini fridge', 'upright freezer', 'grand piano',
    'gun safe', 'hot tub', 'slate pool table', 'riding mower', 'motorcycle', 'water heater', '55-gallon aquarium']) {
    assert.ok(matchSpecialty(s), `should match: ${s}`)
  }
})

test('ordinary heavy/bulky items are NOT specialty (surcharge, not review)', () => {
  for (const s of ['closet organizer', 'leather loveseat / sofa', 'IKEA-style desk with drawer pedestals',
    'six large moving boxes', 'treadmill', 'home gym', 'dresser', 'Traeger pellet grill', 'garage shelving and clutter',
    'brush and tree branches', 'washer', 'dryer', 'office chair']) {
    assert.equal(matchSpecialty(s), null, `should NOT match: ${s}`)
  }
})

test('word boundaries: "organizer" ≠ organ, "space" ≠ spa, "boathouse" ≠ boat', () => {
  assert.equal(matchSpecialty('closet organizer'), null)
  assert.equal(matchSpecialty('a lot of open space'), null)
  assert.equal(matchSpecialty('boathouse storage'), null)
  assert.equal(matchSpecialty('piano'), 'piano')            // but the real word matches
})

test('detectSpecialty scans descriptions + categories + specialtyItems', () => {
  assert.equal(detectSpecialty({ descriptions: ['white top-freezer refrigerator'] }), 'refrigerator')
  assert.equal(detectSpecialty({ categories: ['furniture'], descriptions: ['sofa', 'desk'] }), null)
  assert.equal(detectSpecialty({ specialtyItems: ['possible piano behind the boxes'] }), 'piano')
  assert.equal(detectSpecialty({ descriptions: [], categories: [], specialtyItems: [] }), null)
})
