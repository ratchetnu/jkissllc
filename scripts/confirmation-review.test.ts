// Owner-facing review projection (Phase 3): clearly distinguishes AI-detected /
// customer-confirmed / owner-modified / final-approved, surfaces disclosures,
// access answers, conflicts, and initial-vs-final estimates. Pure + hermetic.
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildOwnerReviewModel } from '../app/lib/ai/confirmation-review'
import { normalizeConfirmation } from '../app/lib/ai/confirmation-schema'
import { detectPhotoTextConflicts } from '../app/lib/ai/photo-text-consistency'
import { buildConfirmedEstimate } from '../app/lib/ai/confirmed-analysis'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'
import type { Booking } from '../app/lib/bookings'
import type { JunkPhotoAnalysis } from '../app/lib/ai/analysis-schema'

const NOW = '2026-07-13T00:00:00.000Z'

function analysis(): JunkPhotoAnalysis {
  return {
    analysisId: 'a', bookingId: 'b', modelProvider: 'x', modelName: 'm', analyzedAt: NOW, schemaVersion: 1,
    photoObservations: [{ photoUrl: 'https://x/1.jpg', visibleItems: [], estimatedPhotoVolumeCubicYards: 2, accessObservations: [], possibleDuplicateViewOfOtherPhoto: false, imageQuality: 'good' }],
    normalizedItems: [{ category: 'furniture', label: 'Sofa', estimatedQuantity: 1, estimatedVolumeCubicYards: 1.2, estimatedWeightPounds: { minimum: 40, likely: 80, maximum: 120 }, bulky: true, heavy: false, requiresDisassembly: false, likelyDisposalType: 'landfill', confidence: 0.9, evidence: '' }],
    totalEstimatedVolumeCubicYards: { minimum: 1, likely: 1.2, maximum: 2 },
    totalEstimatedWeightPounds: { minimum: 40, likely: 80, maximum: 120 },
    estimatedTruckLoadFraction: { minimum: 0.1, likely: 0.2, maximum: 0.3 },
    estimatedTruckLoads: { minimum: 1, likely: 1, maximum: 1 },
    laborEstimate: { crewSize: 2, minimumMinutes: 60, likelyMinutes: 90, maximumMinutes: 120 },
    detectedConditions: { stairs: false, elevator: false, longCarry: false, narrowAccess: false, indoorRemoval: false, outdoorRemoval: false, disassemblyRequired: false, heavyItemsPresent: false, hazardousMaterialPossible: false, refrigerantAppliancePossible: false, concreteOrSoilPossible: false, tiresPossible: false, paintOrChemicalPossible: false },
    additionalQuestions: [], confidence: { overall: 0.85, volume: 0.8, weight: 0.8, itemClassification: 0.9, accessDifficulty: 0.8 },
    warnings: [], reviewRequired: false, reviewReasons: [],
  }
}

function mkBooking(p: Partial<Booking>): Booking {
  return {
    token: 'tok', bookingNumber: 'JK-B-1', customerName: 'C', serviceType: 'junk-removal', items: [],
    invoiceAmountCents: 0, depositAmountCents: 0, amountPaidCents: 0, availableDates: [], availableWindows: [],
    status: 'quote_received', payments: [], source: 'online', createdAt: 1, updatedAt: 1,
    invoicePhotos: [{ url: 'https://x/1.jpg' }], ...p,
  } as Booking
}

test('review distinguishes AI-detected / customer-confirmed / added / removed / owner-modified', () => {
  const confirmation = normalizeConfirmation({
    items: [
      { id: 'a', category: 'furniture', name: 'Sofa', quantity: 1, aiDetected: true, aiName: 'Sofa', aiQuantity: 1 },
      { id: 'b', category: 'appliance', name: 'Fridge', quantity: 1, aiDetected: false, source: 'customer' },        // added
      { id: 'c', category: 'mattress', name: 'Mattress', quantity: 1, aiDetected: true, removed: true },              // removed
      { id: 'd', category: 'furniture', name: 'Desk (owner corrected)', quantity: 3, aiDetected: true, aiName: 'Table', aiQuantity: 1, source: 'owner' }, // owner
    ],
    disclosures: { containsHazardous: true, hazardousDetail: 'old paint' },
    accessConditions: { rooms: 2, itemsUpstairs: true, elevatorAvailable: false },
    attestation: { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true },
  }, { now: NOW, confirmationVersion: 1 })

  const b = mkBooking({ confirmation })
  const m = buildOwnerReviewModel(b)

  assert.equal(m.counts.aiDetected, 3)          // a, c, d were aiDetected
  assert.equal(m.counts.customerConfirmed, 2)   // active aiDetected (a, d); c removed
  assert.equal(m.counts.customerAdded, 1)       // b
  assert.equal(m.counts.removed, 1)             // c
  assert.equal(m.counts.ownerModified, 1)       // d
  // Owner-corrected item preserves the original AI read for side-by-side display.
  const owner = m.items.find(i => i.provenance === 'owner')!
  assert.equal(owner.changed, true)
  assert.equal(owner.aiName, 'Table')
  assert.equal(owner.aiQuantity, 1)
  assert.equal(owner.quantity, 3)
})

