// ── Dense-material evidence gate (PURE) ──────────────────────────────────────
//
// The vision model sets a single `concreteOrSoilPossible` flag that it over-reports for
// ordinary scenes (a shadow, a grey floor, a stone planter), which forced furniture /
// appliance / box / mattress jobs into a "dense debris — weight risk" manual review.
//
// A concrete/soil weight-risk review is only warranted when the INVENTORY actually contains
// a genuinely dense construction/demolition material. This requires that supporting evidence
// before the vague flag may trigger a review.

import type { DetectedJunkItem } from '../ai/analysis-schema'

// Structured categories that ARE genuinely weight-limited dense material.
const DENSE_CATEGORIES = new Set(['construction_debris', 'dense_material', 'safe_dense_object'])

// Item labels that name a genuinely dense construction/demolition material. Word-boundary
// matched. Deliberately excludes ordinary heavy items (appliances, safes-as-furniture,
// dressers) — "heavy" is a labor/surcharge concern, not a dump-weight/concrete concern.
const DENSE_LABEL_RE = /\b(concrete|cinder\s?blocks?|bricks?|masonry|mortar|stucco|rebar|soil|dirt|gravel|sand|tiles?|roofing|shingles?|rubble|pavers?|flagstone|demolition|drywall|sheetrock|asphalt)\b/i

/** True only when the inventory carries a genuinely dense construction/demolition material —
 *  the evidence required before the model's concreteOrSoil flag may force a weight-risk review.
 *  Ordinary furniture, appliances, boxes, mattresses, brush, and household junk never qualify. */
export function hasDenseMaterialEvidence(items: Pick<DetectedJunkItem, 'category' | 'label'>[]): boolean {
  return items.some((i) => DENSE_CATEGORIES.has(String(i.category)) || DENSE_LABEL_RE.test(i.label ?? ''))
}
