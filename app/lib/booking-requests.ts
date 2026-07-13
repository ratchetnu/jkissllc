import { redis } from './redis'
import {
  generateToken, nextBookingNumber, saveBooking, sanitizePhotos, pushBookingEvent,
  type Booking, type ServiceType,
} from './bookings'
import { SERVICE_TYPES } from './bookings'
import { getDraftEstimate } from './ai/estimate-store'
import { onLeadPersisted } from './intake-workflow'
import { notifyOwnerNewSubmission } from './booking-notify'

// ─────────────────────────────────────────────────────────────────────────────
// Public "Book Now" quote requests → persisted OpsPilot bookings.
//
// Before this, the primary CTA on /quote (POST /api/quote) only emailed ops and
// stored nothing — website requests never appeared in the admin. This helper
// writes every public submission into the SAME booking store the admin already
// reads (`bk:index`), reusing the existing Booking model, so a request shows up
// immediately with its photos and the full admin action set (quote, message,
// schedule, assign, convert, decline).
//
// A quote request is an UNPRICED, UNPAID booking in the `quote_received` state
// with `source:'online'`. Ops reviews it, sends a firm quote, and moves it down
// the existing lifecycle. It is intentionally NOT given an invoice number or a
// deposit — those are assigned when ops prices the job.
// ─────────────────────────────────────────────────────────────────────────────

export type QuoteRequestInput = {
  name: string
  email?: string
  phone?: string
  company?: string
  serviceType: ServiceType          // must be a valid booking enum (svc.bookType)
  jobSiteAddress?: string           // single-site job address
  pickupAddress?: string
  dropoffAddress?: string
  description?: string              // human summary (size, access, notes…)
  photos: string[]                  // Vercel Blob URLs already uploaded
  jobUnits?: number                 // scheduling capacity weight (unitsForLoad)
  preferredDate?: string            // yyyy-mm-dd (customer preference, not booked)
  contactMethod?: string
  promoCode?: string
  estimateLow?: number              // dollars the customer was shown (if any)
  estimateHigh?: number
  leadSource?: string
  marketingSource?: string
  referralSource?: string
  idempotencyKey?: string
  analysisId?: string               // draft AI estimate to attach (from /api/quote/analyze)

  // Discrete wizard selections — stored as structured fields on the booking (see
  // Booking.bookNow) so the admin renders them as usable columns, not a notes blob.
  loadSize?: string
  loadSizeLabel?: string
  timing?: string
  addOnLabels?: string[]
}

const REQ_IDEM_TTL_MS = 24 * 60 * 60_000

const isoDate = (v?: string): string | undefined =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined

// Build the internal note ops sees first — what the customer picked + the range
// they were shown (so the firm quote lands in the same ballpark or explains why not).
function buildInternalNote(input: QuoteRequestInput): string {
  const parts = [
    'Website request via Book Now (/quote).',
    input.contactMethod ? `Preferred contact: ${input.contactMethod}.` : '',
    input.estimateHigh && input.estimateHigh > 0
      ? `Customer was shown $${(input.estimateLow ?? 0).toLocaleString()}–$${input.estimateHigh.toLocaleString()}.`
      : 'No instant estimate shown — priced by hand.',
    input.promoCode ? `Promo ${input.promoCode}.` : '',
    'Needs review → send a firm quote, then set the invoice + arrival window.',
  ]
  return parts.filter(Boolean).join(' ')
}

// Build the structured Book Now detail block from a public submission — a pure
// mapping (no I/O) so it can be unit-tested directly. Returns undefined only when
// there is nothing worth recording, keeping legacy records clean.
export function buildBookNowDetail(input: QuoteRequestInput): NonNullable<Booking['bookNow']> | undefined {
  const requestedDate = isoDate(input.preferredDate)
  const detail: NonNullable<Booking['bookNow']> = {
    loadSize: input.loadSize || undefined,
    loadSizeLabel: input.loadSizeLabel || undefined,
    timing: input.timing || undefined,
    addOns: input.addOnLabels?.length ? input.addOnLabels : undefined,
    contactMethod: input.contactMethod || undefined,
    requestedDate,
    shownEstimateLowCents: input.estimateLow && input.estimateLow > 0 ? Math.round(input.estimateLow * 100) : undefined,
    shownEstimateHighCents: input.estimateHigh && input.estimateHigh > 0 ? Math.round(input.estimateHigh * 100) : undefined,
  }
  return Object.values(detail).some(v => v !== undefined) ? detail : undefined
}

/**
 * Persist a public quote submission as a booking. Idempotent on `idempotencyKey`:
 * a retry with the same key returns the original booking instead of duplicating.
 * Returns null only if another in-flight request already claimed the key.
 */
