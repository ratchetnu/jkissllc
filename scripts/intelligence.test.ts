// Operational intelligence: real read-only generators, prioritization, flag gating.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeInsights, runInsightGenerators, prioritizeInsights,
  unconfirmedUpcomingAssignments, aiCostBudgetWarning, overdueReminders,
} from '../app/lib/platform/intelligence'

const NOW = 1_700_000_000_000

test('unconfirmed upcoming assignments produces evidence-backed insights', () => {
  const out = unconfirmedUpcomingAssignments([
    { id: 'r1', routeNumber: 'JK-R-1', startsInHours: 6, assignees: [{ name: 'A', confirmed: false }, { name: 'B', confirmed: true }] },
    { id: 'r2', routeNumber: 'JK-R-2', startsInHours: 6, assignees: [{ name: 'C', confirmed: true }] }, // all confirmed → none
    { id: 'r3', routeNumber: 'JK-R-3', startsInHours: 200, assignees: [{ name: 'D', confirmed: false }] }, // too far out → none
  ], NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0].affectedEntity?.id, 'r1')
  assert.equal(out[0].severity, 'high') // <=12h
  assert.ok(out[0].evidence.length > 0, 'insight must cite evidence')
  assert.equal(out[0].approvalRequired, true)
})

test('AI cost-budget warning fires only at/above 80% of the cap', () => {
  assert.equal(aiCostBudgetWarning({ spentUsd: 4, capUsd: 10 }, NOW).length, 0)
  assert.equal(aiCostBudgetWarning({ spentUsd: 8, capUsd: 10 }, NOW)[0].severity, 'medium')
  assert.equal(aiCostBudgetWarning({ spentUsd: 12, capUsd: 10 }, NOW)[0].severity, 'critical')
  assert.equal(aiCostBudgetWarning({ spentUsd: 99, capUsd: 0 }, NOW).length, 0, 'no cap → no warning')
})

test('overdue reminders only flag genuinely overdue sends', () => {
  const out = overdueReminders([
    { id: 'm1', title: 'Uniform', staffName: 'A', overdueHours: 30 },
    { id: 'm2', title: 'Clock', staffName: 'B', overdueHours: 0 },
  ], NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0].severity, 'high')
})

test('prioritization orders by severity then confidence', () => {
  const sorted = prioritizeInsights([
    ...aiCostBudgetWarning({ spentUsd: 8, capUsd: 10 }, NOW), // medium
    ...unconfirmedUpcomingAssignments([{ id: 'r', routeNumber: 'JK-R', startsInHours: 3, assignees: [{ name: 'X', confirmed: false }] }], NOW), // high
  ])
  assert.equal(sorted[0].severity, 'high')
})

test('computeInsights stamps the tenant on every insight', () => {
  const out = computeInsights({ tenantId: 'jkiss', now: NOW, aiBudget: { spentUsd: 10, capUsd: 10 } })
  assert.ok(out.length > 0)
  for (const i of out) assert.equal(i.tenantId, 'jkiss')
})

test('runInsightGenerators is OFF by default (INSIGHTS_UI_ENABLED flag)', () => {
  const out = runInsightGenerators({ tenantId: 'jkiss', now: NOW, aiBudget: { spentUsd: 10, capUsd: 10 } })
  assert.deepEqual(out, [], 'no insights surface until the flag is enabled')
})
