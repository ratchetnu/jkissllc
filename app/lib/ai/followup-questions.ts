// ─────────────────────────────────────────────────────────────────────────────
// Targeted follow-up question selection (Part 5). A governed catalog of questions,
// selected — not all shown — based on the service family, the AI-detected items,
// photo quality, item risk, access signals, and pricing uncertainty. Each answer
// maps to a structured field (AccessConditions / Disclosures) or a generic
// FollowUpAnswer, so nothing lands in a free-text blob.
//
// Pure + dependency-free so the exact set a customer sees is deterministic and
// unit-testable. The customer is never shown every possible question.
// ─────────────────────────────────────────────────────────────────────────────

import type { JunkPhotoAnalysis } from './analysis-schema'
import type { ServiceFamily } from '../bookings'

export type FollowUpKind = 'boolean' | 'number' | 'text' | 'single' | 'multi'
export type FollowUpGroup = 'inventory' | 'access' | 'disclosure' | 'logistics'

export type FollowUpQuestion = {
  id: string
  group: FollowUpGroup
  prompt: string
  kind: FollowUpKind
  options?: string[]                 // for single/multi
  // Where the answer is stored: a dotted path into the confirmation record, or a
  // generic followUpAnswers[] entry when `path` is omitted.
  path?: string                      // e.g. 'accessConditions.elevatorAvailable'
  helpText?: string
}

export type QuestionSelectionContext = {
  serviceFamily: ServiceFamily
  analysis?: Pick<JunkPhotoAnalysis,
    'detectedConditions' | 'normalizedItems' | 'confidence' | 'photoObservations' | 'estimatedTruckLoadFraction'>
  // Signals from the customer's item corrections so far (optional):
  customerAddedItemCount?: number
  customerRemovedItemCount?: number
  hasUncertainItems?: boolean
}

// The full governed catalog, keyed by id. Selection picks a subset from here.
export const QUESTION_CATALOG: Record<string, FollowUpQuestion> = {
  // ── Junk / cleanout: inventory completeness ──
  everything_visible: {
    id: 'everything_visible', group: 'disclosure', kind: 'boolean',
    prompt: 'Is everything you want removed visible in your photos?',
    path: 'disclosures.everythingVisibleInPhotos',
  },
  additional_not_pictured: {
    id: 'additional_not_pictured', group: 'disclosure', kind: 'boolean',
    prompt: 'Are there additional items not shown in the photos?',
    path: 'disclosures.additionalItemsNotPictured',
  },
  additional_note: {
    id: 'additional_note', group: 'disclosure', kind: 'text',
    prompt: 'What else should we know about the items not pictured?',
    path: 'disclosures.additionalItemsNote',
  },
  hidden_items: {
    id: 'hidden_items', group: 'disclosure', kind: 'boolean',
    prompt: 'Are there items hidden behind furniture or in piles?',
    path: 'disclosures.hiddenItems',
  },
  // ── Junk: access ──
  rooms: {
    id: 'rooms', group: 'access', kind: 'number',
    prompt: 'How many rooms or separate areas are included?',
    path: 'accessConditions.rooms',
  },
  items_upstairs: {
    id: 'items_upstairs', group: 'access', kind: 'boolean',
    prompt: 'Are any items upstairs or downstairs?',
    path: 'accessConditions.itemsUpstairs',
  },
  elevator_available: {
    id: 'elevator_available', group: 'access', kind: 'boolean',
    prompt: 'Is an elevator available?',
    path: 'accessConditions.elevatorAvailable',
  },
  long_carry: {
    id: 'long_carry', group: 'access', kind: 'boolean',
    prompt: 'Is there a long carry from the items to where we can park the truck?',
    path: 'accessConditions.longCarry',
  },
  parking_near: {
    id: 'parking_near', group: 'access', kind: 'boolean',
    prompt: 'Can we park near the entrance?',
    path: 'accessConditions.parkingNearEntrance',
  },
  appliances_connected: {
    id: 'appliances_connected', group: 'access', kind: 'boolean',
    prompt: 'Are any appliances still connected (water, gas, or power)?',
    path: 'accessConditions.appliancesConnected',
  },
  already_bagged: {
    id: 'already_bagged', group: 'access', kind: 'boolean',
    prompt: 'Are items already bagged, boxed, or disassembled?',
    path: 'accessConditions.alreadyBaggedOrBoxed',
  },
  requires_disassembly: {
    id: 'requires_disassembly', group: 'access', kind: 'boolean',
    prompt: 'Does anything need to be taken apart before removal?',
    path: 'accessConditions.requiresDisassembly',
  },
  property_occupied: {
    id: 'property_occupied', group: 'access', kind: 'boolean',
    prompt: 'Is the property currently occupied?',
    path: 'accessConditions.propertyOccupied',
  },
  access_restrictions: {
    id: 'access_restrictions', group: 'access', kind: 'multi',
    prompt: 'Are there any access restrictions?',
    options: ['Gate code', 'Apartment / unit', 'Elevator reservation', 'Loading dock', 'Time window', 'None'],
    path: 'accessConditions.accessRestrictions',
  },
  // ── Junk: risk disclosures ──
  excessively_heavy: {
    id: 'excessively_heavy', group: 'disclosure', kind: 'boolean',
    prompt: 'Are any items excessively heavy (safe, piano, large appliance, dense debris)?',
    path: 'disclosures.excessivelyHeavyItems',
  },
  dense_debris: {
    id: 'dense_debris', group: 'disclosure', kind: 'boolean',
    prompt: 'Does the load contain concrete, dirt, brick, shingles, tile, or flooring?',
    path: 'disclosures.containsDenseDebris',
  },
  hazardous: {
    id: 'hazardous', group: 'disclosure', kind: 'boolean',
    prompt: 'Does the load contain paint, chemicals, fuel, tires, or batteries?',
    path: 'disclosures.containsHazardous',
  },
  hazardous_detail: {
    id: 'hazardous_detail', group: 'disclosure', kind: 'text',
    prompt: 'Please describe the hazardous or special-disposal items.',
    path: 'disclosures.hazardousDetail',
  },
  // ── Moving / delivery ──
  pickup_address: {
    id: 'pickup_address', group: 'logistics', kind: 'text',
    prompt: 'Pickup address', path: 'accessConditions.pickupAddress',
  },
  delivery_address: {
    id: 'delivery_address', group: 'logistics', kind: 'text',
    prompt: 'Delivery address', path: 'accessConditions.deliveryAddress',
  },
  stairs_pickup: {
    id: 'stairs_pickup', group: 'logistics', kind: 'boolean',
    prompt: 'Are there stairs at the pickup?', path: 'accessConditions.stairsAtPickup',
  },
  stairs_delivery: {
    id: 'stairs_delivery', group: 'logistics', kind: 'boolean',
    prompt: 'Are there stairs at the delivery?', path: 'accessConditions.stairsAtDelivery',
  },
  walking_distance: {
    id: 'walking_distance', group: 'logistics', kind: 'boolean',
    prompt: 'Is there a long walk from the truck to the door at either stop?',
    path: 'accessConditions.walkingDistanceLong',
  },
  large_fragile: {
    id: 'large_fragile', group: 'logistics', kind: 'boolean',
    prompt: 'Are there large or fragile items (glass, art, TVs)?',
    path: 'accessConditions.largeOrFragileItems',
  },
  appliance_disconnect: {
    id: 'appliance_disconnect', group: 'logistics', kind: 'boolean',
    prompt: 'Do any appliances need disconnecting or reconnecting?',
    path: 'accessConditions.applianceDisconnectReconnect',
  },
  assembly: {
    id: 'assembly', group: 'logistics', kind: 'boolean',
    prompt: 'Does anything need assembly or disassembly?',
    path: 'accessConditions.assemblyDisassembly',
  },
  additional_stops: {
    id: 'additional_stops', group: 'logistics', kind: 'number',
    prompt: 'How many additional stops (besides pickup and delivery)?',
    path: 'accessConditions.additionalStops',
  },
  arrival_window: {
    id: 'arrival_window', group: 'logistics', kind: 'text',
    prompt: 'Do you have a requested arrival window?',
    path: 'accessConditions.requestedArrivalWindow',
  },
}

