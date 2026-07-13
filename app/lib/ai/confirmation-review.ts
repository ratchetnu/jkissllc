// ─────────────────────────────────────────────────────────────────────────────
// Owner-facing review projection (Part 12). Turns a booking's INITIAL AI estimate,
// the customer CONFIRMATION, any OWNER edits, and the FINAL governed analysis into
// one structured, display-ready model that clearly distinguishes:
//   AI detected · Customer confirmed · Owner modified · Final approved
//
// Pure + dependency-free (no I/O). The original data is never mutated — this only
// reads. Used by the OpsPilot detail page and unit-tested directly.
// ─────────────────────────────────────────────────────────────────────────────

import type { Booking } from '../bookings'
import { taxonomyEntry, type InventoryCategory } from './inventory-taxonomy'
import {
  activeItems, customerAddedItems, removedDetections, sensitiveItems, isEstateConfirmation,
  CLEANOUT_SUBTYPE_LABEL,
  type CustomerConfirmation, type ConfirmedItem, type ConflictFlag, type Disposition, type EstateIntake,
} from './confirmation-schema'

export type ItemProvenance = 'ai' | 'customer' | 'owner' | 'combined'

export type ReviewItem = {
  name: string
  category: InventoryCategory
  categoryLabel: string
  quantity: number
  provenance: ItemProvenance
  aiDetected: boolean
  uncertain: boolean
  removed: boolean
  disposition?: Disposition
  sensitive: boolean
  // The original AI read, preserved for side-by-side display when it differs.
  aiName?: string
  aiQuantity?: number
  changed: boolean            // customer/owner changed name or quantity vs the AI read
}

export type ReviewEstimate = {
  decision: string
  recommendedUsd: number
  lowUsd: number
  highUsd: number
  confidencePct?: number
}

export type OwnerReviewModel = {
  hasConfirmation: boolean
  hasFinal: boolean
  // Provenance counters (Part 12 "clearly distinguish").
  counts: { aiDetected: number; customerConfirmed: number; customerAdded: number; removed: number; ownerModified: number; uncertain: number }
  items: ReviewItem[]
  // Access answers + disclosures + attestation + photo-quality, display-ready.
  accessAnswers: { label: string; value: string }[]
  disclosures: { label: string; value: string; risk: boolean }[]
  photoQuality: { label: string; value: string }[]
  attestation?: { at: string; version: number; complete: boolean }
  isEverything?: string
  conflicts: ConflictFlag[]
  conflictSeverity: 'none' | 'minor' | 'material'
  // Initial vs final estimates + confidences.
  // Estate / cleanout (Estate Cleanout edition).
  isEstate: boolean
  estate?: EstateIntake
  estateSubtypeLabel?: string
  sensitiveItemNames: string[]
  siteVisit: boolean
  dispositionCounts: Record<Disposition, number>
  initial?: ReviewEstimate
  final?: ReviewEstimate & {
    tier: string
    finalDecision: string
    truckLoadMin: number
    truckLoadMax: number
    laborHours: number
    crewSize: number
    disposalUsd: number
    expectedTrips: number
    specialHandling: boolean
    evidenceSummary: string[]
    missingInfo: string[]
    policyVersion: string
    confirmationVersion: number
  }
  ownerOverrideUsd?: number
}

const yesNo = (v: boolean | undefined): string | undefined => (v === true ? 'Yes' : v === false ? 'No' : undefined)

function reviewItem(it: ConfirmedItem): ReviewItem {
  const tax = taxonomyEntry(it.category)
  const changed = it.aiDetected
    ? (it.aiQuantity != null && it.aiQuantity !== it.quantity) || (!!it.aiName && it.aiName !== it.name) || it.source === 'owner'
    : true
  return {
    name: it.name,
    category: it.category,
    categoryLabel: tax.short,
    quantity: it.quantity,
    provenance: it.source,
    aiDetected: it.aiDetected,
    uncertain: it.uncertain,
    removed: it.removed,
    disposition: it.disposition,
    sensitive: tax.sensitive === true,
    aiName: it.aiName,
    aiQuantity: it.aiQuantity,
    changed,
  }
}

function accessAnswers(c: CustomerConfirmation): { label: string; value: string }[] {
  const a = c.accessConditions
  const out: { label: string; value: string }[] = []
  const add = (label: string, v?: string) => { if (v) out.push({ label, value: v }) }
  if (a.rooms != null) add('Rooms / areas', String(a.rooms))
  add('Items upstairs/downstairs', yesNo(a.itemsUpstairs))
  add('Elevator available', yesNo(a.elevatorAvailable))
  add('Long carry', yesNo(a.longCarry))
  add('Parking near entrance', yesNo(a.parkingNearEntrance))
  add('Appliances connected', yesNo(a.appliancesConnected))
  add('Already bagged/boxed', yesNo(a.alreadyBaggedOrBoxed))
  add('Requires disassembly', yesNo(a.requiresDisassembly))
  add('Property occupied', yesNo(a.propertyOccupied))
  if (a.accessRestrictions?.length) add('Access restrictions', a.accessRestrictions.join(', '))
  // Moving/delivery-specific
  add('Pickup address', a.pickupAddress)
  add('Delivery address', a.deliveryAddress)
  add('Stairs at pickup', yesNo(a.stairsAtPickup))
  add('Stairs at delivery', yesNo(a.stairsAtDelivery))
  add('Long walk', yesNo(a.walkingDistanceLong))
  add('Large/fragile items', yesNo(a.largeOrFragileItems))
  add('Appliance disconnect/reconnect', yesNo(a.applianceDisconnectReconnect))
  add('Assembly/disassembly', yesNo(a.assemblyDisassembly))
  if (a.additionalStops != null && a.additionalStops > 0) add('Additional stops', String(a.additionalStops))
  add('Requested arrival window', a.requestedArrivalWindow)
  return out
}

