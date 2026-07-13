// ─────────────────────────────────────────────────────────────────────────────
// Customer inventory-confirmation record — the structured, versioned capture of
// what the customer confirmed/corrected after the FIRST AI analysis, plus the
// targeted follow-up answers, disclosures, and attestation.
//
// This is UNTRUSTED client input. `normalizeConfirmation` clamps/defaults every
// field into a well-formed `CustomerConfirmation`, normalizes every item into the
// governed taxonomy (inventory-taxonomy.ts), and NEVER throws and NEVER produces a
// price. It records source provenance (ai / customer / owner / combined) so the
// original AI read is never lost — the confirmation is layered on top, additive.
//
// Pure + dependency-free (timestamps passed in) so it is directly unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

import {
  normalizeToInventoryCategory, taxonomyEntry,
  type InventoryCategory,
} from './inventory-taxonomy'

export const CONFIRMATION_SCHEMA_VERSION = 1
export const ATTESTATION_VERSION = 1

// Where a confirmed value came from — so AI vs customer vs owner is always distinguishable.
export type ItemSource = 'ai' | 'customer' | 'owner' | 'combined'

export type ConfirmedItem = {
  id: string
  category: InventoryCategory        // governed, normalized
  name: string                       // customer-facing label (may be corrected free text)
  quantity: number                   // customer-confirmed quantity
  uncertain: boolean                 // customer marked "not sure"
  removed: boolean                   // customer removed this AI detection (false positive)
  source: ItemSource
  // Preserved original AI read (never overwritten) when this row came from the model:
  aiDetected: boolean
  aiCategory?: InventoryCategory
  aiName?: string
  aiQuantity?: number
  aiConfidence?: number
  sourcePhotoUrl?: string            // source photo reference where practical
  freeText?: string                  // raw "Other" text before normalization
}

// Structured access conditions (junk + moving share the shape; moving-only fields
// are optional). Booleans default false; unknowns stay undefined.
export type AccessConditions = {
  // Junk / cleanout
  rooms?: number
  itemsUpstairs?: boolean
  itemsDownstairs?: boolean
  elevatorAvailable?: boolean
  longCarry?: boolean
  parkingNearEntrance?: boolean
  appliancesConnected?: boolean
  excessivelyHeavy?: boolean
  alreadyBaggedOrBoxed?: boolean
  requiresDisassembly?: boolean
  propertyOccupied?: boolean
  accessRestrictions?: string[]      // gate/apartment/elevator/loading-dock/etc
  // Moving / delivery
  pickupAddress?: string
  deliveryAddress?: string
  stairsAtPickup?: boolean
  stairsAtDelivery?: boolean
  walkingDistanceLong?: boolean
  largeOrFragileItems?: boolean
  applianceDisconnectReconnect?: boolean
  assemblyDisassembly?: boolean
  additionalStops?: number
  requestedArrivalWindow?: string
}

// Heavy / special-material and hidden-item disclosures (Part 5, 6, 8).
export type Disclosures = {
  everythingVisibleInPhotos?: boolean   // "is everything to be removed visible?"
  additionalItemsNotPictured?: boolean
  additionalItemsNote?: string
  containsDenseDebris?: boolean         // concrete/dirt/brick/shingles/tile/flooring
  containsHazardous?: boolean           // paint/chemicals/tires/batteries/fuel
  hazardousDetail?: string
  excessivelyHeavyItems?: boolean
  hiddenItems?: boolean
  hiddenItemsNote?: string
}

// Photo-quality confirmation captured with the request (Part 2).
export type PhotoQualityAnswers = {
  hasWideShot?: boolean
  allItemsPictured?: boolean
  accessPhotosIncluded?: boolean
  note?: string
}

// The customer attestation — recorded with its version + timestamp (Part 6).
export type Attestation = {
  version: number
  at: string                        // ISO
  representsEverything: boolean
  additionalMayChangePrice: boolean
  hazardousDisclosed: boolean
  accessDisclosed: boolean
  mayRequireOwnerReview: boolean
}

// A generic structured follow-up answer (Part 5) — the selector may pose questions
// beyond the fixed AccessConditions shape; those land here as typed key/values.
export type FollowUpAnswer = {
  questionId: string
  value: string | number | boolean | string[]
}

// A photo-text consistency flag (Part 8). Neutral, non-accusatory language only.
export type ConflictSeverity = 'info' | 'minor' | 'material'
export type ConflictFlag = {
  code: string
  severity: ConflictSeverity
  message: string                   // neutral, customer-safe
}

export type ConfirmationStatus =
  | 'draft'
  | 'submitted'
  | 'superseded'                    // replaced by a newer confirmation version

export type CustomerConfirmation = {
  schemaVersion: number
  confirmationVersion: number       // monotonic per booking (1,2,3…) — supports re-submit
  status: ConfirmationStatus
  submittedAt: string               // ISO
  submittedBy: 'customer' | 'owner' // owner-assisted confirmation is supported (Part 17)
  items: ConfirmedItem[]
  accessConditions: AccessConditions
  disclosures: Disclosures
  photoQuality: PhotoQualityAnswers
  followUpAnswers: FollowUpAnswer[]
  attestation?: Attestation         // required for a customer submit; optional for an owner draft
  conflicts: ConflictFlag[]
  notes?: string                    // optional free notes (never the primary input)
  idempotencyKey?: string
}

