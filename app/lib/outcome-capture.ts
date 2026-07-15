// ─────────────────────────────────────────────────────────────────────────────
// Learning-loop capture (Phase 12) — closes the disconnected completed-job loop.
//
// When a job is marked completed the Booking already carries everything needed to
// measure the AI's price accuracy: the AI's recommended price (aiEstimate.pricing),
// whether an admin overrode it (aiEstimate.override), the admin-quoted / final
// invoice total (invoiceAmountCents), and the model/version stamps. This pure
// helper extracts that AI-vs-quoted SNAPSHOT into a Partial<JobOutcome>.
//
// It deliberately does NOT fill the crew-measured actuals (actualFillPct, trips,
// disposal, labor, profit) — those are logged later by the admin outcome form.
// Recording an outcome with empty actuals would pollute the EWMA calibration bias,
// so we only capture the price/version snapshot here and let recordJobOutcome fold
// it in once a human confirms what actually happened.
// ─────────────────────────────────────────────────────────────────────────────

import type { JobOutcome } from './job-learning'
import { PRICING_DECISION_VERSION } from './pricing/quote-decision'
import { ANALYSIS_SCHEMA_VERSION } from './ai/analysis-schema'

// Minimal structural view of the fields we read — we cast the Booking to this so we
// don't couple to (or modify) the shared Booking types.
type CapturableBooking = {
  token?: string
  bookingNumber?: string
  invoiceAmountCents?: number
  completedAt?: number
  aiEstimate?: {
    pricing?: { recommendedUsd?: number }
    override?: unknown
  }
}

// Build the AI-vs-quoted snapshot from a completed Booking. Returns a
// Partial<JobOutcome>; the caller merges in the crew-measured actuals later.
export function buildOutcomeFromBooking(
  booking: unknown,
  extras: Partial<JobOutcome> = {},
): Partial<JobOutcome> {
  const b = (booking ?? {}) as CapturableBooking
  const recommendedUsd = b.aiEstimate?.pricing?.recommendedUsd ?? 0
  const aiRecommendedCents = Math.round(recommendedUsd * 100)
  const overridden = !!b.aiEstimate?.override
  const invoiceCents = typeof b.invoiceAmountCents === 'number' ? b.invoiceAmountCents : undefined

  const snapshot: Partial<JobOutcome> = {
    bookingId: b.token || b.bookingNumber,
    aiRecommendedCents,
    overridden,
    adminQuotedCents: invoiceCents,
    finalInvoiceCents: invoiceCents,
    pricingRuleVersion: PRICING_DECISION_VERSION,
    estimateVersion: ANALYSIS_SCHEMA_VERSION,
    completionTimestamp: typeof b.completedAt === 'number' ? b.completedAt : undefined,
  }
  // extras win (e.g. an explicit jobId / promptVersion / taxonomyVersion supplied by
  // the caller), but we never fabricate the crew actuals — they stay undefined here.
  return { ...snapshot, ...extras }
}
