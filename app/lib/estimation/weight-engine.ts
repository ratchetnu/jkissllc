// ─────────────────────────────────────────────────────────────────────────────
// Deterministic WEIGHT engine (Phase 4).
//
// The AI never reports weight directly. We derive it from the governed inventory:
// each item's per-unit VOLUME (cu yd, from the taxonomy) × a governed DENSITY for
// its weight class. The density map is the single source of truth for lbs/cu yd,
// justified from real-world hauling data below, and is reused by inventory-extract
// so per-unit item weights and the aggregate always agree.
//
// Pure + deterministic — no I/O, no Date.now, no randomness.
// ─────────────────────────────────────────────────────────────────────────────

import type { WeightClass, TaxonomyEntry } from '../ai/inventory-taxonomy'
import { taxonomyEntry } from '../ai/inventory-taxonomy'
import type { InventoryItem, WeightEstimate, Band } from './types'

// Governed density by weight class, in POUNDS PER CUBIC YARD. Calibrated to junk-
// hauling reality (a loosely filled truck ≠ a dense one):
//   • light      ~50  — loose household trash, cardboard, clothing, electronics:
//                        mostly air, compresses, very low mass per cu yd.
//   • medium     ~150 — mixed furniture, bagged waste, yard debris: bulky but not
//                        dense; a couch fills volume long before it fills weight.
//   • heavy      ~350 — appliances, cabinets, exercise equipment, wet/packed loads:
//                        real mass, but still volume-dominated.
//   • very_heavy ~800 — safes, pianos, hot tubs, packed construction loads:
//                        weight starts to matter as much as volume.
const WEIGHT_CLASS_LBS_PER_CUBIC_YARD: Record<WeightClass, number> = {
  light: 50,
  medium: 150,
  heavy: 350,
  very_heavy: 800,
}

// Dense debris (concrete, brick, dirt, roofing) is weight-limited, NOT volume-
// limited: a half-full truck can be at max legal weight. Real concrete runs
// ~2,000–2,700 lbs/cu yd; we use a deliberately conservative 1,500 lbs/cu yd
// floor for any taxonomy entry flagged `denseDebris` so heavy loads are never
// under-weighted. This only ever RAISES density (safety-additive), never lowers it.
const DENSE_DEBRIS_LBS_PER_CUBIC_YARD = 1500

/** Governed density (lbs per cu yd) for one taxonomy entry. Dense debris floors up. */
export function densityForEntry(entry: TaxonomyEntry): number {
  const base = WEIGHT_CLASS_LBS_PER_CUBIC_YARD[entry.weightClass] ?? WEIGHT_CLASS_LBS_PER_CUBIC_YARD.medium
  return entry.denseDebris ? Math.max(base, DENSE_DEBRIS_LBS_PER_CUBIC_YARD) : base
}

export { WEIGHT_CLASS_LBS_PER_CUBIC_YARD, DENSE_DEBRIS_LBS_PER_CUBIC_YARD }

const round = (n: number) => Math.round(n)
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// A single item's expected weight (lbs) = count × per-unit volume × density.
function itemExpectedPounds(item: InventoryItem): number {
  const e = taxonomyEntry(item.taxonomyId)
  return item.count * e.perUnitVolumeCubicYards * densityForEntry(e)
}

export function estimateWeight(items: InventoryItem[]): WeightEstimate {
  let expected = 0
  let low = 0
  let high = 0
  const heavyItems: string[] = []
  let denseDebrisPresent = false

  for (const item of items) {
    const e = taxonomyEntry(item.taxonomyId)
    const lbs = itemExpectedPounds(item)
    // Wider band when the count/read is less certain. Weight also carries an
    // inherent density uncertainty (contents vary), so the floor width is 25%.
    const w = clamp(0.25 + (1 - (item.countConfidence ?? 0.5)) * 0.15, 0.25, 0.4)
    expected += lbs
    low += lbs * (1 - w)
    high += lbs * (1 + w)

    if (e.weightClass === 'heavy' || e.weightClass === 'very_heavy' || e.heavy) {
      if (!heavyItems.includes(item.itemName)) heavyItems.push(item.itemName)
    }
    if (e.denseDebris) denseDebrisPresent = true
  }

  const pounds: Band = { low: round(low), expected: round(expected), high: round(high) }
  return { pounds, heavyItems, denseDebrisPresent }
}
