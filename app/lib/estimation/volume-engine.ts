// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — VOLUME engine.
//
// Sums the governed per-unit volumes of the inventory into a cu-yd / cu-ft band,
// a fraction of one box truck (TRUCK_CUBIC_YARDS), and a truck-load count. Bands
// widen when the underlying item counts are less certain: a confident read gives
// ±20%, a fully uncertain one ±40%. Recommends a truck type from the load size.
//
// Pure + deterministic — no I/O, no Date.now, no randomness.
// ─────────────────────────────────────────────────────────────────────────────

import { taxonomyEntry, TRUCK_CUBIC_YARDS } from '../ai/inventory-taxonomy'
import type { InventoryItem, VolumeEstimate, Band } from './types'

const EPS = 1e-9
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const round2 = (n: number) => Math.round(n * 100) / 100

// Confidence → half-width of the band. Confident (1.0) → ±20%; unknown (0) → ±40%.
function widthFor(confidence: number): number {
  const c = Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0.5
  return clamp(0.2 + (1 - c) * 0.2, 0.2, 0.4)
}

// A partial load still ties up the truck for one whole run.
function loadsFor(cubicYards: number): number {
  if (cubicYards <= 0) return 0
  return Math.max(1, Math.ceil(cubicYards / TRUCK_CUBIC_YARDS - EPS))
}

function truckTypeFor(cubicYards: number): string {
  if (cubicYards <= 0) return 'None required'
  if (cubicYards <= 3) return 'Pickup truck or small trailer'
  if (cubicYards <= 12) return 'Trailer or 15 ft box truck'
  if (cubicYards <= TRUCK_CUBIC_YARDS) return '24 ft box truck'
  return '24 ft box truck (multiple loads)'
}

export function estimateVolume(items: InventoryItem[]): VolumeEstimate {
  let expected = 0
  let low = 0
  let high = 0

  for (const item of items) {
    const perUnit = taxonomyEntry(item.taxonomyId).perUnitVolumeCubicYards
    const vol = item.count * perUnit
    const w = widthFor(item.countConfidence)
    expected += vol
    low += vol * (1 - w)
    high += vol * (1 + w)
  }

  const cubicYards: Band = { low: round2(low), expected: round2(expected), high: round2(high) }
  const cubicFeet: Band = {
    low: round2(low * 27),
    expected: round2(expected * 27),
    high: round2(high * 27),
  }
  const truckFraction: Band = {
    low: round2(low / TRUCK_CUBIC_YARDS),
    expected: round2(expected / TRUCK_CUBIC_YARDS),
    high: round2(high / TRUCK_CUBIC_YARDS),
  }
  const truckLoads: Band = {
    low: loadsFor(low),
    expected: loadsFor(expected),
    high: loadsFor(high),
  }

  return {
    cubicFeet,
    cubicYards,
    truckFraction,
    truckLoads,
    recommendedTruckType: truckTypeFor(expected),
  }
}
