// ── Clarification questions (Phase 8) ────────────────────────────────────────
//
// Turn estimation UNCERTAINTY into a SMALL number (≤4) of SPECIFIC, high-value
// questions — never generic ones. Each question is generated ONLY when the estimation
// signals show a real gap (low confidence on a dimension, or a specific item/access
// uncertainty), and each carries a machine-readable `reason` explaining why it was
// asked. When the estimate is confident and unambiguous we return [] — we don't pester
// the customer.
//
// We REUSE the governed follow-up catalog (lib/ai/followup-questions) for the question
// wording wherever it already has a matching question, so clarifications stay single-
// sourced with the rest of the intake flow. Only where the catalog has no equivalent
// (e.g. "how many sections in the sectional?") do we author a specific question here.

import type { EstimationResult, ClarificationQuestion, InventoryItem } from './types'
import { QUESTION_CATALOG } from '../ai/followup-questions'

// Confidence thresholds below which a dimension is considered uncertain enough to ask.
const LOW = 0.6
const MED = 0.7
const MAX_QUESTIONS = 4

/** Pull the governed wording for a catalog question id (single-sourced with intake). */
function catalogPrompt(id: string): string | undefined {
  return QUESTION_CATALOG[id]?.prompt
}

const isAppliance = (i: InventoryItem) => i.category === 'appliance' || i.taxonomyId === 'appliance'
const nameMatches = (i: InventoryItem, re: RegExp) => re.test(i.itemName ?? '')

/**
 * Generate targeted clarification questions for an estimation result. Deterministic and
 * pure. Returns at most MAX_QUESTIONS, ordered by value, or [] when the estimate is
 * confident and carries no specific uncertainty.
 */
export function clarificationsFor(result: EstimationResult): ClarificationQuestion[] {
  const out: ClarificationQuestion[] = []
  const seen = new Set<string>()
  const push = (id: string, question: string | undefined, reason: string) => {
    if (!question || seen.has(id)) return
    seen.add(id)
    out.push({ id, question, reason })
  }

  const items = result.inventory ?? []
  const dimConf = result.confidenceByDimension?.inventory ?? 1
  const accessConf = result.confidenceByDimension?.access ?? 1

  // 1) Sectional / large-furniture ambiguity → "How many sections are in the sectional?"
  //    No catalog equivalent, so we author this specific question. Fires when a
  //    sofa/sectional/couch item is present AND its count or dimensions are uncertain.
  const sectional = items.find(i =>
    nameMatches(i, /sectional|sofa|couch|loveseat/i) &&
    ((i.dimensionConfidence != null && i.dimensionConfidence < MED) ||
     (i.countConfidence != null && i.countConfidence < MED) ||
     !!i.uncertaintyNotes),
  )
  if (sectional) {
    push(
      'sectional_sections',
      'How many separate sections make up the sectional (or is it a single sofa)?',
      `Furniture item "${sectional.itemName}" is ambiguous — piece count/size drives truck space and crew.`,
    )
  }

  // 2) Large pile + low count confidence → "Are there additional items behind the pile?"
  //    Reuse catalog `hidden_items` ("items hidden behind furniture or in piles").
  const bigUncertainPile = items.find(i => i.count >= 5 && i.countConfidence < LOW) ||
    items.find(i => i.countConfidence < LOW && !!i.uncertaintyNotes)
  if (bigUncertainPile || dimConf < LOW) {
    push(
      'hidden_items',
      catalogPrompt('hidden_items'),
      bigUncertainPile
        ? `Low count confidence on "${bigUncertainPile.itemName}" — items behind a pile are commonly missed.`
        : 'Overall inventory confidence is low — hidden items would change the estimate.',
    )
  }

  // 3) Appliance present + low dimension confidence → "Is the appliance disconnected?"
  //    Reuse catalog `appliances_connected`.
  const uncertainAppliance = items.find(i =>
    isAppliance(i) &&
    ((i.dimensionConfidence != null && i.dimensionConfidence < MED) || dimConf < MED),
  )
  if (uncertainAppliance) {
    push(
      'appliances_connected',
      catalogPrompt('appliances_connected'),
      `Appliance "${uncertainAppliance.itemName}" detected with uncertain access — connected units need disconnect time.`,
    )
  }

  // 4) Dense/heavy load without access info → "Are there stairs or is it ground-floor?"
  //    Reuse catalog `items_upstairs`. Fires when heavy/dense debris is present but we
  //    have no access factors recorded and access confidence is low.
  const heavyOrDense = result.weight?.denseDebrisPresent || (result.weight?.heavyItems?.length ?? 0) > 0
  const noAccessInfo = (result.complexity?.accessFactors?.length ?? 0) === 0
  if (heavyOrDense && noAccessInfo && accessConf < MED) {
    push(
      'items_upstairs',
      catalogPrompt('items_upstairs'),
      'Heavy/dense items with no access details — stairs vs. ground-floor changes crew size and labor.',
    )
  }

  return out.slice(0, MAX_QUESTIONS)
}
