// Targeted follow-up question selection — deterministic, risk-driven, never the
// full catalog for everyone. Pure + hermetic.
import assert from 'node:assert/strict'
import test from 'node:test'

import { selectFollowUpQuestions, QUESTION_CATALOG } from '../app/lib/ai/followup-questions'
import type { JunkPhotoAnalysis } from '../app/lib/ai/analysis-schema'

function analysis(p: Partial<JunkPhotoAnalysis> = {}): JunkPhotoAnalysis {
  return {
    analysisId: 'a', bookingId: 'b', modelProvider: 'x', modelName: 'm', analyzedAt: 'now', schemaVersion: 1,
    photoObservations: [], normalizedItems: [], totalEstimatedVolumeCubicYards: { minimum: 1, likely: 2, maximum: 3 },
    totalEstimatedWeightPounds: { minimum: 1, likely: 2, maximum: 3 },
    estimatedTruckLoadFraction: { minimum: 0.3, likely: 0.5, maximum: 0.7 },
    estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
    laborEstimate: { crewSize: 2, minimumMinutes: 60, likelyMinutes: 90, maximumMinutes: 120 },
    detectedConditions: {
      stairs: false, elevator: false, longCarry: false, narrowAccess: false, indoorRemoval: false,
      outdoorRemoval: false, disassemblyRequired: false, heavyItemsPresent: false, hazardousMaterialPossible: false,
      refrigerantAppliancePossible: false, concreteOrSoilPossible: false, tiresPossible: false, paintOrChemicalPossible: false,
    },
    additionalQuestions: [], confidence: { overall: 0.8, volume: 0.8, weight: 0.8, itemClassification: 0.8, accessDifficulty: 0.8 },
    warnings: [], reviewRequired: false, reviewReasons: [], ...p,
  }
}

test('every catalog question maps its id and stays within kinds', () => {
  for (const [id, q] of Object.entries(QUESTION_CATALOG)) {
    assert.equal(q.id, id)
    assert.ok(['boolean', 'number', 'text', 'single', 'multi'].includes(q.kind))
  }
})

test('junk baseline is always asked, and dense/hazardous disclosures always appear', () => {
  const qs = selectFollowUpQuestions({ serviceFamily: 'junk', analysis: analysis() })
  const ids = qs.map(q => q.id)
  assert.ok(ids.includes('everything_visible'))
  assert.ok(ids.includes('rooms'))
  assert.ok(ids.includes('dense_debris'))
  assert.ok(ids.includes('hazardous'))
  // Not every possible question is shown.
  assert.ok(ids.length < Object.keys(QUESTION_CATALOG).length)
})

test('heavy / disassembly / appliance items add their targeted questions', () => {
  const qs = selectFollowUpQuestions({
    serviceFamily: 'junk',
    analysis: analysis({
      normalizedItems: [
        { category: 'appliance', label: 'fridge', estimatedQuantity: 1, estimatedVolumeCubicYards: 1, estimatedWeightPounds: { minimum: 1, likely: 200, maximum: 300 }, bulky: true, heavy: true, requiresDisassembly: true, likelyDisposalType: 'recycling', confidence: 0.9, evidence: '' },
      ],
      detectedConditions: { ...analysis().detectedConditions, heavyItemsPresent: true, stairs: true },
    }),
  })
  const ids = qs.map(q => q.id)
  assert.ok(ids.includes('excessively_heavy'))
  assert.ok(ids.includes('requires_disassembly'))
  assert.ok(ids.includes('appliances_connected'))
  assert.ok(ids.includes('elevator_available'))   // stairs → elevator question
})

test('hazard hints escalate to the detail question', () => {
  const qs = selectFollowUpQuestions({
    serviceFamily: 'junk',
    analysis: analysis({ detectedConditions: { ...analysis().detectedConditions, hazardousMaterialPossible: true } }),
  })
  assert.ok(qs.map(q => q.id).includes('hazardous_detail'))
})

test('moving uses the logistics set, not junk disclosures', () => {
  const qs = selectFollowUpQuestions({ serviceFamily: 'moving' })
  const ids = qs.map(q => q.id)
  assert.ok(ids.includes('pickup_address'))
  assert.ok(ids.includes('delivery_address'))
  assert.ok(ids.includes('stairs_pickup'))
  assert.ok(!ids.includes('dense_debris'))
})

test('selection is deterministic (same context → same ordered ids)', () => {
  const ctx = { serviceFamily: 'junk' as const, analysis: analysis() }
  assert.deepEqual(selectFollowUpQuestions(ctx).map(q => q.id), selectFollowUpQuestions(ctx).map(q => q.id))
})