test('review surfaces disclosures (with risk), access answers, attestation, and is-everything', () => {
  const confirmation = normalizeConfirmation({
    items: [{ id: 'a', category: 'furniture', name: 'Sofa', quantity: 1, aiDetected: true }],
    disclosures: { containsHazardous: true, hiddenItems: true, everythingVisibleInPhotos: false, additionalItemsNotPictured: true },
    accessConditions: { rooms: 2, longCarry: true },
    attestation: { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true },
  }, { now: NOW, confirmationVersion: 1 })
  const m = buildOwnerReviewModel(mkBooking({ confirmation }))
  assert.ok(m.disclosures.some(d => d.label.includes('Hazardous') && d.risk))
  assert.ok(m.accessAnswers.some(a => a.label === 'Rooms / areas' && a.value === '2'))
  assert.equal(m.attestation?.complete, true)
  assert.equal(m.isEverything, 'More items not pictured')
})

test('review reports conflict severity computed on the server confirmation', () => {
  const confirmation = normalizeConfirmation({
    items: [
      { id: 'a', category: 'furniture', name: 'Sofa', quantity: 1, aiDetected: true },
      { id: 'b', category: 'safe_dense_object', name: 'Gun safe', quantity: 1, aiDetected: false },  // heavy add → material
    ],
  }, { now: NOW, confirmationVersion: 1 })
  confirmation.conflicts = detectPhotoTextConflicts(analysis(), confirmation)
  const m = buildOwnerReviewModel(mkBooking({ confirmation }))
  assert.equal(m.conflictSeverity, 'material')
  assert.ok(m.conflicts.length > 0)
})

test('review shows initial vs final estimates + operational inputs', () => {
  const confirmation = normalizeConfirmation({
    items: [{ id: 'a', category: 'furniture', name: 'Sofa', quantity: 1, aiDetected: true }],
    attestation: { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true },
  }, { now: NOW, confirmationVersion: 1 })
  const finalAiEstimate = buildConfirmedEstimate({
    initial: analysis(), confirmation, serviceType: 'junk-removal', settings: DEFAULT_DISPOSAL, now: NOW, analysisId: 'f', bookingId: 'b',
  })
  const aiEstimate = {
    id: 'a', createdAt: NOW, status: 'completed' as const, decision: 'estimate_range' as const, provider: 'x', model: 'm', schemaVersion: 1,
    inputPhotoUrls: ['https://x/1.jpg'], analysis: analysis(),
    pricing: { recommendedUsd: 280, lowUsd: 250, highUsd: 330, breakdown: {} as never }, reviewReasons: [],
  }
  const m = buildOwnerReviewModel(mkBooking({ confirmation, finalAiEstimate, aiEstimate }))
  assert.ok(m.initial)
  assert.equal(m.initial!.lowUsd, 250)
  assert.ok(m.final)
  assert.equal(m.final!.finalDecision, finalAiEstimate.finalDecision)
  assert.ok(m.final!.laborHours > 0)
  assert.ok(m.final!.crewSize >= 1)
  assert.equal(m.final!.policyVersion, finalAiEstimate.policyVersion)
})

test('no confirmation → empty review model (backward compatible)', () => {
  const m = buildOwnerReviewModel(mkBooking({}))
  assert.equal(m.hasConfirmation, false)
  assert.equal(m.items.length, 0)
  assert.equal(m.conflictSeverity, 'none')
})
