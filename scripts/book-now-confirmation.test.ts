// Guided customer inventory-confirmation + SECOND (final) governed analysis.
// Pure/hermetic: normalization, merge, deterministic re-pricing, photo-text
// conflicts, and confidence-tier routing — no I/O, injected settings + timestamps.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeConfirmation, activeItems, customerAddedItems, removedDetections,
  attestationComplete, hasHardDisclosure, ATTESTATION_VERSION, MAX_CONFIRMED_ITEMS,
} from '../app/lib/ai/confirmation-schema'
import { mergeConfirmedInventory, buildConfirmedEstimate } from '../app/lib/ai/confirmed-analysis'
import { detectPhotoTextConflicts, hasMaterialConflict } from '../app/lib/ai/photo-text-consistency'
import { routeByConfidence, routingConfigFor, DEFAULT_ROUTING_CONFIG } from '../app/lib/pricing/confidence-routing'
import { nextConfirmationVersion } from '../app/lib/book-now-confirmation'
import { DEFAULT_DISPOSAL } from '../app/lib/disposal'
import type { JunkPhotoAnalysis } from '../app/lib/ai/analysis-schema'

const NOW = '2026-07-13T00:00:00.000Z'

function analysis(items: Array<Partial<JunkPhotoAnalysis['normalizedItems'][number]>> = [], p: Partial<JunkPhotoAnalysis> = {}): JunkPhotoAnalysis {
  const normalizedItems = items.map((i, n) => ({
    category: 'furniture' as const, label: `item${n}`, estimatedQuantity: 1, estimatedVolumeCubicYards: 1.2,
    estimatedWeightPounds: { minimum: 40, likely: 80, maximum: 120 }, bulky: true, heavy: false,
    requiresDisassembly: false, likelyDisposalType: 'landfill' as const, confidence: 0.8, evidence: '', ...i,
  }))
  return {
    analysisId: 'a', bookingId: 'b', modelProvider: 'x', modelName: 'm', analyzedAt: NOW, schemaVersion: 1,
    photoObservations: [{ photoUrl: 'https://x/1.jpg', visibleItems: [], estimatedPhotoVolumeCubicYards: 2, accessObservations: [], possibleDuplicateViewOfOtherPhoto: false, imageQuality: 'good' }],
    normalizedItems,
    totalEstimatedVolumeCubicYards: { minimum: 1, likely: normalizedItems.reduce((s, i) => s + i.estimatedVolumeCubicYards * i.estimatedQuantity, 0) || 2, maximum: 5 },
    totalEstimatedWeightPounds: { minimum: 1, likely: 100, maximum: 300 },
    estimatedTruckLoadFraction: { minimum: 0.1, likely: 0.3, maximum: 0.5 },
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

function conf(raw: Record<string, unknown>, version = 1) {
  return normalizeConfirmation(raw, { now: NOW, confirmationVersion: version, submittedBy: 'customer', status: 'submitted' })
}

const fullAttestation = { representsEverything: true, additionalMayChangePrice: true, hazardousDisclosed: true, accessDisclosed: true, mayRequireOwnerReview: true }

// ── Normalization ────────────────────────────────────────────────────────────
test('normalizeConfirmation clamps quantity, normalizes category, and records attestation version', () => {
  const c = conf({
    items: [{ id: 'x1', category: 'hot-tub', name: 'Spa', quantity: 999999, aiDetected: true, aiQuantity: 1 }],
    attestation: fullAttestation,
  })
  assert.equal(c.items[0].category, 'hot_tub')
  assert.equal(c.items[0].quantity, 999)                  // clamped
  assert.equal(c.items[0].source, 'combined')             // aiDetected default
  assert.equal(c.attestation?.version, ATTESTATION_VERSION)
  assert.equal(c.attestation?.at, NOW)
  assert.equal(attestationComplete(c), true)
})

test('a customer-added item is source:customer; a removed detection is excluded from active items', () => {
  const c = conf({
    items: [
      { id: 'a', category: 'furniture', name: 'Couch', quantity: 1, aiDetected: true },
      { id: 'b', category: 'appliance', name: 'Fridge', quantity: 1, aiDetected: false },     // added
      { id: 'c', category: 'mattress', name: 'Mattress', quantity: 1, aiDetected: true, removed: true }, // removed
    ],
  })
  assert.equal(activeItems(c).length, 2)
  assert.equal(customerAddedItems(c).length, 1)
  assert.equal(removedDetections(c).length, 1)
  assert.equal(customerAddedItems(c)[0].source, 'customer')
})

test('item count is capped and "Other" free text is normalized before pricing', () => {
  const many = Array.from({ length: MAX_CONFIRMED_ITEMS + 20 }, (_, i) => ({ id: `i${i}`, category: 'furniture', quantity: 1 }))
  assert.equal(conf({ items: many }).items.length, MAX_CONFIRMED_ITEMS)
  const c = conf({ items: [{ id: 'o', category: 'other', name: 'stuff', freeText: 'leftover paint and motor oil', quantity: 1 }] })
  assert.equal(c.items[0].category, 'hazardous')
})

// ── Merge (governed recompute; conditions OR-merged) ─────────────────────────
test('merge recomputes governed volume/fill from the taxonomy, not from customer numbers', () => {
  const c = conf({ items: [{ id: 'a', category: 'furniture', name: 'Couch', quantity: 2, aiDetected: true }] })
  const merged = mergeConfirmedInventory(analysis([{}]), c, { analysisId: 'm', bookingId: 'b', now: NOW })
  // furniture governed volume 1.2 × 2 = 2.4 cu yd
  assert.equal(merged.totalEstimatedVolumeCubicYards.likely, 2.4)
  assert.ok(merged.estimatedTruckLoadFraction.likely > 0 && merged.estimatedTruckLoadFraction.likely < 0.1)
  assert.equal(merged.normalizedItems.length, 1)
})

test('customer disclosures can ADD a condition but never clear a photo-detected hazard', () => {
  const base = analysis([{}], { detectedConditions: { ...analysis().detectedConditions, hazardousMaterialPossible: true } })
  // Customer did NOT disclose hazardous, but the photo read did → stays true.
  const c = conf({ items: [{ id: 'a', category: 'furniture', quantity: 1, aiDetected: true }], disclosures: { containsHazardous: false } })
  const merged = mergeConfirmedInventory(base, c, { analysisId: 'm', bookingId: 'b', now: NOW })
  assert.equal(merged.detectedConditions.hazardousMaterialPossible, true)
  // Customer ADDS dense debris the photo didn't show → becomes true.
  const c2 = conf({ items: [{ id: 'a', category: 'furniture', quantity: 1, aiDetected: true }], disclosures: { containsDenseDebris: true } })
  const merged2 = mergeConfirmedInventory(analysis([{}]), c2, { analysisId: 'm', bookingId: 'b', now: NOW })
  assert.equal(merged2.detectedConditions.concreteOrSoilPossible, true)
})

// ── Second analysis + confidence routing tiers ───────────────────────────────
test('HIGH tier: clean confirmed inventory, complete attestation, small load → quote_ready', () => {
  const c = conf({
    items: [{ id: 'a', category: 'furniture', name: 'Couch', quantity: 1, aiDetected: true, aiQuantity: 1 }],
    attestation: fullAttestation,
  })
  const r = buildConfirmedEstimate({
    initial: analysis([{}]), confirmation: c, serviceType: 'junk-removal',
    settings: DEFAULT_DISPOSAL, now: NOW, analysisId: 'f', bookingId: 'b',
  })
  assert.equal(r.routingTier, 'high')
  assert.equal(r.finalDecision, 'quote_ready')
  assert.ok(r.pricing.recommendedUsd > 0)
  assert.ok(r.evidenceSummary.length > 0)
})

test('MEDIUM tier: a customer-added (non-heavy) item forces owner approval', () => {
  const c = conf({
    items: [
      { id: 'a', category: 'furniture', name: 'Couch', quantity: 1, aiDetected: true, aiQuantity: 1 },
      { id: 'b', category: 'household_trash', name: 'Bags', quantity: 3, aiDetected: false },   // added, light
    ],
    attestation: fullAttestation,
  })
  const r = buildConfirmedEstimate({
    initial: analysis([{}]), confirmation: c, serviceType: 'junk-removal',
    settings: DEFAULT_DISPOSAL, now: NOW, analysisId: 'f', bookingId: 'b',
  })
  assert.equal(r.finalDecision, 'awaiting_owner_approval')
  assert.equal(r.routingTier, 'medium')
})

test('LOW tier: hazardous disclosure → manual review, never a fabricated quote', () => {
  const c = conf({
    items: [{ id: 'a', category: 'furniture', quantity: 1, aiDetected: true }],
    disclosures: { containsHazardous: true, hazardousDetail: 'old paint' },
    attestation: fullAttestation,
  })
  assert.equal(hasHardDisclosure(c), true)
  const r = buildConfirmedEstimate({
    initial: analysis([{}]), confirmation: c, serviceType: 'junk-removal',
    settings: DEFAULT_DISPOSAL, now: NOW, analysisId: 'f', bookingId: 'b',
  })
  assert.equal(r.finalDecision, 'manual_review')
  assert.equal(r.routingTier, 'low')
})

test('LOW tier: zero confirmed items → manual review', () => {
  const c = conf({ items: [{ id: 'a', category: 'furniture', quantity: 1, aiDetected: true, removed: true }], attestation: fullAttestation })
  const r = buildConfirmedEstimate({
    initial: analysis([{}]), confirmation: c, serviceType: 'junk-removal',
    settings: DEFAULT_DISPOSAL, now: NOW, analysisId: 'f', bookingId: 'b',
  })
  assert.equal(r.finalDecision, 'manual_review')
  assert.equal(r.routingTier, 'low')
})

test('dense-debris disclosure feeds construction/weight risk → review', () => {
  const c = conf({
    items: [{ id: 'a', category: 'dense_material', name: 'Concrete', quantity: 4, aiDetected: false }],
    disclosures: { containsDenseDebris: true },
    attestation: fullAttestation,
  })
  const r = buildConfirmedEstimate({
    initial: analysis([{}]), confirmation: c, serviceType: 'junk-removal',
    settings: DEFAULT_DISPOSAL, now: NOW, analysisId: 'f', bookingId: 'b',
  })
  assert.equal(r.finalDecision, 'manual_review')   // dense/concrete is a hard stop in decideQuote
})

test('moving family never auto-quotes from photos (config kill-switch)', () => {
  assert.equal(routingConfigFor('moving').allowInstantQuote, false)
  assert.equal(routingConfigFor('junk').allowInstantQuote, true)
})

// ── Photo-text consistency (neutral flags; material → review) ─────────────────
test('adding a heavy item the AI never saw is a MATERIAL conflict', () => {
  const c = conf({
    items: [
      { id: 'a', category: 'furniture', quantity: 1, aiDetected: true },
      { id: 'b', category: 'safe_dense_object', name: 'Safe', quantity: 1, aiDetected: false },
    ],
  })
  const flags = detectPhotoTextConflicts(analysis([{}]), c)
  assert.ok(flags.some(f => f.code === 'items_added_not_detected' && f.severity === 'material'))
  assert.equal(hasMaterialConflict(flags), true)
  // Neutral language — no accusation.
  assert.ok(flags.every(f => !/lie|dishonest|false claim/i.test(f.message)))
})

test('a large confirmed-quantity jump vs the photo read is flagged material', () => {
  const c = conf({ items: [{ id: 'a', category: 'furniture', name: 'Chairs', quantity: 12, aiDetected: true, aiQuantity: 2 }] })
  const flags = detectPhotoTextConflicts(analysis([{ estimatedQuantity: 2 }]), c)
  assert.ok(flags.some(f => f.code === 'quantity_jump'))
})

test('reporting hidden items always flags for review', () => {
  const c = conf({ items: [{ id: 'a', category: 'furniture', quantity: 1, aiDetected: true }], disclosures: { hiddenItems: true } })
  const flags = detectPhotoTextConflicts(analysis([{}]), c)
  assert.ok(flags.some(f => f.code === 'hidden_or_additional' && f.severity === 'material'))
})

test('zero-item / fallback analysis skips photo comparisons but still honors disclosures', () => {
  const c = conf({ items: [{ id: 'a', category: 'furniture', quantity: 1, aiDetected: false }], disclosures: { containsHazardous: true } })
  const flags = detectPhotoTextConflicts(undefined, c)   // JK-B-1007 style: no photo read
  assert.ok(flags.some(f => f.code === 'hazardous_disclosed'))
})

// ── Routing unit (direct) + idempotency helper ───────────────────────────────
test('routeByConfidence: material conflict overrides everything → low/manual_review', () => {
  const c = conf({ items: [{ id: 'a', category: 'furniture', quantity: 1, aiDetected: true }], attestation: fullAttestation })
  const fakeDecision = { decision: 'instant_quote' as const, recommendedUsd: 200, rangeUsd: { low: 200, high: 260 } } as never
  const r = routeByConfidence({
    decision: fakeDecision,
    conflicts: [{ code: 'x', severity: 'material', message: 'm' }],
    confirmation: c, config: DEFAULT_ROUTING_CONFIG,
  })
  assert.equal(r.tier, 'low')
  assert.equal(r.finalDecision, 'manual_review')
})

test('nextConfirmationVersion is monotonic (supports re-submit)', () => {
  assert.equal(nextConfirmationVersion({ confirmation: undefined }), 1)
  assert.equal(nextConfirmationVersion({ confirmation: conf({ items: [] }, 1) }), 2)
  assert.equal(nextConfirmationVersion({ confirmation: conf({ items: [] }, 4) }), 5)
})