function disclosures(c: CustomerConfirmation): { label: string; value: string; risk: boolean }[] {
  const d = c.disclosures
  const out: { label: string; value: string; risk: boolean }[] = []
  const add = (label: string, v: boolean | undefined, risk: boolean, note?: string) => {
    if (v === undefined) return
    out.push({ label, value: v ? (note ? `Yes — ${note}` : 'Yes') : 'No', risk: risk && v === true })
  }
  add('Everything visible in photos', d.everythingVisibleInPhotos, false)
  add('Additional items not pictured', d.additionalItemsNotPictured, true, d.additionalItemsNote)
  add('Hidden items', d.hiddenItems, true, d.hiddenItemsNote)
  add('Dense debris (concrete/soil/etc.)', d.containsDenseDebris, true)
  add('Hazardous / special-disposal', d.containsHazardous, true, d.hazardousDetail)
  add('Excessively heavy items', d.excessivelyHeavyItems, true)
  return out
}

export function buildOwnerReviewModel(b: Booking): OwnerReviewModel {
  const c = b.confirmation
  const fe = b.finalAiEstimate
  const ai = b.aiEstimate

  const items = c ? c.items.map(reviewItem) : []
  const counts = {
    aiDetected: c ? c.items.filter(i => i.aiDetected).length : 0,
    customerConfirmed: c ? activeItems(c).filter(i => i.aiDetected).length : 0,
    customerAdded: c ? customerAddedItems(c).length : 0,
    removed: c ? removedDetections(c).length : 0,
    ownerModified: c ? c.items.filter(i => i.source === 'owner').length : 0,
    uncertain: c ? c.items.filter(i => i.uncertain && !i.removed).length : 0,
  }

  const conflicts = c?.conflicts ?? []
  const conflictSeverity: OwnerReviewModel['conflictSeverity'] =
    conflicts.some(f => f.severity === 'material') ? 'material'
    : conflicts.length > 0 ? 'minor' : 'none'

  const initial: ReviewEstimate | undefined = ai?.pricing
    ? { decision: ai.decision, recommendedUsd: ai.pricing.recommendedUsd, lowUsd: ai.pricing.lowUsd, highUsd: ai.pricing.highUsd, confidencePct: ai.analysis?.confidence?.overall != null ? Math.round(ai.analysis.confidence.overall * 100) : undefined }
    : undefined

  const final = fe
    ? {
        decision: fe.finalDecision,
        recommendedUsd: fe.pricing.recommendedUsd,
        lowUsd: fe.pricing.lowUsd,
        highUsd: fe.pricing.highUsd,
        confidencePct: fe.mergedAnalysis?.confidence?.overall != null ? Math.round(fe.mergedAnalysis.confidence.overall * 100) : undefined,
        tier: fe.routingTier,
        finalDecision: fe.finalDecision,
        truckLoadMin: fe.truckLoadMin,
        truckLoadMax: fe.truckLoadMax,
        laborHours: fe.laborHours,
        crewSize: fe.crewSize,
        disposalUsd: fe.disposalUsd,
        expectedTrips: fe.expectedTrips,
        specialHandling: fe.specialHandling,
        evidenceSummary: fe.evidenceSummary,
        missingInfo: fe.missingInfo,
        policyVersion: fe.policyVersion,
        confirmationVersion: fe.confirmationVersion,
      }
    : undefined

  const isEverythingMap: Record<string, string> = { yes: 'Yes, everything', more_items: 'More items not pictured', another_area: 'Another room/area', unsure: 'Not sure' }
  const isEverythingKey = c?.disclosures.everythingVisibleInPhotos === true ? 'yes'
    : c?.disclosures.additionalItemsNotPictured ? 'more_items'
    : c?.disclosures.hiddenItems ? 'unsure' : undefined

  return {
    hasConfirmation: !!c,
    hasFinal: !!fe,
    counts,
    items,
    accessAnswers: c ? accessAnswers(c) : [],
    disclosures: c ? disclosures(c) : [],
    photoQuality: c
      ? [
          { label: 'Wide shot included', value: yesNo(c.photoQuality.hasWideShot) ?? '—' },
          { label: 'All items pictured', value: yesNo(c.photoQuality.allItemsPictured) ?? '—' },
          { label: 'Access photos included', value: yesNo(c.photoQuality.accessPhotosIncluded) ?? '—' },
        ].filter(x => x.value !== '—')
      : [],
    attestation: c?.attestation
      ? { at: c.attestation.at, version: c.attestation.version, complete: c.attestation.representsEverything && c.attestation.hazardousDisclosed && c.attestation.accessDisclosed }
      : undefined,
    isEverything: isEverythingKey ? isEverythingMap[isEverythingKey] : undefined,
    conflicts,
    conflictSeverity,
    isEstate: c ? isEstateConfirmation(c) : false,
    estate: c?.estate,
    estateSubtypeLabel: c?.estate?.subtype ? CLEANOUT_SUBTYPE_LABEL[c.estate.subtype] : undefined,
    sensitiveItemNames: c ? sensitiveItems(c).map(i => i.name) : [],
    siteVisit: fe?.finalDecision === 'site_visit_required',
    dispositionCounts: c
      ? activeItems(c).reduce((acc, i) => { if (i.disposition) acc[i.disposition]++; return acc }, { keep: 0, donate: 0, recycle: 0, sell: 0, dispose: 0 } as Record<Disposition, number>)
      : { keep: 0, donate: 0, recycle: 0, sell: 0, dispose: 0 },
    initial,
    final,
    ownerOverrideUsd: b.finalAiEstimate ? undefined : b.aiEstimate?.override?.overriddenUsd,
  }
}