// ── coercion helpers (mirror analysis-schema idioms) ─────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const numOr = (v: unknown, d: number): number => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? n : d }
const clampInt = (v: unknown, lo: number, hi: number, d: number): number => Math.min(hi, Math.max(lo, Math.round(numOr(v, d))))
const boolOpt = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const boolOr = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d)
const strOr = (v: unknown, d = '', max = 400): string => (typeof v === 'string' ? v : d).slice(0, max).trim()
const strOpt = (v: unknown, max = 400): string | undefined => {
  const s = typeof v === 'string' ? v.slice(0, max).trim() : ''
  return s || undefined
}
const strArr = (v: unknown, max = 12, len = 120): string[] =>
  Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, max).map(x => (x as string).slice(0, len).trim()).filter(Boolean) : []

export const MAX_CONFIRMED_ITEMS = 80

function normalizeItem(v: unknown, i: number): ConfirmedItem | null {
  if (!isObj(v)) return null
  const removed = boolOr(v.removed)
  const freeText = strOpt(v.freeText ?? v.otherText, 200)
  const category = normalizeToInventoryCategory(v.category, freeText ?? (typeof v.name === 'string' ? v.name : ''))
  const entry = taxonomyEntry(category)
  const name = strOr(v.name ?? v.label, entry.label, 120) || entry.label
  const aiDetected = boolOr(v.aiDetected)
  const source: ItemSource = ((): ItemSource => {
    const s = String(v.source ?? '').toLowerCase()
    if (s === 'ai' || s === 'customer' || s === 'owner' || s === 'combined') return s
    return aiDetected ? 'combined' : 'customer'
  })()
  return {
    id: strOr(v.id, `item-${i}`, 64) || `item-${i}`,
    category,
    name,
    quantity: clampInt(v.quantity, removed ? 0 : 1, 999, 1),
    uncertain: boolOr(v.uncertain),
    removed,
    source,
    aiDetected,
    aiCategory: aiDetected ? normalizeToInventoryCategory(v.aiCategory ?? v.category) : undefined,
    aiName: aiDetected ? strOpt(v.aiName, 120) : undefined,
    aiQuantity: aiDetected ? clampInt(v.aiQuantity, 0, 999, 1) : undefined,
    aiConfidence: aiDetected && v.aiConfidence != null ? Math.min(1, Math.max(0, numOr(v.aiConfidence, 0))) : undefined,
    sourcePhotoUrl: strOpt(v.sourcePhotoUrl, 1000),
    freeText,
  }
}

function normalizeAccess(v: unknown): AccessConditions {
  const o = isObj(v) ? v : {}
  const rooms = o.rooms != null ? clampInt(o.rooms, 0, 60, 1) : undefined
  const stops = o.additionalStops != null ? clampInt(o.additionalStops, 0, 20, 0) : undefined
  return {
    rooms,
    itemsUpstairs: boolOpt(o.itemsUpstairs),
    itemsDownstairs: boolOpt(o.itemsDownstairs),
    elevatorAvailable: boolOpt(o.elevatorAvailable),
    longCarry: boolOpt(o.longCarry),
    parkingNearEntrance: boolOpt(o.parkingNearEntrance),
    appliancesConnected: boolOpt(o.appliancesConnected),
    excessivelyHeavy: boolOpt(o.excessivelyHeavy),
    alreadyBaggedOrBoxed: boolOpt(o.alreadyBaggedOrBoxed),
    requiresDisassembly: boolOpt(o.requiresDisassembly),
    propertyOccupied: boolOpt(o.propertyOccupied),
    accessRestrictions: o.accessRestrictions != null ? strArr(o.accessRestrictions, 12, 80) : undefined,
    pickupAddress: strOpt(o.pickupAddress, 240),
    deliveryAddress: strOpt(o.deliveryAddress, 240),
    stairsAtPickup: boolOpt(o.stairsAtPickup),
    stairsAtDelivery: boolOpt(o.stairsAtDelivery),
    walkingDistanceLong: boolOpt(o.walkingDistanceLong),
    largeOrFragileItems: boolOpt(o.largeOrFragileItems),
    applianceDisconnectReconnect: boolOpt(o.applianceDisconnectReconnect),
    assemblyDisassembly: boolOpt(o.assemblyDisassembly),
    additionalStops: stops,
    requestedArrivalWindow: strOpt(o.requestedArrivalWindow, 80),
  }
}

