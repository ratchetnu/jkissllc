// ─────────────────────────────────────────────────────────────────────────────
// Shared, PURE UI logic for the guided customer inventory-confirmation experience.
//
// The /quote client stays thin: it renders, and delegates every decision to these
// dependency-free helpers so the same logic is unit-tested directly (no DOM):
//   • plain-language confidence (never a raw % alone)
//   • seeding editable confirmed-item rows from the AI detections
//   • assembling the raw confirmation payload the server normalizes
//   • mapping follow-up answers onto the confirmation's structured paths
//   • projecting a booking's FINAL state into customer-safe result copy
//
// No prices/costs/percentages are ever produced here for the customer to edit,
// and the final-state projection never leaks the internal pricing breakdown.
// ─────────────────────────────────────────────────────────────────────────────

import {
  taxonomyEntry, normalizeToInventoryCategory,
  type InventoryCategory,
} from './inventory-taxonomy'
import { ATTESTATION_VERSION, type Disposition } from './confirmation-schema'
import type { FollowUpQuestion } from './followup-questions'

// ── Confidence, in plain language (Part 5, 9) ────────────────────────────────
export type ConfidenceBucket = 'clear' | 'confirm' | 'partial' | 'review'

export function confidenceBucket(n: number): ConfidenceBucket {
  if (n >= 0.8) return 'clear'
  if (n >= 0.6) return 'confirm'
  if (n >= 0.4) return 'partial'
  return 'review'
}

export const CONFIDENCE_LABEL: Record<ConfidenceBucket, string> = {
  clear: 'Looks clear',
  confirm: 'Please confirm',
  partial: 'Partially hidden',
  review: 'Needs review',
}

export const CONFIDENCE_TONE: Record<ConfidenceBucket, string> = {
  clear: '#34d399',   // green
  confirm: '#fbbf24', // amber
  partial: '#fbbf24',
  review: '#f87171',  // red
}

/** A calm, customer-safe sentence explaining the overall read — never a bare score. */
export function confidenceExplanation(opts: {
  overall: number
  itemCount: number
  reviewReasons?: string[]
}): string {
  const { overall, itemCount } = opts
  if (itemCount === 0) return 'We couldn’t identify items from the photos yet — please add the items below so we can price the job.'
  const b = confidenceBucket(overall)
  if (b === 'clear') return 'We identified the major items clearly. Please confirm the list looks right.'
  if (b === 'confirm') return 'We spotted the main items. A couple may be partially hidden, so please confirm the list.'
  if (b === 'partial') return 'Several objects are partially hidden, so we need you to confirm the list and quantities.'
  return 'The photos show mixed items that may need a closer look — please confirm what’s included.'
}

// ── Editable confirmed-item rows (client draft) ──────────────────────────────
// The client mutates these; on submit they map straight into the Phase 1
// normalizer's expected item shape.
export type DetectedItemLite = {
  id?: string
  label: string
  quantity: number
  category?: string
  confidence?: number
  photoUrl?: string
}

export type DraftItem = {
  id: string
  category: InventoryCategory
  name: string
  quantity: number
  uncertain: boolean
  removed: boolean
  aiDetected: boolean
  aiCategory?: InventoryCategory
  aiName?: string
  aiQuantity?: number
  aiConfidence?: number
  sourcePhotoUrl?: string
  freeText?: string
  disposition?: Disposition       // estate/cleanout: keep / donate / recycle / sell / dispose
}

/** Seed editable rows from the AI's detected items (all aiDetected). */
export function seedDraftItems(items: DetectedItemLite[]): DraftItem[] {
  return items.map((it, i) => {
    const category = normalizeToInventoryCategory(it.category, it.label)
    return {
      id: it.id || `ai-${i}`,
      category,
      name: it.label,
      quantity: Math.max(1, Math.round(it.quantity || 1)),
      uncertain: false,
      removed: false,
      aiDetected: true,
      aiCategory: category,
      aiName: it.label,
      aiQuantity: Math.max(1, Math.round(it.quantity || 1)),
      aiConfidence: it.confidence,
      sourcePhotoUrl: it.photoUrl,
    }
  })
}

/** A fresh, customer-added row (aiDetected:false). Caller supplies a stable id. */
export function newDraftItem(category: InventoryCategory, id: string, name?: string): DraftItem {
  const entry = taxonomyEntry(category)
  return {
    id,
    category,
    name: name || entry.label,
    quantity: 1,
    uncertain: false,
    removed: false,
    aiDetected: false,
  }
}

// ── "Is this everything?" checkpoint (Part 7) ────────────────────────────────
export type IsEverythingAnswer = 'yes' | 'more_items' | 'another_area' | 'unsure'

export const IS_EVERYTHING_OPTIONS: { value: IsEverythingAnswer; label: string; hint: string }[] = [
  { value: 'yes', label: 'Yes, this is everything', hint: 'Everything to be removed is shown and listed.' },
  { value: 'more_items', label: 'There are more items not pictured', hint: 'We’ll ask you to add photos or list them.' },
  { value: 'another_area', label: 'There’s another room or area', hint: 'Add the area and a few more photos.' },
  { value: 'unsure', label: 'I’m not sure', hint: 'That’s okay — we’ll have someone review it.' },
]

// ── Follow-up answers → structured payload paths (Part 5, 8) ──────────────────
// A minimal, safe dotted-path setter (only the two known confirmation sub-objects).
type RawPayload = {
  items: DraftItem[]
  accessConditions: Record<string, unknown>
  disclosures: Record<string, unknown>
  photoQuality: Record<string, unknown>
  estate: Record<string, unknown>
  followUpAnswers: { questionId: string; value: unknown }[]
  attestation?: Record<string, unknown>
  notes?: string
  idempotencyKey?: string
}

