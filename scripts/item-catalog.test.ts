import test from 'node:test'
import assert from 'node:assert/strict'
import { OPERATIONAL_ITEM_CATALOG, catalogMatch, catalogVolume, resolveCatalogItem } from '../app/lib/ai/item-catalog'

test('aliases resolve to the controlled category', () => {
  assert.equal(resolveCatalogItem('green three-seat couch')?.id, 'standard_sofa')
  assert.equal(resolveCatalogItem('three couches')?.id, 'standard_sofa')
  assert.equal(resolveCatalogItem('clothes dryer')?.id, 'dryer')
})

test('aliases match whole tokens rather than fragments inside unrelated words', () => {
  assert.equal(resolveCatalogItem('orange chair'), null)
})

test('sectional never resolves as a loveseat', () => {
  assert.equal(resolveCatalogItem('large sectional sofa')?.id, 'sectional')
})

test('size class changes the controlled range', () => {
  const tv = resolveCatalogItem('television')!
  assert.notDeepEqual(catalogVolume(tv, 'small'), catalogVolume(tv, 'oversized'))
})

test('appliances carry operational handling flags', () => {
  const fridge = resolveCatalogItem('refrigerator')!
  assert.equal(fridge.appliance, true)
  assert.ok(fridge.movingFlags.includes('two_person_lift'))
  assert.ok(fridge.junkFlags.includes('special_disposal_review'))
})

test('unknown items fall back with lower agreement', () => {
  const result = catalogMatch('unrecognizable custom sculpture', 'medium', 20)
  assert.equal(result.entry, null)
  assert.equal(result.agreement, 0.45)
})

test('catalog disagreement lowers agreement', () => {
  assert.ok(catalogMatch('loveseat', 'medium', 500).agreement < catalogMatch('loveseat', 'medium', 55).agreement)
})

test('catalog contains no pricing data', () => {
  const forbidden = new Set(['price', 'cost', 'fee', 'usd', 'dollar', 'rate'])
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key.toLowerCase()), false)
      visit(child)
    }
  }
  visit(OPERATIONAL_ITEM_CATALOG)
})