function normalizeDisclosures(v: unknown): Disclosures {
  const o = isObj(v) ? v : {}
  return {
    everythingVisibleInPhotos: boolOpt(o.everythingVisibleInPhotos),
    additionalItemsNotPictured: boolOpt(o.additionalItemsNotPictured),
    additionalItemsNote: strOpt(o.additionalItemsNote, 300),
    containsDenseDebris: boolOpt(o.containsDenseDebris),
    containsHazardous: boolOpt(o.containsHazardous),
    hazardousDetail: strOpt(o.hazardousDetail, 300),
    excessivelyHeavyItems: boolOpt(o.excessivelyHeavyItems),
    hiddenItems: boolOpt(o.hiddenItems),
    hiddenItemsNote: strOpt(o.hiddenItemsNote, 300),
  }
}

function normalizeAttestation(v: unknown, at: string): Attestation | undefined {
  if (!isObj(v)) return undefined
  // Only record an attestation if the customer actually affirmed the core statement.
  const representsEverything = boolOr(v.representsEverything)
  return {
    version: ATTESTATION_VERSION,
    at,
    representsEverything,
    additionalMayChangePrice: boolOr(v.additionalMayChangePrice),
    hazardousDisclosed: boolOr(v.hazardousDisclosed),
    accessDisclosed: boolOr(v.accessDisclosed),
    mayRequireOwnerReview: boolOr(v.mayRequireOwnerReview),
  }
}

function normalizeFollowUps(v: unknown): FollowUpAnswer[] {
  if (!Array.isArray(v)) return []
  const out: FollowUpAnswer[] = []
  for (const raw of v.slice(0, 40)) {
    if (!isObj(raw)) continue
    const questionId = strOr(raw.questionId ?? raw.id, '', 80)
    if (!questionId) continue
    let value: FollowUpAnswer['value']
    const rv = raw.value
    if (typeof rv === 'boolean' || typeof rv === 'number') value = rv
    else if (Array.isArray(rv)) value = strArr(rv, 20, 120)
    else value = strOr(rv, '', 300)
    out.push({ questionId, value })
  }
  return out
}

export type NormalizeConfirmationCtx = {
  now: string                       // ISO timestamp (Date.now unavailable in some contexts)
  confirmationVersion: number       // 1-indexed, monotonic per booking
  submittedBy?: 'customer' | 'owner'
  status?: ConfirmationStatus
}

/** Turn raw client/owner input into a well-formed CustomerConfirmation. Never throws. */
export function normalizeConfirmation(raw: unknown, ctx: NormalizeConfirmationCtx): CustomerConfirmation {
  const root = isObj(raw) ? raw : {}
  const itemsRaw = Array.isArray(root.items) ? root.items : []
  const items = itemsRaw
    .slice(0, MAX_CONFIRMED_ITEMS)
    .map((it, i) => normalizeItem(it, i))
    .filter((x): x is ConfirmedItem => x !== null)

  return {
    schemaVersion: CONFIRMATION_SCHEMA_VERSION,
    confirmationVersion: Math.max(1, Math.round(ctx.confirmationVersion || 1)),
    status: ctx.status ?? 'submitted',
    submittedAt: ctx.now,
    submittedBy: ctx.submittedBy ?? 'customer',
    items,
    accessConditions: normalizeAccess(root.accessConditions),
    disclosures: normalizeDisclosures(root.disclosures),
    photoQuality: {
      hasWideShot: boolOpt(isObj(root.photoQuality) ? root.photoQuality.hasWideShot : undefined),
      allItemsPictured: boolOpt(isObj(root.photoQuality) ? root.photoQuality.allItemsPictured : undefined),
      accessPhotosIncluded: boolOpt(isObj(root.photoQuality) ? root.photoQuality.accessPhotosIncluded : undefined),
      note: strOpt(isObj(root.photoQuality) ? root.photoQuality.note : undefined, 200),
    },
    followUpAnswers: normalizeFollowUps(root.followUpAnswers),
    attestation: normalizeAttestation(root.attestation, ctx.now),
    conflicts: [],                  // computed server-side (photo-text-consistency), never client-trusted
    notes: strOpt(root.notes, 500),
    idempotencyKey: strOpt(root.idempotencyKey, 120),
  }
}

// ── Derived read-outs (pure) — used by pricing merge + OpsPilot display ──────

/** The items that will actually be priced (removed rows excluded). */
export function activeItems(c: CustomerConfirmation): ConfirmedItem[] {
  return c.items.filter(i => !i.removed)
}

/** Items the customer ADDED that the AI never detected. */
export function customerAddedItems(c: CustomerConfirmation): ConfirmedItem[] {
  return c.items.filter(i => !i.removed && !i.aiDetected)
}

/** AI detections the customer REMOVED as false positives. */
export function removedDetections(c: CustomerConfirmation): ConfirmedItem[] {
  return c.items.filter(i => i.removed && i.aiDetected)
}

/** True when the customer disclosed anything that must force a human/governed review. */
export function hasHardDisclosure(c: CustomerConfirmation): boolean {
  const d = c.disclosures
  return !!(d.containsHazardous || d.hiddenItems)
}

/** True when the attestation is complete enough to run the final analysis. */
export function attestationComplete(c: CustomerConfirmation): boolean {
  const a = c.attestation
  return !!a && a.representsEverything && a.hazardousDisclosed && a.accessDisclosed
}