export type FollowUpValue = string | number | boolean | string[]

/** Write one follow-up answer into the payload at its question `path`, or as a
 *  generic followUpAnswers[] entry when the question has no structured path. */
export function applyAnswer(payload: RawPayload, q: FollowUpQuestion, value: FollowUpValue): void {
  payload.followUpAnswers = payload.followUpAnswers.filter(a => a.questionId !== q.id)
  payload.followUpAnswers.push({ questionId: q.id, value })
  if (!q.path) return
  const [root, field] = q.path.split('.')
  if (root === 'accessConditions') payload.accessConditions[field] = value
  else if (root === 'disclosures') payload.disclosures[field] = value
  else if (root === 'photoQuality') payload.photoQuality[field] = value
  else if (root === 'estate') payload.estate[field] = value
}

// ── Assemble the raw confirmation payload the server will normalize ───────────
export function buildConfirmationPayload(input: {
  items: DraftItem[]
  answers: { question: FollowUpQuestion; value: FollowUpValue }[]
  isEverything: IsEverythingAnswer
  everythingPictured: boolean
  attestation: {
    representsEverything: boolean
    additionalMayChangePrice: boolean
    hazardousDisclosed: boolean
    accessDisclosed: boolean
    mayRequireOwnerReview: boolean
  }
  estate?: Record<string, unknown>
  notes?: string
  idempotencyKey?: string
}): RawPayload {
  const payload: RawPayload = {
    items: input.items,
    accessConditions: {},
    disclosures: {},
    photoQuality: { allItemsPictured: input.everythingPictured },
    estate: { ...(input.estate ?? {}) },
    followUpAnswers: [],
    attestation: { ...input.attestation, version: ATTESTATION_VERSION },
    notes: input.notes,
    idempotencyKey: input.idempotencyKey,
  }
  for (const a of input.answers) applyAnswer(payload, a.question, a.value)

  // The "is this everything?" checkpoint maps onto disclosures + attestation.
  payload.disclosures.everythingVisibleInPhotos = input.isEverything === 'yes'
  if (input.isEverything === 'more_items') payload.disclosures.additionalItemsNotPictured = true
  if (input.isEverything === 'unsure') payload.disclosures.hiddenItems = payload.disclosures.hiddenItems === true

  return payload
}

// ── Customer-safe FINAL state projection (Part 12, 13) ───────────────────────
// Reads a minimal booking shape so it never imports the heavy Booking type and
// never leaks internal pricing breakdown / cost basis.
export type MinimalBookingState = {
  finalAiEstimate?: {
    finalDecision: 'quote_ready' | 'awaiting_owner_approval' | 'manual_review' | 'site_visit_required'
    confirmationVersion: number
    pricing: { recommendedUsd: number; lowUsd: number; highUsd: number }
    missingInfo?: string[]
  }
  finalAiJob?: { status: string }
  confirmation?: { confirmationVersion: number }
}

export type CustomerFinalStage = 'processing' | 'quote_ready' | 'owner_review' | 'manual_review' | 'more_info' | 'failed' | 'site_visit'

export type CustomerFinalState = {
  stage: CustomerFinalStage
  headline: string
  message: string
  lowUsd?: number
  highUsd?: number
  moreInfo?: string[]
}

export function projectCustomerFinalState(b: MinimalBookingState): CustomerFinalState {
  const fe = b.finalAiEstimate
  const currentVersion = b.confirmation?.confirmationVersion
  const feMatches = fe && (currentVersion == null || fe.confirmationVersion === currentVersion)

  if (feMatches && fe) {
    if (fe.finalDecision === 'quote_ready') {
      return {
        stage: 'quote_ready',
        headline: 'Your estimate is ready',
        message: 'Based on your photos and confirmed details, here’s your estimate. We’ll confirm the firm price before your appointment.',
        lowUsd: fe.pricing.lowUsd,
        highUsd: fe.pricing.highUsd,
      }
    }
    if (fe.finalDecision === 'awaiting_owner_approval') {
      return {
        stage: 'owner_review',
        headline: 'We’re reviewing a few details',
        message: 'We received everything and are reviewing a few details. You’ll be notified when your quote is ready.',
      }
    }
    if (fe.finalDecision === 'site_visit_required') {
      return {
        stage: 'site_visit',
        headline: 'We’ll take a quick look in person',
        message: 'Because of the size and contents of this job, we’ll set up a short on-site visit to give you an accurate quote. A team member will reach out to schedule it.',
      }
    }
    // manual_review — NEVER surface the internal reviewer-voice `missingInfo`
    // strings to the customer (they read as ops notes about the customer). Ops
    // sees them on the booking; the customer gets calm, generic copy.
    return {
      stage: 'manual_review',
      headline: 'Request received',
      message: 'We received your request. A team member will review it before pricing.',
    }
  }

  if (b.finalAiJob?.status === 'failed') {
    return {
      stage: 'failed',
      headline: 'Request received',
      message: 'We received your request, but couldn’t complete the estimate automatically. A team member will review it and follow up.',
    }
  }
  if (b.finalAiJob?.status === 'manual_review') {
    return { stage: 'manual_review', headline: 'Request received', message: 'We received your request. A team member will review it before pricing.' }
  }

  return {
    stage: 'processing',
    headline: 'Finalizing your estimate',
    message: 'We’re combining your photos with the details you confirmed. This only takes a moment.',
  }
}
