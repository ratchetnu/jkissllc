// ─────────────────────────────────────────────────────────────────────────────
// Phase 13 — REPRESENTATIVE, PRIVACY-SAFE FIXTURES for the V2 vision estimator.
//
// Each fixture is a hand-authored, anonymized JunkPhotoAnalysisV2 — i.e. the shape
// the model produces for a known scene — paired with a human-authored `groundTruth`.
// There are NO images and NO real customer data here: these are plain data objects
// describing common junk-removal jobs, built so the offline eval (eval-harness.ts)
// can exercise the DETERMINISTIC pipeline (bridge + load-tier + confidence + clarify)
// with zero live AI calls.
//
// Coverage (Phase 13 list): single couch; bedroom / garage / apartment cleanout;
// full truck; mixed furniture; bags + boxes; construction debris; yard waste;
// appliances; mattress + box spring; OVERLAPPING photos of the same item (dedup=1);
// different rooms with similar items (must NOT merge → 2); poor lighting / blurry;
// close-up with no context; more-than-one-load; hazard concern; specialty item;
// and no usable images.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  JunkPhotoAnalysisV2,
  UnifiedObject,
  PerImageObservation,
  AccessAssessment,
  LaborAssessment,
  DisposalAssessment,
} from '../ai/analysis-schema-v2'
import type { Fixture, GroundTruth } from './eval-harness'

