// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — INVENTORY EXTRACTION.
//
// Turns the untrusted vision `JunkPhotoAnalysis` into a governed `InventoryItem[]`
// the deterministic engines can price. Responsibilities:
//   1. Map each detected `JunkCategory` → a governed `InventoryCategory` via a
//      reverse index built from the taxonomy's own `junkCategory` field (round-
//      trip), falling back to 'other'. A safety upgrade re-routes an item to a
//      hazardous/sensitive category when its LABEL reveals one the coarse junk
//      category hid (flags can only ADD restriction, never remove it).
//   2. Dedup across photos so the same physical pile seen in multiple images is
//      counted ONCE, while recording every sourceImageId it appeared in.
//   3. Stamp per-unit volume (taxonomy cu yd × 27 → cu ft) and per-unit weight
//      (taxonomy density × cu yd — reusing weight-engine's governed density map).
//
// Pure + fail-safe: never throws, no I/O, no Date.now, no randomness.
// ─────────────────────────────────────────────────────────────────────────────

import type { JunkCategory, DetectedJunkItem, JunkPhotoAnalysis } from '../ai/analysis-schema'
import {
  INVENTORY_TAXONOMY,
  INVENTORY_CATEGORIES,
  taxonomyEntry,
  classifyFreeText,
  type InventoryCategory,
} from '../ai/inventory-taxonomy'
import type { InventoryItem } from './types'
import { densityForEntry } from './weight-engine'

export type ExtractOpts = {
  imageIds?: string[] // stable ids aligned to analysis.photoObservations order (else photoUrl)
}

// ── Reverse index: JunkCategory → canonical InventoryCategory ─────────────────
// Built from the taxonomy's own `junkCategory` field. Several inventory categories
// share a junk category (e.g. household_junk → household_trash / garage_items /
// hazardous …); FIRST-in-declaration-order wins so the mapping is the canonical,
// deterministic one. Missing junk categories fall back to 'other' at call time.
const JUNK_TO_INVENTORY: Partial<Record<JunkCategory, InventoryCategory>> = (() => {
  const idx: Partial<Record<JunkCategory, InventoryCategory>> = {}
  for (const key of INVENTORY_CATEGORIES) {
    const jc = INVENTORY_TAXONOMY[key].junkCategory
    if (idx[jc] === undefined) idx[jc] = key
  }
  return idx
})()

