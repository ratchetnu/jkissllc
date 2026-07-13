// ─────────────────────────────────────────────────────────────────────────────
// Confidence-based workflow routing (Part 9). Turns the deterministic quote
// decision + the photo-text conflicts + the customer disclosures into ONE of three
// tiers and the workflow action that follows. Thresholds are configurable per
// tenant + service family (Part 9, Part 20).
//
//   HIGH   → instant quote / narrow range           (finalDecision: 'quote_ready')
//   MEDIUM → recommended estimate, owner approves    (finalDecision: 'awaiting_owner_approval')
//   LOW    → manual review, no fabricated estimate   (finalDecision: 'manual_review')
//
// Pure + dependency-free. The AI never sets a price and never sets the tier alone;
// the deterministic pricing decision + governed rules do.
// ─────────────────────────────────────────────────────────────────────────────

import type { QuoteDecisionResult } from './quote-decision'
import { hasMaterialConflict } from '../ai/photo-text-consistency'
import {
  activeItems, customerAddedItems, hasHardDisclosure, attestationComplete,
  type CustomerConfirmation, type ConflictFlag,
} from '../ai/confirmation-schema'

export type ConfidenceTier = 'high' | 'medium' | 'low'
export type FinalWorkflowDecision = 'quote_ready' | 'awaiting_owner_approval' | 'manual_review'

export type ConfidenceRoutingConfig = {
  autoQuoteMaxUsd: number            // above this, never auto-quote (→ approval)
  requireAttestationForAuto: boolean // high tier requires a complete attestation
  allowInstantQuote: boolean         // tenant/service kill-switch for instant quotes
  addedItemsForceApproval: boolean   // any customer-added item → at least approval
}

// Business defaults (mirror DEFAULT_QUOTE_THRESHOLDS.maxInstantQuoteUsd).
export const DEFAULT_ROUTING_CONFIG: ConfidenceRoutingConfig = {
  autoQuoteMaxUsd: 1200,
  requireAttestationForAuto: true,
  allowInstantQuote: true,
  addedItemsForceApproval: true,
}

// Per-service-family overrides — moving/delivery never auto-quote from photos.
export function routingConfigFor(serviceFamily: string, base: Partial<ConfidenceRoutingConfig> = {}): ConfidenceRoutingConfig {
  const cfg = { ...DEFAULT_ROUTING_CONFIG, ...base }
  if (serviceFamily === 'moving') return { ...cfg, allowInstantQuote: false }
  return cfg
}

export type RoutingResult = {
  tier: ConfidenceTier
  finalDecision: FinalWorkflowDecision
  reasons: string[]
}

/**
 * Decide the confidence tier + workflow action. Deterministic. Order matters:
 * any hard-review signal wins (low), else any approval signal (medium), else high.
 */
export function routeByConfidence(opts: {
  decision: QuoteDecisionResult
  conflicts: ConflictFlag[]
  confirmation: CustomerConfirmation
  config: ConfidenceRoutingConfig
}): RoutingResult {
  const { decision, conflicts, confirmation, config } = opts
  const reasons: string[] = []

  // ── LOW — hard routes to manual review (no fabricated estimate). ────────────
  const lowSignals: Array<[boolean, string]> = [
    [decision.decision === 'manual_review', 'Pricing decision requires human review.'],
    [hasMaterialConflict(conflicts), 'A material photo/inventory difference needs clarification.'],
    [hasHardDisclosure(confirmation), 'Hazardous or hidden items were disclosed.'],
    [activeItems(confirmation).length === 0, 'No items remain on the confirmed list.'],
  ]
  const low = lowSignals.filter(([hit]) => hit)
  if (low.length > 0) {
    return { tier: 'low', finalDecision: 'manual_review', reasons: low.map(([, r]) => r) }
  }

  // ── MEDIUM — an estimate exists but the owner approves before it sends. ─────
  const added = customerAddedItems(confirmation)
  const mediumSignals: Array<[boolean, string]> = [
    [decision.decision === 'estimate_range', 'Estimate is a range, not an instant quote.'],
    [conflicts.length > 0, 'Minor differences were flagged for confirmation.'],
    [config.addedItemsForceApproval && added.length > 0, 'The customer added items not seen in the photos.'],
    [decision.recommendedUsd > config.autoQuoteMaxUsd, 'Estimate is above the automatic-quote limit.'],
    [!config.allowInstantQuote, 'Instant quoting is off for this service.'],
    [config.requireAttestationForAuto && !attestationComplete(confirmation), 'Attestation is incomplete.'],
  ]
  const medium = mediumSignals.filter(([hit]) => hit)
  if (medium.length > 0) {
    return { tier: 'medium', finalDecision: 'awaiting_owner_approval', reasons: medium.map(([, r]) => r) }
  }

  // ── HIGH — clear, confirmed, agreeing, within caps → instant/narrow quote. ──
  reasons.push('Clear photos, confirmed inventory, and pricing agree within limits.')
  return { tier: 'high', finalDecision: 'quote_ready', reasons }
}
