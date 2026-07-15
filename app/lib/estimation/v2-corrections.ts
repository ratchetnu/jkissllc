// ─────────────────────────────────────────────────────────────────────────────
// V2 ADMIN CORRECTIONS (Phase 8) — the owner-only, deterministic corrections the
// admin panel applies to a stashed V2 shadow estimate (b.v2Shadow.estimate).
//
// The owner can correct an item's quantity, drop a mis-deduplicated object, retag
// the recommended load tier, add/remove a disposal surcharge, and override the final
// quote $ with a required reason. EVERY correction is PURE + DETERMINISTIC and REUSES
// the governed engine (volume-engine / weight-engine / complexity / load-tier) to
// recompute the affected numbers. The MODEL NEVER RE-PRICES: an item edit only re-runs
// the deterministic volume/weight/tier math; the dollar figure changes ONLY through the
// explicit owner surcharge/override actions — never from a fresh model call.
//
// Pure (no I/O, no Date.now/random — timestamps are passed in) so it is unit-testable
// and the route stays a thin, audited wrapper. Fail-soft: an unknown objectId / tier is
// reported back, never thrown, so a stray click can't corrupt the stash.
// ─────────────────────────────────────────────────────────────────────────────

import type { EstimationResultV2 } from './v2-bridge'
import type { InventoryItem, PricingAdjustment } from './types'
import { estimateVolume } from './volume-engine'
import { estimateWeight } from './weight-engine'
import { estimateComplexity, type EstimationIntake } from './complexity'
import { loadTierFor, LOAD_TIERS, type LoadTierKey } from './load-tier'

export const V2_CORRECTION_VERSION = 1

// Corrections are the owner's job — never a manager/crew action.
export function canCorrectV2(role?: string): boolean {
  return role === 'admin'
}

// Stable, index-based object id for an inventory row. The admin panel derives the
// SAME id from the same inventory order, so `{ objectId }` round-trips deterministically.
export function v2ObjectId(index: number): string {
  return `object_${String(index + 1).padStart(3, '0')}`
}

// Resolve an objectId back to an inventory index. Accepts the synthesized
// `object_00N` form (1-based) or a bare number; returns -1 when it doesn't resolve.
export function v2IndexOf(est: EstimationResultV2, objectId: string): number {
  const inv = est?.inventory ?? []
  const m = String(objectId ?? '').match(/(\d+)\s*$/)
  if (!m) return -1
  const oneBased = Number(m[1])
  const idx = oneBased - 1
  return idx >= 0 && idx < inv.length ? idx : -1
}

export function isLoadTierKey(k: unknown): k is LoadTierKey {
  return typeof k === 'string' && LOAD_TIERS.some((t) => t.key === k)
}

export type V2CorrectionResult = {
  ok: boolean
  estimate: EstimationResultV2
  summary: string                       // human audit line (goes into the booking event)
  meta: Record<string, unknown>         // structured audit payload
  error?: string
}

export type V2ShadowOverride = {
  overriddenUsd: number
  reason: string
  by: string
  at: string
}

const clone = <T,>(v: T): T => structuredClone(v)

// Rebuild the deterministic access intake from the stored complexity factors so a
// recompute keeps the same access penalties (stairs / carry / parking …) it had.
function intakeFromComplexity(est: EstimationResultV2): EstimationIntake {
  const f = (est.complexity?.accessFactors ?? []).join(' | ').toLowerCase()
  return {
    stairs: /stair/.test(f) || undefined,
    longCarry: /long carry/.test(f) || undefined,
    narrowAccess: /narrow/.test(f) || undefined,
    backyard: /backyard|rear/.test(f) || undefined,
    parkingDifficult: /parking/.test(f) || undefined,
    multipleAreas: /multiple areas/.test(f) || undefined,
    elevator: /elevator/.test(f) || undefined,
  }
}

// Re-run the governed engine over the (edited) inventory. Volume, weight, complexity,
// truck fraction, load tier and the restricted-item list all come from deterministic
// math — NOT from any model. Pricing is intentionally left to the owner surcharge /
// override actions, so an item edit can never let the model re-price.
function recomputeAggregates(base: EstimationResultV2, inventory: InventoryItem[]): EstimationResultV2 {
  const volume = estimateVolume(inventory)
  const weight = estimateWeight(inventory)
  const complexity = estimateComplexity(inventory, intakeFromComplexity(base))
  const loadTier = loadTierFor(volume.truckFraction.expected)
  return {
    ...base,
    inventory,
    volume,
    weight,
    complexity,
    restrictedItems: inventory.filter((i) => i.hazardousOrRestricted).map((i) => i.itemName),
    v2: {
      ...base.v2,
      truckFraction: volume.truckFraction,
      loadTier,
    },
  }
}

/** Correct one object's quantity → re-run the deterministic volume/weight/tier math. */
export function correctItemQuantity(est: EstimationResultV2, objectId: string, quantity: number): V2CorrectionResult {
  const idx = v2IndexOf(est, objectId)
  const qty = Math.max(0, Math.round(Number(quantity)))
  if (idx < 0) return { ok: false, estimate: est, summary: '', meta: {}, error: 'unknown objectId' }
  if (!Number.isFinite(qty)) return { ok: false, estimate: est, summary: '', meta: {}, error: 'invalid quantity' }

  const inventory = est.inventory.map((it) => ({ ...it }))
  const target = inventory[idx]
  const before = target.count
  // A confirmed owner count is authoritative → high count-confidence (tightens the band).
  target.count = qty
  target.countConfidence = 0.95

  const next = recomputeAggregates(est, inventory)
  return {
    ok: true,
    estimate: next,
    summary: `Corrected "${target.itemName}" qty ${before} → ${qty} · volume ${next.volume.cubicYards.expected} cu yd · ${next.v2.loadTier.label}`,
    meta: { objectId, itemName: target.itemName, before, after: qty, loadTier: next.v2.loadTier.key, cubicYards: next.volume.cubicYards.expected },
  }
}