// Map one detected item to a governed category, with a safety upgrade: if the
// item's free-text LABEL classifies to a hazardous/sensitive category that the
// coarse junk category missed (e.g. junk="household_junk", label="paint cans"),
// prefer the restricted category. This can only ADD review, never remove it.
export function categoryForItem(item: DetectedJunkItem): InventoryCategory {
  let cat: InventoryCategory = JUNK_TO_INVENTORY[item.category] ?? 'other'
  const base = taxonomyEntry(cat)
  if (!(base.hazardous || base.sensitive) && item.label) {
    const byLabel = classifyFreeText(item.label)
    const le = taxonomyEntry(byLabel)
    if (le.hazardous || le.sensitive) cat = byLabel
  }
  return cat
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
const round2 = (n: number): number => Math.round(n * 100) / 100
const posInt = (n: number): number => Math.max(1, Math.round(Number.isFinite(n) ? n : 1))

// Two counts describe the "same" physical set if they're equal, within ±1, or
// within a factor of 2 — the tolerance that lets a duplicate photo of one pile
// merge instead of double-counting.
function nearCount(a: number, b: number): boolean {
  if (a === b) return true
  if (Math.abs(a - b) <= 1) return true
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return hi > 0 && lo / hi >= 0.5
}

// Resolve the stable image id list, aligned to photoObservations order.
function imageIdsOf(analysis: JunkPhotoAnalysis, opts?: ExtractOpts): string[] {
  const obs = Array.isArray(analysis.photoObservations) ? analysis.photoObservations : []
  if (obs.length > 0) {
    return obs.map((p, i) => opts?.imageIds?.[i] ?? (p.photoUrl || `photo-${i}`))
  }
  return opts?.imageIds ? [...opts.imageIds] : []
}

function toInventoryItem(it: DetectedJunkItem, sourceImageIds: string[]): InventoryItem {
  const cat = categoryForItem(it)
  const e = taxonomyEntry(cat)
  const perUnitCuYd = e.perUnitVolumeCubicYards
  const conf = clamp01(it.confidence)
  return {
    taxonomyId: cat,
    category: cat,
    itemName: (it.label && it.label.trim()) || e.label,
    count: posInt(it.estimatedQuantity),
    countConfidence: conf,
    estimatedVolumeCubicFeet: round2(perUnitCuYd * 27),
    estimatedWeightPounds: Math.round(perUnitCuYd * densityForEntry(e)),
    material: undefined,
    condition: undefined,
    disassemblyRequired: !!it.requiresDisassembly || e.requiresDisassembly,
    hazardousOrRestricted: !!(e.hazardous || e.sensitive),
    donationCandidate: e.disposalClass === 'donation',
    recyclable: e.disposalClass === 'recycling',
    uncertaintyNotes: conf < 0.6 ? (it.evidence || 'Low-confidence identification') : undefined,
    sourceImageIds,
  }
}

// Which images a model-deduped master item was seen in: match by governed
// category + nearest count against each photo's visibleItems. If nothing matches
// (model gave no per-photo lists), attribute it to the whole job.
function sourceImagesFor(master: DetectedJunkItem, analysis: JunkPhotoAnalysis, imageIds: string[]): string[] {
  const obs = Array.isArray(analysis.photoObservations) ? analysis.photoObservations : []
  const cat = categoryForItem(master)
  const matched: string[] = []
  obs.forEach((p, i) => {
    const id = imageIds[i]
    if (!id) return
    const hit = (p.visibleItems ?? []).some(
      (vi) => categoryForItem(vi) === cat && nearCount(vi.estimatedQuantity, master.estimatedQuantity),
    )
    if (hit && !matched.includes(id)) matched.push(id)
  })
  if (matched.length > 0) return matched
  return imageIds.length > 0 ? [...imageIds] : []
}

// Reconcile per-photo lists into deduped groups when the model gave no master
// list. Within a governed category, an item whose count is "near" an existing
// group's is treated as the SAME physical set seen again: keep the fullest count,
// union the image ids, retain the higher-confidence read.
function reconcilePerPhoto(analysis: JunkPhotoAnalysis, imageIds: string[]): InventoryItem[] {
  const obs = Array.isArray(analysis.photoObservations) ? analysis.photoObservations : []
  type Group = { item: DetectedJunkItem; cat: InventoryCategory; images: string[] }
  const groups: Group[] = []

  obs.forEach((p, i) => {
    const id = imageIds[i] ?? `photo-${i}`
    for (const vi of p.visibleItems ?? []) {
      const cat = categoryForItem(vi)
      const g = groups.find((gr) => gr.cat === cat && nearCount(gr.item.estimatedQuantity, vi.estimatedQuantity))
      if (g) {
        if (vi.estimatedQuantity > g.item.estimatedQuantity) g.item = { ...g.item, estimatedQuantity: vi.estimatedQuantity }
        if (clamp01(vi.confidence) > clamp01(g.item.confidence)) {
          g.item = { ...g.item, confidence: vi.confidence, label: vi.label || g.item.label }
        }
        if (!g.images.includes(id)) g.images.push(id)
      } else {
        groups.push({ item: vi, cat, images: [id] })
      }
    }
  })

  return groups.map((g) => toInventoryItem(g.item, g.images))
}

// Main entry: prefer the model's reconciled master list; otherwise dedup the
// per-photo observations ourselves. Never throws.
export function extractInventory(analysis: JunkPhotoAnalysis, opts?: ExtractOpts): InventoryItem[] {
  if (!analysis || typeof analysis !== 'object') return []
  const imageIds = imageIdsOf(analysis, opts)
  const master = Array.isArray(analysis.normalizedItems) ? analysis.normalizedItems : []
  if (master.length > 0) {
    return master.map((it) => toInventoryItem(it, sourceImagesFor(it, analysis, imageIds)))
  }
  return reconcilePerPhoto(analysis, imageIds)
}
