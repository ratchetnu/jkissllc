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
  for (const label of [
    'mini fridge', 'beverage fridge', 'small stainless mini fridge', 'compact fridge',
    'wine fridge', 'bar fridge', 'dorm fridge', 'mini refrigerator', 'under counter fridge',
    'portable washer', 'apartment washer',
  ]) assert.equal(resolveCatalogItem(label), null, label)
})

test('singular, regular plural, irregular plural and stored-plural aliases resolve', () => {
  assert.equal(resolveCatalogItem('bookshelves')?.id, 'bookcase')
  assert.equal(resolveCatalogItem('shelves'), null)
  assert.equal(resolveCatalogItem('wall shelf'), null)
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
  const disagreement = catalogMatch('loveseat', 'medium', 500).agreement
  const agreement = catalogMatch('loveseat', 'medium', 55).agreement
  assert.ok(disagreement !== null && agreement !== null && disagreement < agreement)
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

// ─────────────────────────────────────────────────────────────────────────────
// Matcher grammar — regressions proven by the 2026-08-05 Preview field-semantics
// pilot. The pilot found the resolver anchoring on a label's FINAL token, which
// made a supporting surface ("… on desk") outrank the actual subject, and made
// normal noun+descriptor order ("sofa large") miss entirely.
// ─────────────────────────────────────────────────────────────────────────────

test('a locational preposition marks context, so the surface never wins', () => {
  // Exact labels the pilot mis-resolved, verbatim.
  assert.equal(resolveCatalogItem('Apple laptop/keyboard on desk'), null)
  assert.equal(resolveCatalogItem('Stereo/AV receiver or CD player on dresser'), null)
  assert.equal(resolveCatalogItem('books/stacked items on dresser'), null)
  // The whole preposition set, including multi-word forms.
  for (const label of [
    'crate under desk', 'bags beside sofa', 'plant behind sofa',
    'artwork near dresser', 'mattress against wall', 'items inside cabinet',
    'lamp next to couch', 'vase on top of dresser', 'rug in front of sofa',
  ]) assert.equal(resolveCatalogItem(label), null, label)
})

test('the subject is still classified when it is itself a catalog item', () => {
  assert.equal(resolveCatalogItem('television on stand')?.id, 'television')
  assert.equal(resolveCatalogItem('boxes on shelf')?.id, 'moving_box')
  assert.equal(resolveCatalogItem('industrial pipe desk on casters')?.id, 'desk')
  // Contents are the inventory; the container is context, per the same rule.
  assert.equal(resolveCatalogItem('boxes in cabinet')?.id, 'moving_box')
})

test('descriptors resolve in either order', () => {
  const pairs: Array<[string, string, string]> = [
    ['large sofa', 'sofa large', 'standard_sofa'],
    ['3-seat sofa', 'sofa 3-seat', 'standard_sofa'],
    ['queen mattress', 'mattress queen', 'queen_mattress'],
    ['tall 6-drawer dresser', 'dresser tall 6-drawer', 'dresser'],
    ['small nightstand', 'nightstand small', 'nightstand'],
    ['medium boxes', 'boxes medium', 'moving_box'],
    ['55-inch television', 'television 55-inch', 'television'],
  ]
  for (const [a, b, id] of pairs) {
    assert.equal(resolveCatalogItem(a)?.id, id, a)
    assert.equal(resolveCatalogItem(b)?.id, id, b)
  }
})

test('head-noun anchoring still refuses accessories and supporting furniture', () => {
  for (const label of [
    'tv stand', 'tv cabinet', 'sofa table', 'desk lamp', 'range hood',
    'patio couch cushions', 'wall shelf', 'orange chair',
  ]) assert.equal(resolveCatalogItem(label), null, label)
})

test('a phrase naming two different governed items stays unmatched', () => {
  assert.equal(resolveCatalogItem('desk or dresser'), null)
  // …but a slash-joined description of ONE item still resolves.
  assert.equal(resolveCatalogItem('bookcase/shelving unit')?.id, 'bookcase')
})

test('punctuation, casing and plurals normalise without fuzzy drift', () => {
  assert.equal(resolveCatalogItem('  SOFA,  Large ')?.id, 'standard_sofa')
  assert.equal(resolveCatalogItem('Dressers')?.id, 'dresser')
  assert.equal(resolveCatalogItem('box spring')?.id, 'box_spring')   // not moving_box
  assert.equal(resolveCatalogItem('unrecognisable custom sculpture'), null)
})
