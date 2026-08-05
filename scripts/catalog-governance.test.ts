import assert from 'node:assert/strict'
import test from 'node:test'

import {
  JUNK_HANDLING_FLAGS, MOVING_HANDLING_FLAGS, OPERATIONAL_CATALOG_VERSION,
  catalogGovernanceIssues,
} from '../app/lib/ai/catalog-governance'
import { INVENTORY_TAXONOMY_VERSION } from '../app/lib/ai/inventory-taxonomy'
import { OPERATIONAL_ITEM_CATALOG } from '../app/lib/ai/item-catalog'

test('operational catalog satisfies its governed ownership boundary', () => {
  assert.deepEqual(catalogGovernanceIssues(), [])
})

test('pricing-like keys are rejected even when nested or compound', () => {
  const mutated = structuredClone(OPERATIONAL_ITEM_CATALOG) as Array<Record<string, unknown>>
  mutated[0].basePriceUsd = 99
  mutated[1].rules = { dumpFeeCents: 500 }
  const issues = catalogGovernanceIssues(mutated as typeof OPERATIONAL_ITEM_CATALOG)
  assert.ok(issues.some(issue => issue.includes('basePriceUsd')))
  assert.ok(issues.some(issue => issue.includes('dumpFeeCents')))
})

test('fee-prefixed keys are rejected without catching the cubic-feet unit', () => {
  // `fee(?!t)` was written to spare `volumeCubicFeet`, but the /i flag made the
  // lookahead case-insensitive and spared every `fee`+t key with it.
  for (const key of ['feeType', 'feeTier', 'feeTable', 'disposalFeeSchedule', 'flatRate', 'pricingTier']) {
    const mutated = structuredClone(OPERATIONAL_ITEM_CATALOG) as Array<Record<string, unknown>>
    mutated[0][key] = 1
    assert.ok(
      catalogGovernanceIssues(mutated as typeof OPERATIONAL_ITEM_CATALOG).some(issue => issue.includes(key)),
      `pricing-owned key not rejected: ${key}`,
    )
  }
  // The real catalog carries volumeCubicFeet and must stay clean — and a word
  // that merely CONTAINS a money word is not a pricing key either.
  const innocent = structuredClone(OPERATIONAL_ITEM_CATALOG) as Array<Record<string, unknown>>
  innocent[0].separateNotes = 'kept apart'
  innocent[0].feetOfClearance = 3
  assert.deepEqual(catalogGovernanceIssues(innocent as typeof OPERATIONAL_ITEM_CATALOG), [])
})

test('an alias the matcher cannot distinguish counts as a collision', () => {
  // `couches` is a new string but not a new claim: it resolves the same labels
  // as standard_sofa's `couch`, and the longest-alias tie-break would hand
  // `couch` itself to the newcomer. Governance must see that as a collision.
  const mutated = structuredClone(OPERATIONAL_ITEM_CATALOG)
  mutated.find(entry => entry.id === 'sectional')!.aliases.push('couches')
  assert.ok(catalogGovernanceIssues(mutated).some(issue => issue.startsWith('alias collision:')))

  // Punctuation and casing were already equivalent; keep that covered.
  const spaced = structuredClone(OPERATIONAL_ITEM_CATALOG)
  spaced.find(entry => entry.id === 'sectional')!.aliases.push('  L-Shaped  Couch ')
  assert.ok(catalogGovernanceIssues(spaced).some(issue => issue.startsWith('alias collision:')))

  // A genuinely distinct alias must NOT be reported — the check has to stay
  // usable for real expansion, not just reject everything.
  const distinct = structuredClone(OPERATIONAL_ITEM_CATALOG)
  distinct.find(entry => entry.id === 'sectional')!.aliases.push('corner suite')
  assert.deepEqual(catalogGovernanceIssues(distinct), [])
})

test('identity collisions and unknown handling vocabulary fail governance', () => {
  const mutated = structuredClone(OPERATIONAL_ITEM_CATALOG)
  mutated[1].id = mutated[0].id
  mutated[1].aliases.push(mutated[0].aliases[0])
  mutated[1].movingFlags.push('invented_moving_flag')
  mutated[1].junkFlags.push('invented_junk_flag')
  const issues = catalogGovernanceIssues(mutated)
  assert.ok(issues.some(issue => issue.startsWith('duplicate id:')))
  assert.ok(issues.some(issue => issue.startsWith('alias collision:')))
  assert.ok(issues.some(issue => issue.includes('unknown moving flag')))
  assert.ok(issues.some(issue => issue.includes('unknown junk flag')))
})

test('versions and controlled vocabularies are explicit audit surfaces', () => {
  assert.ok(OPERATIONAL_CATALOG_VERSION >= 1)
  assert.ok(INVENTORY_TAXONOMY_VERSION >= 1)
  assert.ok(MOVING_HANDLING_FLAGS.includes('two_person_lift'))
  assert.ok(JUNK_HANDLING_FLAGS.includes('special_disposal_review'))
})