// ── Builders (mirror the shape normalizeAnalysisV2 emits) ─────────────────────
function obj(over: Partial<UnifiedObject> = {}): UnifiedObject {
  return {
    objectId: 'object_001',
    category: 'furniture',
    description: 'item',
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

function img(over: Partial<PerImageObservation> = {}): PerImageObservation {
  return {
    imageId: 'img_1',
    sceneDescription: 'scene',
    locationType: 'unknown',
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
  stairs: false, elevator: false, longCarry: false, narrowAccess: false,
  parkingRestricted: false, outdoorDistance: false, multipleRoomsOrAreas: false, notes: [],
}
const UNKNOWN_ACCESS: AccessAssessment = {
  stairs: 'unknown', elevator: 'unknown', longCarry: 'unknown', narrowAccess: 'unknown',
  parkingRestricted: 'unknown', outdoorDistance: 'unknown', multipleRoomsOrAreas: false, notes: [],
}
const LABOR: LaborAssessment = {
  estimatedCrewSize: 2, disassemblyRequired: false, heavyLifting: false, oversizedItems: false,
  applianceHandling: false, ppeRequired: [], potentialSecondTrip: false,
}
const DISPOSAL: DisposalAssessment = { surchargeItems: [], hazardousPossible: false, specialtyItems: [] }

function analysis(over: Partial<JunkPhotoAnalysisV2> = {}): JunkPhotoAnalysisV2 {
  const imageIds = ['img_1']
  return {
    schemaVersion: 2,
    bookingId: 'FIXTURE',
    analyzedAt: '2026-07-15T00:00:00.000Z',
    model: 'fixture',
    promptVersion: 'fixture',
    imageCountReceived: imageIds.length,
    imageCountUsable: imageIds.length,
    imageQualityResults: imageIds.map((id) => ({ imageId: id, quality: 'good' as const, warnings: [] })),
    perImageObservations: [img()],
    unifiedInventory: [obj()],
    sceneSummary: 'scene',
    accessAssessment: { ...KNOWN_ACCESS },
    laborAssessment: { ...LABOR },
    disposalAssessment: { ...DISPOSAL },
    volumeHint: {},
    confidence: 'high',
    confidenceScore: 0.9,
    uncertaintyReasons: [],
    missingInformation: [],
    recommendedCustomerQuestions: [],
    manualReviewRequired: false,
    manualReviewReasons: [],
    customerSafeSummary: 'summary',
    internalOwnerSummary: 'summary',
    ...over,
  }
}

// Small helper: set image counts consistently.
function counts(received: number, usable: number, quality: JunkPhotoAnalysisV2['imageQualityResults'][number]['quality'] = 'good') {
  const ids = Array.from({ length: received }, (_, i) => `img_${i + 1}`)
  return {
    imageCountReceived: received,
    imageCountUsable: usable,
    imageQualityResults: ids.map((id, i) => ({ imageId: id, quality: i < usable ? quality : ('unusable' as const), warnings: [] })),
  }
}

// ── The representative fixtures ───────────────────────────────────────────────
export const FIXTURES: Fixture[] = [
  // 1) Single couch — trivial minimum pickup.
  {
    id: 'single-couch',
    scenario: 'One couch at the curb',
    analysis: analysis({
      unifiedInventory: [obj({ objectId: 'o1', category: 'furniture', description: 'sectional couch' })],
      perImageObservations: [img({ items: [{ name: 'couch', quantity: 1, material: 'upholstered', disposalCategory: 'landfill', bulky: true, heavy: false, confidence: 'high' }] })],
    }),
    groundTruth: {
      expectedCategories: ['furniture'], expectedItemCount: 1,
      expectedVolumeCuYd: [0.8, 1.6], expectedLoadTier: 'minimum_pickup',
      expectManualReview: false, expectHazard: false, expectSpecialty: false, expectClarification: false,
    },
  },

  // 2) Bedroom cleanout — dresser, bed frame, mattress, 2 nightstands, boxes.
  {
    id: 'bedroom-cleanout',
    scenario: 'Bedroom cleanout',
    analysis: analysis({
      ...counts(3, 3),
      accessAssessment: { ...KNOWN_ACCESS },
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'furniture', description: 'dresser' }),
        obj({ objectId: 'o2', category: 'furniture', description: 'bed frame' }),
        obj({ objectId: 'o3', category: 'mattress', description: 'queen mattress', disposalClass: 'mattress' }),
        obj({ objectId: 'o4', category: 'furniture', description: 'nightstands', quantity: 2, minQuantity: 2, maxQuantity: 2 }),
        obj({ objectId: 'o5', category: 'household_trash', description: 'moving boxes', quantity: 3, minQuantity: 3, maxQuantity: 3 }),
      ],
      perImageObservations: [img({ imageId: 'img_1', locationType: 'bedroom' }), img({ imageId: 'img_2', locationType: 'bedroom' }), img({ imageId: 'img_3', locationType: 'bedroom' })],
    }),
    groundTruth: {
      expectedCategories: ['furniture', 'mattress', 'household_trash'], expectedItemCount: 8,
      expectedVolumeCuYd: [5, 9], expectedLoadTier: 'eighth',
      expectManualReview: false, expectHazard: false, expectSpecialty: false, expectClarification: false,
    },
  },

  // 3) Garage cleanout — garage items, tires, exercise equipment, boxes.
  {
    id: 'garage-cleanout',
    scenario: 'Garage cleanout',
    analysis: analysis({
      ...counts(3, 3),
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'garage_items', description: 'shelving and clutter', quantity: 6, minQuantity: 6, maxQuantity: 6 }),
        obj({ objectId: 'o2', category: 'tires', description: 'old tires', quantity: 4, minQuantity: 4, maxQuantity: 4, disposalClass: 'tire' }),
        obj({ objectId: 'o3', category: 'exercise_equipment', description: 'treadmill' }),
        obj({ objectId: 'o4', category: 'household_trash', description: 'boxes', quantity: 3, minQuantity: 3, maxQuantity: 3 }),
      ],
      disposalAssessment: { surchargeItems: ['tires'], hazardousPossible: false, specialtyItems: [] },
      perImageObservations: [img({ locationType: 'garage', tire: true })],
    }),
    groundTruth: {
      expectedCategories: ['garage_items', 'tires', 'exercise_equipment', 'household_trash'], expectedItemCount: 14,
      expectedVolumeCuYd: [5, 9], expectedLoadTier: 'eighth',
      expectManualReview: false, expectHazard: false, expectSpecialty: false, expectClarification: false,
    },
  },

  // 4) Apartment cleanout — multi-room mixed household.
  {
    id: 'apartment-cleanout',
    scenario: 'One-bedroom apartment cleanout',
    analysis: analysis({
      ...counts(5, 5),
      accessAssessment: { ...KNOWN_ACCESS, multipleRoomsOrAreas: true },
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'furniture', description: 'couch' }),
        obj({ objectId: 'o2', category: 'furniture', description: 'loveseat' }),
        obj({ objectId: 'o3', category: 'furniture', description: 'dining table' }),
        obj({ objectId: 'o4', category: 'furniture', description: 'dining chairs', quantity: 4, minQuantity: 4, maxQuantity: 4 }),
        obj({ objectId: 'o5', category: 'mattress', description: 'mattress', disposalClass: 'mattress' }),
        obj({ objectId: 'o6', category: 'furniture', description: 'dresser' }),
        obj({ objectId: 'o7', category: 'electronics', description: 'flat-screen tv', disposalClass: 'e-waste', weightClass: 'light' }),
        obj({ objectId: 'o8', category: 'household_trash', description: 'boxes', quantity: 6, minQuantity: 6, maxQuantity: 6 }),
        obj({ objectId: 'o9', category: 'household_trash', description: 'trash bags', quantity: 4, minQuantity: 4, maxQuantity: 4 }),
      ],
    }),
    groundTruth: {
      expectedCategories: ['furniture', 'mattress', 'electronics', 'household_trash'], expectedItemCount: 20,
      expectedVolumeCuYd: [12, 20], expectedLoadTier: 'three_eighths',
      expectManualReview: false, expectHazard: false, expectSpecialty: false, expectClarification: false,
    },
  },

  // 5) Full truck — near a full 24 ft box truck.
  {
    id: 'full-truck',
    scenario: 'Whole-house cleanout, near a full load',
    analysis: analysis({
      ...counts(6, 6),
      accessAssessment: { ...KNOWN_ACCESS, multipleRoomsOrAreas: true },
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'furniture', description: 'assorted furniture', quantity: 28, minQuantity: 28, maxQuantity: 28 }),
        obj({ objectId: 'o2', category: 'mattress', description: 'mattresses', quantity: 4, minQuantity: 4, maxQuantity: 4, disposalClass: 'mattress' }),
        obj({ objectId: 'o3', category: 'household_trash', description: 'boxes and bags', quantity: 8, minQuantity: 8, maxQuantity: 8 }),
      ],
    }),
    groundTruth: {
      expectedCategories: ['furniture', 'mattress', 'household_trash'], expectedItemCount: 40,
      expectedVolumeCuYd: [38, 46], expectedLoadTier: 'full',
      expectManualReview: false, expectHazard: false, expectSpecialty: false, expectClarification: false,
    },
  },

  // 6) Mixed furniture — living + dining pieces.
  {
    id: 'mixed-furniture',
    scenario: 'Mixed furniture load',
    analysis: analysis({
      ...counts(3, 3),
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'furniture', description: 'sofa' }),
        obj({ objectId: 'o2', category: 'furniture', description: 'loveseat' }),
        obj({ objectId: 'o3', category: 'furniture', description: 'dining table' }),
        obj({ objectId: 'o4', category: 'furniture', description: 'chairs', quantity: 4, minQuantity: 4, maxQuantity: 4 }),
        obj({ objectId: 'o5', category: 'furniture', description: 'dresser' }),
      ],
    }),
    groundTruth: {
      expectedCategories: ['furniture'], expectedItemCount: 8,
      expectedVolumeCuYd: [8, 12], expectedLoadTier: 'quarter',
      expectManualReview: false, expectHazard: false, expectSpecialty: false, expectClarification: false,
    },
  },

  // 7) Bags + boxes — wide quantity range → a clarifying question.
  {
    id: 'bags-and-boxes',
    scenario: 'Loose bags and boxes with an uncertain count',
    analysis: analysis({
      confidence: 'medium', confidenceScore: 0.6,
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'household_trash', description: 'trash bags', quantity: 8, minQuantity: 4, maxQuantity: 12, confidence: 'medium' }),
        obj({ objectId: 'o2', category: 'household_trash', description: 'boxes', quantity: 6, minQuantity: 6, maxQuantity: 6 }),
      ],
      perImageObservations: [img({ looseDebris: true, baggedMaterial: true })],
    }),
    groundTruth: {
      expectedCategories: ['household_trash'], expectedItemCount: 14, countTolerance: 1,
      expectedVolumeCuYd: [5, 9], expectedLoadTier: 'eighth',
      expectManualReview: true, expectHazard: false, expectSpecialty: false, expectClarification: true,
    },
  },

  // 8) Construction debris — dense, weight-limited.
  {
    id: 'construction-debris',
    scenario: 'Renovation debris pile',
    analysis: analysis({
      ...counts(2, 2),
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'construction_debris', description: 'drywall and lumber', quantity: 8, minQuantity: 8, maxQuantity: 8, disposalClass: 'construction', weightClass: 'very_heavy' }),
      ],
      perImageObservations: [img({ constructionDebris: true, locationType: 'jobsite' })],
    }),
    groundTruth: {
      expectedCategories: ['construction_debris'], expectedItemCount: 8,
      expectedVolumeCuYd: [6, 10], expectedLoadTier: 'eighth',
      expectManualReview: true, expectHazard: false, expectSpecialty: false, expectClarification: true,
    },
  },

  // 9) Yard waste — brush / branches / bagged leaves.
  {
    id: 'yard-waste',
    scenario: 'Yard debris pile',
    analysis: analysis({
      ...counts(2, 2),
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'yard_debris', description: 'branches and brush', quantity: 6, minQuantity: 6, maxQuantity: 6, disposalClass: 'yard-waste' }),
      ],
      perImageObservations: [img({ yardWaste: true, locationType: 'backyard' })],
    }),
    groundTruth: {
      expectedCategories: ['yard_debris'], expectedItemCount: 6,
      expectedVolumeCuYd: [3, 7], expectedLoadTier: 'eighth',
      expectManualReview: false, expectHazard: false, expectSpecialty: false, expectClarification: false,
    },
  },

  // 10) Appliances — refrigerator, washer, dryer.
  {
    id: 'appliances',
    scenario: 'Three large appliances',
    analysis: analysis({
      ...counts(3, 3),
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'appliance', description: 'refrigerator', weightClass: 'heavy', disposalClass: 'appliance-refrigerant' }),
        obj({ objectId: 'o2', category: 'appliance', description: 'washer', weightClass: 'heavy' }),
        obj({ objectId: 'o3', category: 'appliance', description: 'dryer', weightClass: 'heavy' }),
      ],
      laborAssessment: { ...LABOR, applianceHandling: true, heavyLifting: true },
      disposalAssessment: { surchargeItems: ['refrigerant appliance'], hazardousPossible: false, specialtyItems: [] },
      perImageObservations: [img({ refrigerantAppliance: true })],
    }),
    groundTruth: {
      expectedCategories: ['appliance'], expectedItemCount: 3,
      expectedVolumeCuYd: [2, 4], expectedLoadTier: 'eighth',
      // A refrigerant appliance (refrigerator) is a TRUE specialty — refrigerant recovery
      // requires certified handling, so it correctly routes to manual review (per policy).
      expectManualReview: true, expectHazard: false, expectSpecialty: true, expectClarification: true,
    },
  },

  // 11) Mattress + box spring.
  {
    id: 'mattress-boxspring',
    scenario: 'Mattress and box spring',
    analysis: analysis({
      ...counts(2, 2),
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'mattress', description: 'queen mattress', disposalClass: 'mattress' }),
        obj({ objectId: 'o2', category: 'mattress', description: 'box spring', disposalClass: 'mattress' }),
      ],
      perImageObservations: [img({ mattressOrBoxSpring: true })],
    }),
    groundTruth: {
      expectedCategories: ['mattress'], expectedItemCount: 2,
      expectedVolumeCuYd: [1.5, 2.75], expectedLoadTier: 'minimum_pickup',
      expectManualReview: false, expectHazard: false, expectSpecialty: false, expectClarification: false,
    },
  },

  // 12) OVERLAPPING photos of the SAME couch (dedup → count 1).
  {
    id: 'overlapping-same-item',
    scenario: 'Same couch photographed from two angles (dedup)',
    analysis: analysis({
      ...counts(2, 2),
      unifiedInventory: [
        obj({
          objectId: 'o1', category: 'furniture', description: 'sectional couch',
          quantity: 1, minQuantity: 1, maxQuantity: 1,
          sourceImageIds: ['img_1', 'img_2'],
          duplicateReasoning: 'Same sectional visible in both images — merged to one object.',
        }),
      ],
      perImageObservations: [
        img({ imageId: 'img_1', items: [{ name: 'couch', quantity: 1, material: 'upholstered', disposalCategory: 'landfill', bulky: true, heavy: false, confidence: 'high' }] }),
        img({ imageId: 'img_2', items: [{ name: 'couch', quantity: 1, material: 'upholstered', disposalCategory: 'landfill', bulky: true, heavy: false, confidence: 'high' }] }),
      ],
    }),
    groundTruth: {
      expectedCategories: ['furniture'], expectedItemCount: 1, dedupCheck: true,
      expectedVolumeCuYd: [0.8, 1.6], expectedLoadTier: 'minimum_pickup',
      expectManualReview: false, expectHazard: false, expectSpecialty: false, expectClarification: false,
    },
  },

  // 13) Different rooms, similar items — must NOT merge (count 2).
  {
    id: 'different-rooms-similar',
    scenario: 'A couch in the living room and a different couch in the basement (no merge)',
    analysis: analysis({
      ...counts(2, 2),
      accessAssessment: { ...KNOWN_ACCESS, multipleRoomsOrAreas: true },
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'furniture', description: 'living room couch', sourceImageIds: ['img_1'], duplicateReasoning: 'Distinct from the basement couch — different room, different upholstery.' }),
        obj({ objectId: 'o2', category: 'furniture', description: 'basement couch', sourceImageIds: ['img_2'], duplicateReasoning: 'Distinct from the living room couch.' }),
      ],
      perImageObservations: [
        img({ imageId: 'img_1', locationType: 'living room' }),
        img({ imageId: 'img_2', locationType: 'basement' }),
      ],
    }),
    groundTruth: {
      expectedCategories: ['furniture'], expectedItemCount: 2, dedupCheck: true,
      expectedVolumeCuYd: [1.8, 3], expectedLoadTier: 'minimum_pickup',
      expectManualReview: false, expectHazard: false, expectSpecialty: false, expectClarification: false,
    },
  },

  // 14) Poor lighting / blurry — most images unusable → low confidence → review.
  {
    id: 'poor-lighting-blurry',
    scenario: 'Dark, blurry photos — low usable coverage',
    analysis: analysis({
      ...counts(3, 1, 'poor'),
      confidence: 'low', confidenceScore: 0.35,
      uncertaintyReasons: ['Most photos too dark/blurry to read reliably.'],
      missingInformation: ['Clear photos of the full pile.'],
      recommendedCustomerQuestions: ['Could you send a clearer, well-lit photo of everything together?'],
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'furniture', description: 'possible furniture', confidence: 'low', quantity: 2, minQuantity: 1, maxQuantity: 4 }),
      ],
      perImageObservations: [
        img({ imageId: 'img_1', imageQuality: 'poor', confidence: 'low' }),
        img({ imageId: 'img_2', imageQuality: 'unusable', confidence: 'low' }),
        img({ imageId: 'img_3', imageQuality: 'unusable', confidence: 'low' }),
      ],
      accessAssessment: { ...UNKNOWN_ACCESS },
    }),
    groundTruth: {
      expectedCategories: ['furniture'], expectedItemCount: 2, countTolerance: 2,
      expectedVolumeCuYd: [1.5, 4.8], expectedLoadTier: 'minimum_pickup',
      expectManualReview: true, expectHazard: false, expectSpecialty: false, expectClarification: true,
    },
  },

  // 15) One close-up, no context — unidentified item, single viewpoint.
  {
    id: 'closeup-no-context',
    scenario: 'A single close-up of an unidentifiable object',
    analysis: analysis({
      ...counts(1, 1),
      confidence: 'medium', confidenceScore: 0.5,
      uncertaintyReasons: ['Close-up with no surrounding context — hard to identify or size.'],
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'unknown', description: 'unknown object', confidence: 'low' }),
      ],
      perImageObservations: [
        img({ imageId: 'img_1', locationType: 'unknown', confidence: 'low', uncertainObservations: ["Can't tell what this is — close-up, no context."] }),
      ],
      accessAssessment: { ...UNKNOWN_ACCESS },
    }),
    groundTruth: {
      expectedCategories: ['other'], expectedItemCount: 1,
      expectedVolumeCuYd: [0.3, 1], expectedLoadTier: 'minimum_pickup',
      expectManualReview: true, expectHazard: false, expectSpecialty: false, expectClarification: true,
    },
  },

  // 16) More than one load — clearly over a single truck → multi-load review.
  {
    id: 'more-than-one-load',
    scenario: 'Estate hoard well over one truck load',
    analysis: analysis({
      ...counts(6, 6),
      accessAssessment: { ...KNOWN_ACCESS, multipleRoomsOrAreas: true },
      laborAssessment: { ...LABOR, potentialSecondTrip: true },
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'furniture', description: 'packed furniture and belongings', quantity: 45, minQuantity: 40, maxQuantity: 50, confidence: 'medium' }),
      ],
    }),
    groundTruth: {
      expectedCategories: ['furniture'], expectedItemCount: 45, countTolerance: 2,
      expectedVolumeCuYd: [48, 62], expectedLoadTier: 'more_than_one_load',
      expectManualReview: true, expectHazard: false, expectSpecialty: false, expectClarification: true,
    },
  },

  // 17) Hazard concern — paint / chemicals → hazard flag + review + clarify.
  {
    id: 'hazard-paint-chemicals',
    scenario: 'Garage with paint cans and chemicals',
    analysis: analysis({
      ...counts(2, 2),
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'hazardous', description: 'paint cans and chemicals', quantity: 5, minQuantity: 5, maxQuantity: 5, disposalClass: 'hazardous', weightClass: 'light' }),
        obj({ objectId: 'o2', category: 'furniture', description: 'old workbench' }),
      ],
      disposalAssessment: { surchargeItems: ['paint', 'chemicals'], hazardousPossible: true, specialtyItems: [] },
      perImageObservations: [img({ paintOrChemical: true, hazardousConcern: true, locationType: 'garage' })],
    }),
    groundTruth: {
      expectedCategories: ['hazardous', 'furniture'], expectedItemCount: 6,
      expectedVolumeCuYd: [1.5, 3], expectedLoadTier: 'minimum_pickup',
      expectManualReview: true, expectHazard: true, expectSpecialty: false, expectClarification: true,
    },
  },

  // 18) Specialty item — a piano → specialty flag + review.
  {
    id: 'specialty-piano',
    scenario: 'Upright piano plus a few boxes',
    analysis: analysis({
      ...counts(2, 2),
      unifiedInventory: [
        obj({ objectId: 'o1', category: 'piano', description: 'upright piano', weightClass: 'very_heavy', disposalClass: 'landfill', specialHandling: ['piano dolly', '2-person lift'] }),
        obj({ objectId: 'o2', category: 'household_trash', description: 'boxes', quantity: 3, minQuantity: 3, maxQuantity: 3 }),
      ],
      laborAssessment: { ...LABOR, heavyLifting: true, oversizedItems: true },
      disposalAssessment: { surchargeItems: [], hazardousPossible: false, specialtyItems: ['piano'] },
    }),
    groundTruth: {
      expectedCategories: ['piano', 'household_trash'], expectedItemCount: 4,
      expectedVolumeCuYd: [2, 4], expectedLoadTier: 'eighth',
      expectManualReview: true, expectHazard: false, expectSpecialty: true, expectClarification: false,
    },
  },

  // 19) No usable images — empty inventory → manual-review shell.
  {
    id: 'no-usable-images',
    scenario: 'All photos unusable',
    analysis: analysis({
      ...counts(2, 0, 'unusable'),
      confidence: 'low', confidenceScore: 0,
      uncertaintyReasons: ['No usable photos.'],
      missingInformation: ['Any usable photo of the items.'],
      recommendedCustomerQuestions: ['Could you resend clear photos of the items you want removed?'],
      unifiedInventory: [],
      perImageObservations: [
        img({ imageId: 'img_1', imageQuality: 'unusable', confidence: 'low', items: [] }),
        img({ imageId: 'img_2', imageQuality: 'unusable', confidence: 'low', items: [] }),
      ],
      accessAssessment: { ...UNKNOWN_ACCESS },
      manualReviewRequired: true,
      manualReviewReasons: ['No usable photos.'],
    }),
    groundTruth: {
      expectedCategories: [], expectedItemCount: 0,
      expectedVolumeCuYd: [0, 0.5], expectedLoadTier: 'minimum_pickup',
      expectManualReview: true, expectHazard: false, expectSpecialty: false, expectClarification: true,
    },
  },
]

// A small, self-contained set that is guaranteed to meet the thresholds — used by
// tests to prove the gate passes on a clean set (and, with a bad case appended, fails).
export const CLEAN_MINIMAL_FIXTURES: Fixture[] = [
  FIXTURES[0], // single-couch
  FIXTURES[11], // overlapping-same-item (dedup)
  FIXTURES[16], // hazard-paint-chemicals
]

export type { Fixture, GroundTruth }
