// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — COMPLEXITY / OPERATIONS engine.
//
// Scores how hard the job is to execute from two signal families:
//   • item flags  — heavy / dense / hazardous / disassembly / special handling
//   • access      — stairs / elevator / long carry / narrow / backyard / parking /
//                   multiple areas (an optional structured intake; degrades to the
//                   analysis' detectedConditions when omitted).
// Produces a deterministic level, crew size, labor + load-time bands, recommended
// equipment / PPE, the access factors in play, and the weighted `factors` that
// explain the level. Pure — no I/O, no Date.now, no randomness.
// ─────────────────────────────────────────────────────────────────────────────

import { taxonomyEntry } from '../ai/inventory-taxonomy'
import type { InventoryItem, ComplexityEstimate, ComplexityLevel, Band } from './types'

// Structured access intake. Every field optional — absent = unknown = no penalty.
export type EstimationIntake = {
  stairs?: boolean
  flights?: number
  elevator?: boolean
  longCarry?: boolean
  narrowAccess?: boolean
  backyard?: boolean
  parkingDifficult?: boolean
  multipleAreas?: boolean
  indoorRemoval?: boolean
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const round1 = (n: number) => Math.round(n * 10) / 10

// Weighted contributors → total score → level. Weights are governed constants.
const W = {
  heavyItem: 1.5,        // per heavy/very_heavy item type, capped
  heavyItemCap: 3,
  denseDebris: 3,
  hazardous: 3,
  specialHandling: 2.5,
  disassembly: 1.5,
  multiLoad: 2,          // job exceeds one truck load
  stairs: 2,
  longCarry: 1.5,
  narrow: 1.5,
  backyard: 1,
  parking: 1,
  multipleAreas: 1.5,
  elevatorRelief: -0.5,  // an elevator mitigates a stairs/carry penalty
}

const LEVEL_LOW_MAX = 3
const LEVEL_MED_MAX = 6.5

const LEVEL_MULT: Record<ComplexityLevel, number> = { low: 1.0, medium: 1.25, high: 1.6 }

export function estimateComplexity(items: InventoryItem[], intake?: EstimationIntake): ComplexityEstimate {
  const factors: { label: string; weight: number }[] = []
  const push = (label: string, weight: number) => { if (weight !== 0) factors.push({ label, weight: round1(weight) }) }

  // ── Item-driven signals ────────────────────────────────────────────────────
  let anyHeavy = false
  let anyDense = false
  let anyHazardous = false
  let anyDisassembly = false
  let anySpecial = false
  let anyVeryHeavySpecialty = false
  let totalCuYd = 0
  let heavyTypes = 0

  for (const item of items) {
    const e = taxonomyEntry(item.taxonomyId)
    totalCuYd += item.count * e.perUnitVolumeCubicYards
    if (e.weightClass === 'heavy' || e.weightClass === 'very_heavy' || e.heavy) { anyHeavy = true; heavyTypes++ }
    if (e.denseDebris) anyDense = true
    if (e.hazardous) anyHazardous = true
    if (e.requiresDisassembly || item.disassemblyRequired) anyDisassembly = true
    if (e.specialHandling) anySpecial = true
    if (e.specialHandling && e.weightClass === 'very_heavy') anyVeryHeavySpecialty = true
  }

  const multiLoad = totalCuYd > 44 // one box truck ≈ 44 cu yd

  if (anyHeavy) push('Heavy items to lift', Math.min(heavyTypes * W.heavyItem, W.heavyItemCap))
  if (anyDense) push('Dense debris (weight-limited load)', W.denseDebris)
  if (anyHazardous) push('Hazardous / restricted materials', W.hazardous)
  if (anySpecial) push('Special-handling item (piano/hot tub/safe)', W.specialHandling)
  if (anyDisassembly) push('Disassembly required', W.disassembly)
  if (multiLoad) push('Multiple truck loads', W.multiLoad)

  // ── Access-driven signals (from structured intake) ──────────────────────────
  const a = intake ?? {}
  const accessFactors: string[] = []
  if (a.stairs) { push('Stairs', W.stairs); accessFactors.push(a.flights && a.flights > 1 ? `Stairs (${a.flights} flights)` : 'Stairs') }
  if (a.longCarry) { push('Long carry', W.longCarry); accessFactors.push('Long carry from door to truck') }
  if (a.narrowAccess) { push('Narrow access', W.narrow); accessFactors.push('Narrow doorways / hallways') }
  if (a.backyard) { push('Backyard / rear access', W.backyard); accessFactors.push('Backyard or rear-of-property access') }
  if (a.parkingDifficult) { push('Difficult parking', W.parking); accessFactors.push('Difficult / distant truck parking') }
  if (a.multipleAreas) { push('Multiple areas / rooms', W.multipleAreas); accessFactors.push('Items spread across multiple areas') }
  if (a.elevator) { push('Elevator available (offsets stairs)', W.elevatorRelief); accessFactors.push('Elevator available') }

  const score = factors.reduce((s, f) => s + f.weight, 0)
  const level: ComplexityLevel = score <= LEVEL_LOW_MAX ? 'low' : score <= LEVEL_MED_MAX ? 'medium' : 'high'

  // ── Crew size (1–4) ─────────────────────────────────────────────────────────
  let crew = 2 // standard 2-person crew
  if (totalCuYd < 1 && !anyHeavy && !anySpecial) crew = 1
  if (anyVeryHeavySpecialty) crew = Math.max(crew, 3)
  if (totalCuYd > 30) crew += 1
  if (level === 'high') crew = Math.max(crew, 3)
  const recommendedCrewSize = clamp(crew, 1, 4)

  // ── Time estimates ──────────────────────────────────────────────────────────
  const mult = LEVEL_MULT[level]
  const loadMinutesExpected = (15 + totalCuYd * 5) * mult // 15 min setup + 5 min/cu yd, scaled by difficulty
  const loadMinutes: Band = {
    low: Math.round(loadMinutesExpected * 0.75),
    expected: Math.round(loadMinutesExpected),
    high: Math.round(loadMinutesExpected * 1.35),
  }
  // Person-hours = wall-clock load time × crew.
  const laborHours: Band = {
    low: round1((loadMinutes.low / 60) * recommendedCrewSize),
    expected: round1((loadMinutes.expected / 60) * recommendedCrewSize),
    high: round1((loadMinutes.high / 60) * recommendedCrewSize),
  }

  // ── Equipment + PPE ─────────────────────────────────────────────────────────
  const equipment = new Set<string>(['moving dolly'])
  const ppe = new Set<string>(['work gloves'])
  if (anyHeavy) { equipment.add('appliance dolly'); equipment.add('lifting straps'); ppe.add('steel-toe boots') }
  if (anyDisassembly) equipment.add('hand tools (disassembly)')
  if (anyDense) { equipment.add('shovels + contractor bags'); ppe.add('safety glasses'); ppe.add('N95 respirator') }
  if (anySpecial) equipment.add('furniture blankets + heavy-duty straps')
  if (anyHazardous) { ppe.add('chemical-resistant gloves'); ppe.add('safety glasses'); ppe.add('N95 respirator') }

  return {
    level,
    recommendedCrewSize,
    recommendedTruckType: multiLoad ? '24 ft box truck (multiple loads)' : totalCuYd > 12 ? '24 ft box truck' : 'Trailer or 15 ft box truck',
    laborHours,
    loadMinutes,
    recommendedEquipment: Array.from(equipment),
    ppeRequirements: Array.from(ppe),
    accessFactors,
    factors,
  }
}
