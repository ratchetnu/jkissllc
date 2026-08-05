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

test('only a terminal head noun matches, so accessory labels stay unclassified', () => {
  for (const label of ['tv stand', 'tv cabinet', 'sofa table', 'patio couch cushions', 'range hood', 'desk lamp']) {
    assert.equal(resolveCatalogItem(label), null, label)
  }
  assert.equal(resolveCatalogItem('office desk chair')?.id, 'office_chair')
  assert.equal(resolveCatalogItem('mini fridge'), null)
  assert.equal(resolveCatalogItem('beverage fridge'), null)
  assert.equal(resolveCatalogItem('small stainless mini fridge'), null)
})

test('singular, regular plural, irregular plural and stored-plural aliases resolve', () => {
  assert.equal(resolveCatalogItem('bookshelves')?.id, 'bookcase')
  assert.equal(resolveCatalogItem('shelves')?.id, 'bookcase')
  assert.equal(resolveCatalogItem('branch pile')?.id, 'yard_waste_bundle')
  assert.equal(resolveCatalogItem('single board')?.id, 'lumber_bundle')
})

test('sectional never resolves as a loveseat', () => {
  assert.equal(resolveCatalogItem('large sectional sofa')?.id, 'sectional')
})

test('size class changes the controlled range', () => {
  const tv = resolveCatalogItem('television')!
  assert.notDeepEqual(catalogVolume(tv, 'small'), catalogVolume(tv, 'oversized'))
})

test('a missing requested size has no silent medium fallback', () => {
  const fridge = resolveCatalogItem('refrigerator')!
  assert.equal(catalogVolume(fridge, 'small'), null)
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
  const forbidden = /(price|cost|fee(?!t)|usd|dollar|rate)/i
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.test(key), false, `pricing-like catalog key: ${key}`)
      visit(child)
    }
  }
  visit(OPERATIONAL_ITEM_CATALOG)
})
