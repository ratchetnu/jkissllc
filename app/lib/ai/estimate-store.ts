import { redis } from '../redis'
import type { JunkPhotoAnalysis } from './analysis-schema'
import type { MonitorReport } from './analysis-monitor'
import type { CriticVerdict } from './junk-critic'
import type { QuoteDecision, PricingBreakdown } from '../pricing/quote-decision'

// ─────────────────────────────────────────────────────────────────────────────
// Stored AI estimate — the auditable record that links a photo analysis to the
// deterministic pricing result and the quote decision. Two homes:
//   • DRAFT: `qa:{id}` with a 24h TTL — created by /api/quote/analyze BEFORE the
//     customer submits, so the browser never has to re-send the analysis (and we
//     never trust a client-sent price). On submit we load it by id and copy it
//     onto the booking permanently.
//   • BOOKING: `Booking.aiEstimate` (stripped from customerView) — the permanent,
//     admin-viewable record with the full breakdown + any admin override.
// ─────────────────────────────────────────────────────────────────────────────

export type StoredAiEstimate = {
  id: string
  createdAt: string
  status: 'completed' | 'review' | 'failed'
  decision: QuoteDecision
  provider: string
  model: string
  schemaVersion: number
  callId?: string
  latencyMs?: number
  inputPhotoUrls: string[]
  analysis: JunkPhotoAnalysis
  pricing: {
    recommendedUsd: number
    lowUsd: number
    highUsd: number
    breakdown: PricingBreakdown
  }
  reviewReasons: string[]
  // QA layers: the deterministic consistency monitor + the second-opinion AI
  // reviewer (both auditable, shown in OpsPilot).
  monitor?: MonitorReport
  critic?: CriticVerdict
  // Admin adjustment (Phase 11) — recorded, never silently overwriting the AI number.
  override?: { overriddenUsd: number; reason: string; by: string; at: string }
}

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000
const draftKey = (id: string) => `qa:${id}`

export async function saveDraftEstimate(e: StoredAiEstimate): Promise<void> {
  await redis.set(draftKey(e.id), JSON.stringify(e))
  await redis.pexpire(draftKey(e.id), DRAFT_TTL_MS)
}

export async function getDraftEstimate(id: string): Promise<StoredAiEstimate | null> {
  if (!id || !/^[a-z0-9-]{8,}$/i.test(id)) return null
  const raw = await redis.get(draftKey(id))
  if (!raw) return null
  try { return JSON.parse(raw) as StoredAiEstimate } catch { return null }
}

// A compact, customer-SAFE projection of the estimate: the price + range, a short
// item list, confidence, questions, and public assumptions — never the internal
// cost basis, margin, or disposal build-up.
export function customerEstimateView(e: StoredAiEstimate) {
  return {
    analysisId: e.id,
    decision: e.decision,
    recommendedUsd: e.pricing.recommendedUsd,
    lowUsd: e.pricing.lowUsd,
    highUsd: e.pricing.highUsd,
    photoCount: e.inputPhotoUrls.length,
    confidence: e.analysis.confidence.overall,
    items: e.analysis.normalizedItems.slice(0, 12).map(i => ({ label: i.label, quantity: i.estimatedQuantity })),
    estimatedTruckLoads: e.analysis.estimatedTruckLoads.likely,
    questions: e.analysis.additionalQuestions.slice(0, 6),
    reviewReasons: e.reviewReasons.slice(0, 6),
    // A short, non-sensitive assumptions line.
    note: e.decision === 'instant_quote'
      ? 'This estimate assumes the photos show all the material and normal access.'
      : e.decision === 'estimate_range'
        ? 'This is an estimated range — we’ll confirm the firm price after a quick review.'
        : 'Your request needs a quick human review before we can quote it.',
  }
}
