// AI regression gate (LLMOps Phase 3, item 10). The deterministic pre-deploy check
// that validates EVERY AI feature before it ships: each prompt renders, each golden
// fixture clears its quality threshold, structured features validate against their
// schema, and every registered feature has fixture coverage. No model calls, no
// credits, no flakiness — a prompt or scorer change that regresses a feature fails
// here. Wire it into `npm run predeploy`.
import assert from 'node:assert/strict'
import test from 'node:test'

import { runEval } from '../app/lib/ai/eval'
import { featureCatalog } from '../app/lib/ai/registry'

test('AI regression: all features pass golden evaluation before deploy', () => {
  const report = runEval(1)
  const failures: string[] = []
  for (const f of report.features) {
    if (!f.renderOk) failures.push(`${f.taskId}: prompt did not render expected tokens`)
    for (const c of f.cases) if (!c.pass) failures.push(`${f.taskId}/${c.name}: ${c.reason ?? 'failed'}`)
  }
  assert.equal(failures.length, 0, `\n  - ${failures.join('\n  - ')}`)
  assert.equal(report.pass, true)
})

test('AI regression: every registered feature has fixture coverage', () => {
  const report = runEval(1)
  assert.equal(report.totals.features, featureCatalog().length)
})
