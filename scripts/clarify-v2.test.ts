// Tests for the V2 customer clarification engine (Phase 11). Pure, no model calls —
// mock JunkPhotoAnalysisV2 objects in, deterministic clarifications out. Run via tsx.
import assert from 'node:assert/strict'
import test from 'node:test'

import { clarificationsForV2, applyAnswersV2 } from '../app/lib/estimation/clarify-v2'
import type {
  JunkPhotoAnalysisV2,
  UnifiedObject,
  PerImageObservation,
  AccessAssessment,
} from '../app/lib/ai/analysis-schema-v2'

// ── Mock builders ─────────────────────────────────────────────────────────────
function obj(over: Partial<UnifiedObject> = {}): UnifiedObject {
  return {
    objectId: 'object_001',
    category: 'furniture',
    description: 'dresser',
    quantity: 1,
    minQuantity: 1,
    maxQuantity: 1,
    sourceImageIds: ['img_1'],
    weightClass: 'medium',
    disposalClass: 'landfill',
    specialHandling: [],
    confidence: 'high',
    ...over,
  }
}

function perImage(over: Partial<PerImageObservation> = {}): PerImageObservation {
  return {
    imageId: 'img_1',
    sceneDescription: 'garage',
    locationType: 'garage',
    items: [],
    hazardousConcern: false,
    electronicWaste: false,
    refrigerantAppliance: false,
    mattressOrBoxSpring: false,
    tire: false,
    paintOrChemical: false,
    constructionDebris: false,
    yardWaste: false,
    looseDebris: false,
    baggedMaterial: false,
    stairsVisible: false,
    elevatorVisible: false,
    doorwayLimitation: false,
    narrowHallway: false,
    longCarryIndication: false,
    disassemblyLikely: false,
    uncertainObservations: [],
    imageQuality: 'good',
    confidence: 'high',
    ...over,
  }
}

const KNOWN_ACCESS: AccessAssessment = {
  stairs: false,
  elevator: false,
  longCarry: false,
  narrowAccess: false,
  parkingRestricted: false,
  outdoorDistance: false,
  multipleRoomsOrAreas: false,
  notes: [],
}

