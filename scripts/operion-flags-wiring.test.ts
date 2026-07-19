// Proves the two previously-dead OPERION flags now change behavior.
//  • OPERION_AI_ADAPTATION_ENABLED   → effectiveStrategy() (strategy selection)
//  • OPERION_AUTOMATIC_ROLLBACK_ENABLED → automaticRollbackEligible() (Production recovery)
import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveStrategy } from '../app/lib/platform/automation/orchestrator'
import { automaticRollbackEligible } from '../app/lib/platform/automation/preflight'

test('OPERION_AI_ADAPTATION_ENABLED gates the ai_adaptation strategy', () => {
  // Off (or missing) → ai_adaptation downgrades to the deterministic commit_transfer.
  assert.equal(effectiveStrategy('ai_adaptation', {}), 'commit_transfer')
  assert.equal(effectiveStrategy('ai_adaptation', { OPERION_AI_ADAPTATION_ENABLED: 'false' }), 'commit_transfer')
  // On → ai_adaptation is used.
  assert.equal(effectiveStrategy('ai_adaptation', { OPERION_AI_ADAPTATION_ENABLED: 'true' }), 'ai_adaptation')
  // Non-AI strategies are never touched by the flag.
  assert.equal(effectiveStrategy('commit_transfer', {}), 'commit_transfer')
  assert.equal(effectiveStrategy('file_manifest', { OPERION_AI_ADAPTATION_ENABLED: 'true' }), 'file_manifest')
})

test('OPERION_AUTOMATIC_ROLLBACK_ENABLED gates automatic-rollback eligibility', () => {
  const verifiedPath = { productionProjectId: 'prj_production', irreversibleMigration: false, previousVerifiedCommit: 'abc1234' }
  // Flag off ⇒ never eligible for automatic Production recovery.
  assert.equal(automaticRollbackEligible({ enabled: false, ...verifiedPath }), false)
  // Flag on + a fully verified rollback path ⇒ eligible after a Production verification failure.
  assert.equal(automaticRollbackEligible({ enabled: true, ...verifiedPath }), true)
  // On but missing a Production project / prior verified commit / reversibility ⇒ not eligible.
  assert.equal(automaticRollbackEligible({ enabled: true, irreversibleMigration: false, previousVerifiedCommit: 'abc' }), false)
  assert.equal(automaticRollbackEligible({ enabled: true, productionProjectId: 'prj_production', irreversibleMigration: false }), false)
  assert.equal(automaticRollbackEligible({ enabled: true, productionProjectId: 'prj_production', irreversibleMigration: true, previousVerifiedCommit: 'abc' }), false)
})
