// ─────────────────────────────────────────────────────────────────────────────
// Deterministic MOVING pricing — the relocation counterpart to disposal.priceJob.
//
// A move is priced on TIME and PEOPLE: crew size × hours × rate, plus travel, plus
// the handling surcharges that make a specific job slower than its cubic feet
// suggest (stairs, long carry, disassembly, appliances, oversized items).
//
// There is no landfill trip, no dump fee, no debris category and no disposal
// minimum anywhere in this file, and there must never be. Those belong to the
// junk lane; importing them here is the exact defect this module exists to end.
//
// The model NEVER sets the price. It supplies inventory, volume, crew and hour
// RANGES; this engine turns them into money using tenant-configured rates.
// ─────────────────────────────────────────────────────────────────────────────

import { redis } from '../redis'
import type { MovingPhotoAnalysis } from '../ai/analysis-schema-moving'

export type MovingSettings = {
  crewRatePerHourCents: number      // per mover, per hour — the spine of the price
  minimumHours: number              // billed floor: nobody rolls a truck for 30 minutes
  minimumChargeCents: number        // absolute floor, whatever the hours say
  truckFeeCents: number             // truck + fuel for the job itself
  travelPerMileCents: number        // origin → destination
  baseTravelMinutes: number         // depot → origin → depot, billed as time
  // Handling surcharges — each one is TIME the photos can justify.
  stairsPerFlightCents: number
  elevatorCents: number
  longCarryCents: number
  disassemblyPerItemCents: number
  applianceHandlingCents: number
  oversizedItemCents: number
  fragilePackingCents: number
  packingServiceCents: number       // only when the customer selected packing
  marginPct: number                 // 0–0.9
}

export const DEFAULT_MOVING: MovingSettings = {
  crewRatePerHourCents: 6500,       // $65/mover/hr — DFW two-person crew ≈ $130/hr
  minimumHours: 2,
  minimumChargeCents: 26000,        // $260 = 2 movers × 2 hrs
  truckFeeCents: 7500,
  travelPerMileCents: 350,
  baseTravelMinutes: 45,
  stairsPerFlightCents: 4000,
  elevatorCents: 6000,
  longCarryCents: 5000,
  disassemblyPerItemCents: 3500,
  applianceHandlingCents: 6000,
  oversizedItemCents: 15000,
  fragilePackingCents: 4500,
  packingServiceCents: 0,
  marginPct: 0.35,
}

/** Tenant-owned: `cfg:` is not on the platform-global allowlist, so every read and
 * write is scoped to the ambient tenant by the Redis chokepoint. */
export const MOVING_SETTINGS_KEY = 'cfg:moving'
const KEY = MOVING_SETTINGS_KEY

/**
 * Merge a stored config over the defaults. Pure, so the merge semantics can be
 * tested without a store: absent key → defaults, unparseable → defaults, partial
 * → only the fields actually saved override.
 */
export function parseMovingSettings(raw: string | null): MovingSettings {
  if (!raw) return DEFAULT_MOVING
  try {
    const parsed = JSON.parse(raw) as Partial<MovingSettings>
    return { ...DEFAULT_MOVING, ...parsed }
  } catch { return DEFAULT_MOVING }
}

/**
 * Read this tenant's rate card.
 *
 * A read FAILURE is not the same as an unconfigured tenant and must not be
 * flattened into one. "No config saved" legitimately means the documented
 * defaults; "the store did not answer" means we do not know this tenant's rates,
 * and quoting a move on someone else's numbers is worse than not quoting it. The
 * error propagates, and buildMovingEstimate turns it into an unpriced job for a
 * human rather than a confident price built on a guess.
 */
export async function getMovingSettings(): Promise<MovingSettings> {
  return parseMovingSettings(await redis.get(KEY))
}

export async function saveMovingSettings(patch: Partial<MovingSettings>): Promise<MovingSettings> {
  const next = { ...(await getMovingSettings()), ...patch }
  await redis.set(KEY, JSON.stringify(next))
  return next
}

/**
 * Every configurable field, with its allowed bounds. Declared once so the
 * validator, the tests and any future admin UI cannot drift apart — a field added
 * to MovingSettings but forgotten here is simply not writable, which is the safe
 * direction to fail.
 */
