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