// The always-asked junk baseline (completeness + core access), in display order.
const JUNK_BASE = ['everything_visible', 'additional_not_pictured', 'rooms', 'items_upstairs', 'parking_near']
// The always-asked moving baseline.
const MOVING_BASE = [
  'pickup_address', 'delivery_address', 'stairs_pickup', 'stairs_delivery',
  'walking_distance', 'large_fragile', 'assembly', 'additional_stops', 'arrival_window',
]

/**
 * Select the targeted subset of follow-up questions for this request. Deterministic:
 * same context → same ordered list. Never returns duplicates.
 */
export function selectFollowUpQuestions(ctx: QuestionSelectionContext): FollowUpQuestion[] {
  const ids: string[] = []
  const add = (id: string) => { if (!ids.includes(id) && QUESTION_CATALOG[id]) ids.push(id) }

  if (ctx.serviceFamily === 'moving') {
    MOVING_BASE.forEach(add)
    if (ctx.analysis?.normalizedItems.some(i => i.category === 'appliance')) add('appliance_disconnect')
    return ids.map(id => QUESTION_CATALOG[id])
  }

  // Junk / cleanout (and 'other', which we treat like junk for questioning).
  JUNK_BASE.forEach(add)

  const a = ctx.analysis
  const cond = a?.detectedConditions
  const items = a?.normalizedItems ?? []

  // Access questions driven by detected/uncertain access conditions.
  if (cond?.stairs || cond?.elevator) add('elevator_available')
  if (cond?.longCarry || cond?.narrowAccess) add('long_carry')
  if (cond?.stairs) add('items_upstairs')

  // Item-risk driven disclosures.
  const heavy = cond?.heavyItemsPresent || items.some(i => i.heavy)
  if (heavy) add('excessively_heavy')
  if (items.some(i => i.requiresDisassembly) || cond?.disassemblyRequired) add('requires_disassembly')
  if (items.some(i => i.category === 'appliance') || cond?.refrigerantAppliancePossible) add('appliances_connected')

  // Always ask the two safety disclosures (dense + hazardous) for junk — cheap and
  // high-value for pricing/risk. Escalate to detail when the analysis already hints.
  add('dense_debris')
  add('hazardous')
  if (cond?.hazardousMaterialPossible || cond?.paintOrChemicalPossible || cond?.tiresPossible) add('hazardous_detail')

  // Pricing-uncertainty driven questions.
  const lowConf = (a?.confidence?.overall ?? 1) < 0.7 || (a?.confidence?.volume ?? 1) < 0.6
  const multiLoad = (a?.estimatedTruckLoadFraction?.likely ?? 0) > 1
  if (lowConf || multiLoad || ctx.hasUncertainItems) add('hidden_items')
  if (multiLoad) add('access_restrictions')

  // Photo-quality driven completeness prompt.
  const poorPhotos = (a?.photoObservations ?? []).some(p => p.imageQuality === 'limited' || p.imageQuality === 'unusable')
  if (poorPhotos || (ctx.customerRemovedItemCount ?? 0) > 0) add('additional_note')

  // Occupancy matters for eviction/estate-style cleanouts (heuristic: any indoor removal).
  if (cond?.indoorRemoval) add('property_occupied')

  return ids.map(id => QUESTION_CATALOG[id])
}