/** Mark an object as a duplicate → drop it and recompute the deterministic aggregates. */
export function markDuplicate(est: EstimationResultV2, objectId: string): V2CorrectionResult {
  const idx = v2IndexOf(est, objectId)
  if (idx < 0) return { ok: false, estimate: est, summary: '', meta: {}, error: 'unknown objectId' }

  const removed = est.inventory[idx]
  const inventory = est.inventory.filter((_, i) => i !== idx).map((it) => ({ ...it }))
  const next = recomputeAggregates(est, inventory)
  return {
    ok: true,
    estimate: next,
    summary: `Removed duplicate "${removed.itemName}" · ${inventory.length} item(s) left · volume ${next.volume.cubicYards.expected} cu yd · ${next.v2.loadTier.label}`,
    meta: { objectId, itemName: removed.itemName, remaining: inventory.length, loadTier: next.v2.loadTier.key, cubicYards: next.volume.cubicYards.expected },
  }
}

/** Owner overrides the recommended load tier (routing/labeling only — no re-price). */
export function setLoadTier(est: EstimationResultV2, tierKey: string): V2CorrectionResult {
  if (!isLoadTierKey(tierKey)) return { ok: false, estimate: est, summary: '', meta: {}, error: 'unknown load tier' }
  const tier = LOAD_TIERS.find((t) => t.key === tierKey)!
  const before = est.v2.loadTier.key
  const next: EstimationResultV2 = { ...est, v2: { ...est.v2, loadTier: clone(tier) } }
  return {
    ok: true,
    estimate: next,
    summary: `Set load tier ${before} → ${tier.key} (${tier.label})`,
    meta: { before, after: tier.key, label: tier.label },
  }
}

/**
 * Add or remove a disposal surcharge line. Deterministic dollar math ONLY — the delta
 * is applied to the pricing explanation's recommended + range (both bounds), never by a
 * model. `cents` is the surcharge amount; `add:false` removes the first line matching
 * `label`. Fail-soft: removing a non-existent label is a no-op reported back.
 */
export function setSurcharge(est: EstimationResultV2, label: string, cents: number, add: boolean): V2CorrectionResult {
  const clean = String(label ?? '').trim().slice(0, 80)
  if (!clean) return { ok: false, estimate: est, summary: '', meta: {}, error: 'label required' }

  const pricing = { ...est.pricing, adjustments: [...est.pricing.adjustments], rangeCents: { ...est.pricing.rangeCents } }

  if (add) {
    const amount = Math.round(Number(cents))
    if (!Number.isFinite(amount) || amount === 0) return { ok: false, estimate: est, summary: '', meta: {}, error: 'invalid amount' }
    const line: PricingAdjustment = { label: clean, cents: amount, reason: 'Owner surcharge (V2 correction)' }
    pricing.adjustments.push(line)
    pricing.recommendedCents = Math.max(0, pricing.recommendedCents + amount)
    pricing.rangeCents = { low: Math.max(0, pricing.rangeCents.low + amount), high: Math.max(0, pricing.rangeCents.high + amount) }
    return {
      ok: true,
      estimate: { ...est, pricing },
      summary: `Added surcharge "${clean}" ${amount >= 0 ? '+' : ''}${(amount / 100).toFixed(2)} · recommended $${(pricing.recommendedCents / 100).toFixed(0)}`,
      meta: { label: clean, cents: amount, add: true, recommendedCents: pricing.recommendedCents },
    }
  }

  const removeIdx = pricing.adjustments.findIndex((a) => a.label === clean)
  if (removeIdx < 0) return { ok: false, estimate: est, summary: '', meta: {}, error: 'surcharge not found' }
  const [gone] = pricing.adjustments.splice(removeIdx, 1)
  pricing.recommendedCents = Math.max(0, pricing.recommendedCents - gone.cents)
  pricing.rangeCents = { low: Math.max(0, pricing.rangeCents.low - gone.cents), high: Math.max(0, pricing.rangeCents.high - gone.cents) }
  return {
    ok: true,
    estimate: { ...est, pricing },
    summary: `Removed surcharge "${clean}" (−${(gone.cents / 100).toFixed(2)}) · recommended $${(pricing.recommendedCents / 100).toFixed(0)}`,
    meta: { label: clean, cents: gone.cents, add: false, recommendedCents: pricing.recommendedCents },
  }
}

/**
 * Build the owner's final-quote override record (the deterministic quote the customer
 * would get). Requires a positive dollar figure and a reason — the model plays no part.
 * The route stores this on the v2Shadow wrapper and audits it.
 */
export function buildV2Override(overriddenUsd: number, reason: string, by: string, atIso: string): {
  ok: boolean; override?: V2ShadowOverride; summary: string; meta: Record<string, unknown>; error?: string
} {
  const usd = Math.round(Number(overriddenUsd))
  const why = String(reason ?? '').trim().slice(0, 500)
  if (!Number.isFinite(usd) || usd <= 0) return { ok: false, summary: '', meta: {}, error: 'Enter an override price.' }
  if (!why) return { ok: false, summary: '', meta: {}, error: 'A reason is required for an override.' }
  const override: V2ShadowOverride = { overriddenUsd: usd, reason: why, by, at: atIso }
  return {
    ok: true,
    override,
    summary: `V2 quote override → $${usd}: ${why}`,
    meta: { overriddenUsd: usd, reason: why, by },
  }
}