function analysis(over: Partial<JunkPhotoAnalysisV2> = {}): JunkPhotoAnalysisV2 {
  return {
    schemaVersion: 2,
    bookingId: 'B1',
    analyzedAt: '2026-07-15T00:00:00.000Z',
    model: 'test',
    promptVersion: 'v2',
    imageCountReceived: 1,
    imageCountUsable: 1,
    imageQualityResults: [{ imageId: 'img_1', quality: 'good', warnings: [] }],
    perImageObservations: [perImage()],
    unifiedInventory: [obj()],
    sceneSummary: 'a tidy pile',
    accessAssessment: { ...KNOWN_ACCESS },
    laborAssessment: {
      estimatedCrewSize: 2,
      disassemblyRequired: false,
      heavyLifting: false,
      oversizedItems: false,
      applianceHandling: false,
      ppeRequired: [],
      potentialSecondTrip: false,
    },
    disposalAssessment: { surchargeItems: [], hazardousPossible: false, specialtyItems: [] },
    volumeHint: { likelyCubicYards: 2, maxCubicYards: 2.2 },
    confidence: 'high',
    confidenceScore: 0.9,
    uncertaintyReasons: [],
    missingInformation: [],
    recommendedCustomerQuestions: [],
    manualReviewRequired: false,
    manualReviewReasons: [],
    customerSafeSummary: 'ready',
    internalOwnerSummary: 'ready',
    ...over,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('wide quantity range → a specific quantity question referencing the item', () => {
  const v2 = analysis({
    confidence: 'medium',
    unifiedInventory: [obj({ description: 'moving boxes', quantity: 6, minQuantity: 4, maxQuantity: 10, confidence: 'medium' })],
  })
  const out = clarificationsForV2(v2)
  const q = out.find((c) => c.kind === 'quantity')
  assert.ok(q, 'expected a quantity question')
  assert.match(q!.question, /how many/i)
  assert.match(q!.question, /moving boxes/)
  assert.equal(q!.targetObjectId, 'object_001')
})

test('unknown access on a non-trivial job → ONE combined access question (not 4)', () => {
  const v2 = analysis({
    confidence: 'medium',
    unifiedInventory: [obj({ objectId: 'object_001' }), obj({ objectId: 'object_002', description: 'couch' })],
    accessAssessment: {
      ...KNOWN_ACCESS,
      stairs: 'unknown',
      elevator: 'unknown',
      longCarry: 'unknown',
      parkingRestricted: 'unknown',
    },
  })
  const out = clarificationsForV2(v2)
  const access = out.filter((c) => c.kind === 'access')
  assert.equal(access.length, 1, 'exactly one combined access question')
  assert.match(access[0].question, /stairs.*ground-floor|ground-floor.*stairs/i)
})

test('unidentified item → an unidentified question', () => {
  const v2 = analysis({
    confidence: 'medium',
    unifiedInventory: [obj({ description: 'unknown object', category: 'unknown', confidence: 'low' })],
  })
  const out = clarificationsForV2(v2)
  const u = out.find((c) => c.kind === 'unidentified')
  assert.ok(u, 'expected an unidentified question')
  assert.match(u!.question, /identify|what is it/i)
})

test('hazard flagged → a hazard question is always present', () => {
  const v2 = analysis({
    confidence: 'high',
    disposalAssessment: { surchargeItems: [], hazardousPossible: true, specialtyItems: [] },
  })
  const out = clarificationsForV2(v2)
  const h = out.find((c) => c.kind === 'hazard')
  assert.ok(h, 'hazard question must surface when flagged')
  assert.equal(out[0].kind, 'hazard', 'hazard prioritized first')
})

test('hazard survives the cap even with many competing questions', () => {
  const v2 = analysis({
    confidence: 'medium',
    disposalAssessment: { surchargeItems: [], hazardousPossible: true, specialtyItems: [] },
    unifiedInventory: [
      obj({ objectId: 'o1', description: 'boxes', minQuantity: 2, maxQuantity: 8, confidence: 'low' }),
      obj({ objectId: 'o2', description: 'bags', minQuantity: 3, maxQuantity: 12, confidence: 'low' }),
      obj({ objectId: 'o3', description: 'crates', minQuantity: 1, maxQuantity: 6, confidence: 'low' }),
      obj({ objectId: 'o4', description: 'bins', minQuantity: 2, maxQuantity: 9, confidence: 'low' }),
    ],
    recommendedCustomerQuestions: ['How many totes are there?', 'Is anything fragile?'],
  })
  const out = clarificationsForV2(v2, { max: 3 })
  assert.equal(out.length, 3)
  assert.ok(out.some((c) => c.kind === 'hazard'), 'hazard must survive the cap')
})

test('high-confidence tidy analysis → no questions', () => {
  const out = clarificationsForV2(analysis())
  assert.deepEqual(out, [])
})

test('cap respected and prioritized (quantity before access)', () => {
  const v2 = analysis({
    confidence: 'medium',
    unifiedInventory: [
      obj({ objectId: 'o1', description: 'sofa', weightClass: 'heavy', minQuantity: 1, maxQuantity: 4, confidence: 'low' }),
      obj({ objectId: 'o2', description: 'chairs', minQuantity: 2, maxQuantity: 8, confidence: 'low' }),
    ],
    accessAssessment: { ...KNOWN_ACCESS, stairs: 'unknown', longCarry: 'unknown' },
  })
  const out = clarificationsForV2(v2, { max: 2 })
  assert.equal(out.length, 2)
  assert.ok(out.every((c) => c.kind === 'quantity'), 'quantity outranks access under a tight cap')
})

test('model recommended question is merged when no deterministic kind covers it', () => {
  const v2 = analysis({
    confidence: 'medium',
    recommendedCustomerQuestions: ["I couldn't make out what this is — what is it?"],
  })
  const out = clarificationsForV2(v2)
  assert.ok(out.some((c) => c.id.startsWith('q_model_')), 'model question surfaced')
})

test('deterministic question wins over an overlapping model question (same kind)', () => {
  const v2 = analysis({
    confidence: 'medium',
    unifiedInventory: [obj({ description: 'boxes', minQuantity: 2, maxQuantity: 9, confidence: 'low' })],
    recommendedCustomerQuestions: ['How many boxes are there roughly?'],
  })
  const out = clarificationsForV2(v2)
  const qty = out.filter((c) => c.kind === 'quantity')
  assert.equal(qty.length, 1, 'no duplicate quantity question')
  assert.ok(qty[0].targetObjectId, 'the deterministic one (with targetObjectId) is kept')
})

test('applyAnswersV2: numeric quantity answer tightens the target object', () => {
  const v2 = analysis({
    confidence: 'medium',
    unifiedInventory: [obj({ objectId: 'object_001', description: 'boxes', quantity: 6, minQuantity: 4, maxQuantity: 10, confidence: 'medium' })],
  })
  const updated = applyAnswersV2(v2, { q_quantity_object_001: 'there are 7 of them' })
  const o = updated.unifiedInventory[0]
  assert.equal(o.quantity, 7)
  assert.equal(o.minQuantity, 7)
  assert.equal(o.maxQuantity, 7)
  assert.equal(o.confidence, 'high')
  // immutable: original untouched
  assert.equal(v2.unifiedInventory[0].quantity, 6)
})

test('applyAnswersV2: yes/no access answer resolves the unknown access fields', () => {
  const v2 = analysis({
    accessAssessment: { ...KNOWN_ACCESS, stairs: 'unknown', longCarry: 'unknown', parkingRestricted: 'unknown' },
  })
  const yes = applyAnswersV2(v2, { q_access: 'yes, there are stairs' })
  assert.equal(yes.accessAssessment.stairs, true)

  const no = applyAnswersV2(v2, { q_access: 'no, everything is ground-floor with easy access' })
  assert.equal(no.accessAssessment.stairs, false)
  assert.equal(no.accessAssessment.longCarry, false)
  assert.equal(no.accessAssessment.parkingRestricted, false)
})

test('applyAnswersV2: hazard "yes" routes to manual review', () => {
  const v2 = analysis({
    disposalAssessment: { surchargeItems: [], hazardousPossible: true, specialtyItems: [] },
  })
  const updated = applyAnswersV2(v2, { q_hazard: 'yes, there is old paint and a propane tank' })
  assert.equal(updated.manualReviewRequired, true)
  assert.equal(updated.disposalAssessment.hazardousPossible, true)
  assert.ok(updated.manualReviewReasons.some((r) => /hazardous/i.test(r)))
  // immutable
  assert.equal(v2.manualReviewRequired, false)
})

test('applyAnswersV2: unparseable answer is ignored (never fabricated)', () => {
  const v2 = analysis({
    unifiedInventory: [obj({ objectId: 'object_001', quantity: 6, minQuantity: 4, maxQuantity: 10, confidence: 'medium' })],
  })
  const updated = applyAnswersV2(v2, { q_quantity_object_001: 'a whole bunch, no idea' })
  const o = updated.unifiedInventory[0]
  assert.equal(o.quantity, 6)
  assert.equal(o.minQuantity, 4)
  assert.equal(o.maxQuantity, 10)
  assert.equal(o.confidence, 'medium')
})