export async function persistQuoteRequest(input: QuoteRequestInput): Promise<Booking | null> {
  const idem = input.idempotencyKey?.trim()

  // ── Idempotency: one booking per client key (mirrors /api/book) ──────────
  if (idem) {
    const existing = await redis.get(`bk:idem:${idem}`)
    if (existing && existing !== 'PENDING') {
      const raw = await redis.get(`bk:${existing}`)
      if (raw) { try { return JSON.parse(raw) as Booking } catch { /* fall through */ } }
    }
    const claimed = await redis.setNxPx(`bk:idem:${idem}`, 'PENDING', 30_000)
    if (!claimed) {
      // Someone else is mid-create with this key. Give the winner a beat, then
      // return their booking if it landed; otherwise signal "in progress".
      const after = await redis.get(`bk:idem:${idem}`)
      if (after && after !== 'PENDING') {
        const raw = await redis.get(`bk:${after}`)
        if (raw) { try { return JSON.parse(raw) as Booking } catch { /* ignore */ } }
      }
      return null
    }
  }

  const serviceType: ServiceType = SERVICE_TYPES.includes(input.serviceType) ? input.serviceType : 'other'
  const preferred = isoDate(input.preferredDate)
  const now = Date.now()

  const booking: Booking = {
    token: generateToken(),
    bookingNumber: await nextBookingNumber(),

    customerName: input.name,
    customerPhone: input.phone,
    customerEmail: input.email,

    serviceType,
    jobSiteAddress: input.jobSiteAddress,
    pickupAddress: input.pickupAddress,
    dropoffAddress: input.dropoffAddress,
    description: input.description,
    items: [],
    invoicePhotos: sanitizePhotos((input.photos || []).map((u) => ({ url: u }))),
    jobUnits: input.jobUnits,

    // Unpriced + unpaid until ops quotes it.
    invoiceAmountCents: 0,
    depositAmountCents: 0,
    amountPaidCents: 0,

    // Not scheduled — we keep the customer's preferred date as a hint only.
    availableDates: preferred ? [preferred] : [],
    availableWindows: [],

    customerNotes: input.contactMethod ? `Preferred contact: ${input.contactMethod}` : undefined,
    promoCode: input.promoCode,
    source: 'online',
    leadSource: input.leadSource,
    marketingSource: input.marketingSource,
    referralSource: input.referralSource,
    idempotencyKey: idem,

    // Structured Book Now selections (first-class, not a notes blob) — see Booking.bookNow.
    bookNow: buildBookNowDetail(input),

    status: 'quote_received',
    payments: [],
    events: [],
    internalNotes: buildInternalNote(input),

    createdAt: now,
    updatedAt: now,
  }

  // Attach the AI estimate (analysis + deterministic pricing + decision) if one was
  // produced during the flow. Loaded server-side from the draft store so we never
  // trust a client-sent price. Its disposal number backfills disposalEstimateCents.
  if (input.analysisId) {
    try {
      const draft = await getDraftEstimate(input.analysisId)
      if (draft) {
        draft.analysis.bookingId = booking.token
        booking.aiEstimate = draft
        booking.disposalEstimateCents = draft.pricing.breakdown.disposalCents
        pushBookingEvent(booking, {
          actor: 'system', action: 'booking.created',
          result: `ai:${draft.decision}`,
          meta: { model: draft.model, recommendedUsd: draft.pricing.recommendedUsd, confidence: draft.analysis.confidence.overall, reviewReasons: draft.reviewReasons.length },
        })
      }
    } catch (e) { console.error('[booking-requests] attach estimate', e) }
  }

  pushBookingEvent(booking, {
    actor: 'customer', action: 'booking.created', result: 'quote_request',
    meta: { source: 'online', photos: booking.invoicePhotos?.length ?? 0 },
  })

  await saveBooking(booking)

  // Governed intake: upsert Customer, project Lead, publish LeadCreated/QuoteRequested
  // (+ QuoteGenerated). Flag-gated + fail-soft — a no-op today, never blocks the save.
  await onLeadPersisted(booking)

  // Durable, ledgered owner notification for the new Book Now request (email + optional
  // SMS, recorded on the booking with provider id / status / error). This REPLACES the
  // old fire-and-forget /api/quote ops email so a delivery failure can never be silent.
  try { await notifyOwnerNewSubmission(booking) } catch (e) { console.error('[booking-requests] owner notify', e) }

  if (idem) {
    await redis.set(`bk:idem:${idem}`, booking.token)
    await redis.pexpire(`bk:idem:${idem}`, REQ_IDEM_TTL_MS)
  }

  return booking
}