export const MOVING_SETTING_BOUNDS: Record<keyof MovingSettings, { min: number; max: number; integer: boolean }> = {
  crewRatePerHourCents: { min: 0, max: 100_000, integer: true },
  minimumHours: { min: 0, max: 24, integer: false },
  minimumChargeCents: { min: 0, max: 10_000_000, integer: true },
  truckFeeCents: { min: 0, max: 1_000_000, integer: true },
  travelPerMileCents: { min: 0, max: 100_000, integer: true },
  baseTravelMinutes: { min: 0, max: 600, integer: true },
  stairsPerFlightCents: { min: 0, max: 1_000_000, integer: true },
  elevatorCents: { min: 0, max: 1_000_000, integer: true },
  longCarryCents: { min: 0, max: 1_000_000, integer: true },
  disassemblyPerItemCents: { min: 0, max: 1_000_000, integer: true },
  applianceHandlingCents: { min: 0, max: 1_000_000, integer: true },
  oversizedItemCents: { min: 0, max: 5_000_000, integer: true },
  fragilePackingCents: { min: 0, max: 1_000_000, integer: true },
  packingServiceCents: { min: 0, max: 5_000_000, integer: true },
  marginPct: { min: 0, max: 0.9, integer: false },
}

export const MOVING_SETTING_KEYS = Object.keys(MOVING_SETTING_BOUNDS) as (keyof MovingSettings)[]

/**
 * Validate an untrusted settings patch.
 *
 * REJECTS rather than clamps. A negative rate silently clamped to 0 would quote
 * every move at the minimum charge and look like a pricing bug for weeks; a
 * rejected request tells the admin immediately that the value never took. Fields
 * not present are left alone — the caller merges over the stored config, which in
 * turn merges over the defaults, so an unset field keeps its default.
 */
export function sanitizeMovingSettingsPatch(body: unknown): { patch: Partial<MovingSettings>; rejected: string[] } {
  const patch: Partial<MovingSettings> = {}
  const rejected: string[] = []
  if (!body || typeof body !== 'object') return { patch, rejected: ['body must be an object'] }
  const o = body as Record<string, unknown>

  for (const key of MOVING_SETTING_KEYS) {
    if (o[key] === undefined) continue          // absent ≠ zero: leave it alone
    const b = MOVING_SETTING_BOUNDS[key]
    const raw = o[key]
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (!Number.isFinite(n)) { rejected.push(`${key}: not a number`); continue }
    if (n < b.min) { rejected.push(`${key}: ${n} is below the minimum ${b.min}`); continue }
    if (n > b.max) { rejected.push(`${key}: ${n} is above the maximum ${b.max}`); continue }
    ;(patch as Record<string, number>)[key] = b.integer ? Math.round(n) : n
  }
  // Unknown keys are ignored rather than rejected: a client sending an extra field
  // should not be able to make a valid settings write fail.
  return { patch, rejected }
}

/** Non-visual job facts. A photo cannot supply any of these. */
export type MovingJobFacts = {
  travelMiles?: number
  originStairsFlights?: number
  destinationStairsFlights?: number
  elevatorRequired?: boolean
  packingRequested?: boolean
  destinationKnown?: boolean
}

export type MovingCostLine = { label: string; cents: number }

export type MovingQuote = {
  low: number
  high: number
  recommendedUsd: number
  crewSize: number
  laborHours: { minimum: number; likely: number; maximum: number }
  truckSpaceFraction: number
  costBasisCents: number
  sellingPriceCents: number
  minimumApplied: boolean
  breakdown: MovingCostLine[]
  assumptions: string[]
}

const round5 = (n: number) => Math.round(n / 5) * 5
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * Price a move from the analysis + whatever non-visual facts the booking supplied.
 * Missing facts are NOT invented: travel defaults to the base depot allowance only,
 * and the caller decides (via `needs_information`) whether that is good enough to
 * show a customer.
 */
export function priceMove(opts: {
  settings: MovingSettings
  analysis: MovingPhotoAnalysis
  facts?: MovingJobFacts
}): MovingQuote {
  const s = opts.settings
  const a = opts.analysis
  const f = opts.facts ?? {}
  const lines: MovingCostLine[] = []
  const assumptions: string[] = []

  const crewSize = clamp(Math.round(a.recommendedCrewSize.likely || 2), 1, 8)

  // Labor hours = loading + unloading + travel time between the two, floored at the
  // configured minimum. Each of the three is a real, separately-observed quantity.
  const travelHours = (s.baseTravelMinutes / 60) + (f.travelMiles ? f.travelMiles / 35 : 0)
  const hoursAt = (k: 'minimum' | 'likely' | 'maximum') =>
    Math.max(s.minimumHours, a.estimatedLoadingHours[k] + a.estimatedUnloadingHours[k] + travelHours)
  const laborHours = { minimum: hoursAt('minimum'), likely: hoursAt('likely'), maximum: hoursAt('maximum') }

  const laborCents = Math.round(laborHours.likely * crewSize * s.crewRatePerHourCents)
  lines.push({ label: `Crew (${crewSize} movers × ${laborHours.likely.toFixed(1)} hrs)`, cents: laborCents })
  if (laborHours.likely <= s.minimumHours) assumptions.push(`Billed at the ${s.minimumHours}-hour minimum.`)

  lines.push({ label: 'Truck & fuel', cents: s.truckFeeCents })

  if (f.travelMiles && f.travelMiles > 0) {
    lines.push({ label: `Travel (${Math.round(f.travelMiles)} mi)`, cents: Math.round(f.travelMiles * s.travelPerMileCents) })
  } else {
    assumptions.push('Travel is the local base allowance — no destination distance was provided.')
  }

  const flights = (f.originStairsFlights ?? 0) + (f.destinationStairsFlights ?? 0)
  if (flights > 0) lines.push({ label: `Stairs (${flights} flight${flights > 1 ? 's' : ''})`, cents: flights * s.stairsPerFlightCents })
  else if (a.access.stairsVisible) {
    lines.push({ label: 'Stairs (1 flight, seen in photos)', cents: s.stairsPerFlightCents })
    assumptions.push('Stairs were visible in the photos; flight count was not confirmed.')
  }

  if (f.elevatorRequired || a.access.elevatorVisible) lines.push({ label: 'Elevator handling', cents: s.elevatorCents })
  if (a.access.longCarryLikely) lines.push({ label: 'Long carry', cents: s.longCarryCents })

  const disassembly = a.normalizedItems.filter(i => i.requiresDisassembly).length
  if (disassembly > 0) lines.push({ label: `Disassembly / reassembly (${disassembly} item${disassembly > 1 ? 's' : ''})`, cents: disassembly * s.disassemblyPerItemCents })

  const appliances = a.normalizedItems.filter(i => i.isAppliance).length
  if (appliances > 0) lines.push({ label: `Appliance handling (${appliances})`, cents: appliances * s.applianceHandlingCents })

  const oversized = a.normalizedItems.filter(i => i.sizeClass === 'oversized').length
  if (oversized > 0) lines.push({ label: `Oversized items (${oversized})`, cents: oversized * s.oversizedItemCents })

  if (a.access.fragileHandling) lines.push({ label: 'Fragile handling', cents: s.fragilePackingCents })
  if (f.packingRequested && s.packingServiceCents > 0) lines.push({ label: 'Packing service', cents: s.packingServiceCents })

  const costBasisCents = lines.reduce((t, l) => t + l.cents, 0)
  const withMargin = Math.round(costBasisCents / (1 - clamp(s.marginPct, 0, 0.9)))
  const minimumApplied = withMargin < s.minimumChargeCents
  const sellingPriceCents = Math.max(withMargin, s.minimumChargeCents)

  // The customer range tracks the labor uncertainty the model actually reported,
  // not an arbitrary ± percentage.
  const hourSpread = laborHours.likely > 0 ? laborHours.maximum / laborHours.likely : 1
  const low = round5(sellingPriceCents / 100)
  const high = round5((sellingPriceCents / 100) * clamp(hourSpread, 1.1, 1.6))

  return {
    low, high,
    recommendedUsd: round5((low + high) / 2),
    crewSize,
    laborHours,
    truckSpaceFraction: a.estimatedTruckSpaceFraction.likely,
    costBasisCents,
    sellingPriceCents,
    minimumApplied,
    breakdown: lines,
    assumptions,
  }
}
