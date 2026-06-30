import { redis } from './redis'

// ── Disposal-fee intelligence ────────────────────────────────────────────────
// Admin-configurable disposal costs + a pricing model that protects margin on
// junk removal, brush, cleanouts, evictions, and debris jobs.
//
// CORE RULE: disposal is charged PER LANDFILL TRIP, not once per job. The truck
// pays a minimum disposal fee ($75 default) EVERY time it enters the landfill.
// A job that needs 3 dump trips owes 3 × $75 = $225 in disposal alone. The
// estimator therefore prices by TRUCK UTILIZATION:
//
//   truck fill %  →  truck loads  →  landfill trips  →  disposal cost
//
// and builds the minimum selling price from itemized costs (labor, travel, fuel,
// equipment, dump-trip labor + fuel, unload time) plus the desired margin. The
// quote is NEVER generated below that minimum. All values are admin-tunable.

export type DebrisCategory = 'general' | 'furniture' | 'construction-debris' | 'yard-waste' | 'appliance' | 'mattress' | 'eviction-cleanout'

export const DEBRIS_CATEGORIES: DebrisCategory[] = ['general', 'furniture', 'construction-debris', 'yard-waste', 'appliance', 'mattress', 'eviction-cleanout']

export type DisposalSettings = {
  serviceMinimumCents: number     // never quote a job below this
  defaultDisposalCents: number    // fallback disposal floor when category unknown
  marginPct: number               // required gross margin (0–0.9)

  // ── Per-trip disposal (the core of the model) ──────────────────────────────
  minDisposalFeePerTripCents: number  // $75 default — charged EVERY landfill trip
  truckCapacityCuFt: number           // 1,200 (24 ft box truck) — reference only

  // ── Itemized job costs (all admin-tunable) ─────────────────────────────────
  laborMinCents: number               // floor for on-site loading labor
  laborFullLoadCents: number          // on-site labor to load a full 24ft truck
  laborRatePerHourCents: number       // blended crew $/hr — drives time-based costs
  landfillRoundTripMinutes: number    // drive time to the landfill and back, per trip
  unloadMinutesPerTrip: number        // time to unload at the landfill, per trip
  dumpTripCents: number               // non-labor cost of a dump run (fuel/tolls), per trip
  equipmentOpPerLoadCents: number     // truck wear / operating cost, per load
  travelToJobCents: number            // default travel + fuel to reach the job site

  // ── Reference rates (shown to admin) ───────────────────────────────────────
  perTonCents: number
  perCubicYardCents: number
  perLoadCents: number

  // Weight-based disposal cost for a FULL load of each category. Acts as a floor
  // ABOVE the per-trip minimum when the debris is heavy (construction, etc.).
  category: Record<DebrisCategory, number>

  // Volume-inflation per category. Brush / mattresses / loose bulky waste do not
  // compact — they burn truck volume far faster than their "pile size" suggests,
  // so a visually "half-full" brush load actually consumes much more, pushing the
  // job into extra loads and extra landfill trips. >1 inflates fill, <1 deflates
  // (dense debris that compacts and is weight-limited, not volume-limited).
  bulkFactor: Record<DebrisCategory, number>

  facility: {
    name?: string; address?: string; notes?: string; openDays?: string
    boxTruckOk?: boolean
    acceptsBrush?: boolean; acceptsFurniture?: boolean; acceptsAppliances?: boolean
    acceptsDebris?: boolean; acceptsMattresses?: boolean
  }
  showDumpFee: boolean            // show disposal as a customer line item?
}

export const DEFAULT_DISPOSAL: DisposalSettings = {
  serviceMinimumCents: 9500,
  defaultDisposalCents: 7500,
  marginPct: 0.42,

  minDisposalFeePerTripCents: 7500,   // $75 minimum per landfill trip
  truckCapacityCuFt: 1200,

  laborMinCents: 6000,
  laborFullLoadCents: 24000,
  laborRatePerHourCents: 9000,        // ~$45/hr × 2-person crew
  landfillRoundTripMinutes: 45,
  unloadMinutesPerTrip: 25,
  dumpTripCents: 2000,                // fuel/tolls per dump run
  equipmentOpPerLoadCents: 3000,
  travelToJobCents: 2500,

  perTonCents: 6000,
  perCubicYardCents: 4000,
  perLoadCents: 12000,

  // Weight-based disposal floor for a full load, by type.
  category: {
    general: 12000, furniture: 10000, 'construction-debris': 22000,
    'yard-waste': 9000, appliance: 9000, mattress: 6000, 'eviction-cleanout': 18000,
  },
  // Compaction reality — calibrated from the brush job (see JOB CALIBRATION).
  bulkFactor: {
    general: 1.0, furniture: 1.15, 'construction-debris': 0.85,
    'yard-waste': 1.8, appliance: 1.1, mattress: 1.6, 'eviction-cleanout': 1.2,
  },
  facility: { boxTruckOk: true, acceptsBrush: true, acceptsFurniture: true, acceptsAppliances: true, acceptsDebris: true, acceptsMattresses: true },
  showDumpFee: false,
}

const KEY = 'cfg:disposal'

export async function getDisposalSettings(): Promise<DisposalSettings> {
  const raw = await redis.get(KEY)
  if (!raw) return DEFAULT_DISPOSAL
  try {
    const parsed = JSON.parse(raw) as Partial<DisposalSettings>
    return {
      ...DEFAULT_DISPOSAL, ...parsed,
      category: { ...DEFAULT_DISPOSAL.category, ...(parsed.category ?? {}) },
      bulkFactor: { ...DEFAULT_DISPOSAL.bulkFactor, ...(parsed.bulkFactor ?? {}) },
      facility: { ...DEFAULT_DISPOSAL.facility, ...(parsed.facility ?? {}) },
    }
  } catch { return DEFAULT_DISPOSAL }
}

export async function saveDisposalSettings(patch: Partial<DisposalSettings>): Promise<DisposalSettings> {
  const next = { ...(await getDisposalSettings()), ...patch }
  await redis.set(KEY, JSON.stringify(next))
  return next
}

// Load size → fraction of a full 24ft truck (raw visual estimate, before the
// category bulk factor accounts for poor compaction).
const LOAD_FACTORS: Record<string, number> = {
  'few-items': 0.12, quarter: 0.3, half: 0.55, 'three-quarter': 0.78, full: 1.0, multiple: 1.9,
}

export type Confidence = 'high' | 'medium' | 'low'

// A single line in the cost build-up, surfaced to ops so a human can sanity-check.
export type CostLine = { label: string; cents: number }

export type DisposalQuote = {
  low: number; high: number          // customer price range, whole USD
  sellingPriceCents: number          // computed minimum selling price (the floor)
  disposalCents: number              // internal disposal estimate (trips × min fee floor)
  laborCents: number                 // on-site + dump-trip labor combined
  costBasisCents: number             // sum of every itemized cost line
  profitLowCents: number             // low − cost basis
  // Utilization model:
  fillPct: number                    // estimated effective truck fill (after bulk factor), %
  truckLoads: number
  landfillTrips: number
  requiresReview: boolean            // true → quote as a RANGE / get a human to confirm
  breakdown: CostLine[]              // itemized minimum-selling-price build-up
  confidence: Confidence
  category: DebrisCategory
  assumptions: string[]
}

const round5 = (n: number) => Math.round(n / 5) * 5
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// Per-category multipliers learned from completed jobs (actual ÷ estimated). 1 = neutral.
export type CalibrationBias = { fillBias?: Partial<Record<DebrisCategory, number>> }

// Instant price for a job-based service (junk/eviction/brush/debris). Disposal is
// charged per landfill trip, every itemized cost is summed into a protected
// minimum selling price, and the customer-facing range sits on top of that floor.
export function priceJob(opts: {
  settings: DisposalSettings
  category: DebrisCategory
  loadSize?: string
  fillPctOverride?: number  // explicit effective fill fraction (e.g. from a photo read), pre-bulk
  photoAdjusted?: boolean   // a photo gave a clear read
  calibration?: CalibrationBias
}): DisposalQuote {
  const { settings: s, category } = opts
  const knownLoad = !!opts.loadSize && opts.loadSize in LOAD_FACTORS
  const baseFill = opts.fillPctOverride != null
    ? clamp(opts.fillPctOverride, 0.05, 5)
    : (knownLoad ? LOAD_FACTORS[opts.loadSize as string] : 0.5)

  // truck fill % → loads → landfill trips
  const bulk = s.bulkFactor[category] ?? 1
  const learn = clamp(opts.calibration?.fillBias?.[category] ?? 1, 0.4, 3)
  const effFill = clamp(baseFill * bulk * learn, 0.05, 6)            // effective utilization
  const truckLoads = Math.max(1, Math.ceil(effFill - 1e-9))          // a partial load still ties up the truck once
  const landfillTrips = truckLoads                                   // one dump trip per load by default

  // ── Disposal: minimum fee EVERY trip, raised to the weight-based floor when heavy.
  const tripMinimumsCents = landfillTrips * s.minDisposalFeePerTripCents
  const catFullLoad = s.category[category] ?? s.category.general
  const weightDisposalCents = Math.round(catFullLoad * effFill)
  const disposalCents = Math.max(tripMinimumsCents, weightDisposalCents, s.defaultDisposalCents)

  // ── On-site loading labor: scales with effective volume.
  const onSiteLaborCents = Math.max(s.laborMinCents, Math.round(s.laborFullLoadCents * effFill))

  // ── Dump-run costs. A partial single load (effFill < 1) doesn't warrant a full
  // dedicated landfill trip — in practice it's batched — so its dump-run labor,
  // fuel, and equipment wear are prorated by fill. Full and multi-load jobs pay
  // the full cost of every trip. (The $75 disposal MINIMUM still applies to each
  // trip regardless — a trip is a trip.)
  const partial = effFill < 1
  const dumpRunUnits = partial ? effFill : landfillTrips
  const equipUnits = partial ? effFill : truckLoads

  // ── Dump-trip labor: (drive + unload) time × crew rate, per trip.
  const dumpTripMinutes = s.landfillRoundTripMinutes + s.unloadMinutesPerTrip
  const dumpTripLaborCents = Math.round(dumpRunUnits * dumpTripMinutes * s.laborRatePerHourCents / 60)

  // ── Dump-trip non-labor (fuel/tolls), equipment wear, and travel to the job.
  const dumpTripFuelCents = Math.round(dumpRunUnits * s.dumpTripCents)
  const equipmentCents = Math.round(equipUnits * s.equipmentOpPerLoadCents)
  const travelCents = s.travelToJobCents

  const breakdown: CostLine[] = [
    { label: 'On-site labor', cents: onSiteLaborCents },
    { label: 'Travel to job', cents: travelCents },
    { label: 'Equipment operating', cents: equipmentCents },
    { label: `Disposal (${landfillTrips} trip${landfillTrips > 1 ? 's' : ''} × $${Math.round(s.minDisposalFeePerTripCents / 100)} min)`, cents: disposalCents },
    { label: 'Dump-trip labor (drive + unload)', cents: dumpTripLaborCents },
    { label: 'Dump-trip fuel', cents: dumpTripFuelCents },
  ]
  const costBasisCents = breakdown.reduce((sum, l) => sum + l.cents, 0)
  const laborCents = onSiteLaborCents + dumpTripLaborCents

  // ── Minimum selling price: cost basis grossed up for margin, floored at the
  // service minimum. The quote is NEVER generated below this.
  const marginPct = clamp(s.marginPct, 0, 0.9)
  const sellingPriceCents = Math.max(Math.round(costBasisCents / (1 - marginPct)), s.serviceMinimumCents)

  // ── Confidence + multi-load review logic.
  let confidence: Confidence = knownLoad ? 'medium' : 'low'
  if (opts.photoAdjusted && knownLoad) confidence = 'high'
  if (effFill > 1) confidence = confidence === 'high' ? 'medium' : 'low'   // multi-trip jobs are harder to call
  if (category === 'construction-debris' && !opts.photoAdjusted) confidence = confidence === 'high' ? 'medium' : 'low'

  // >80% fill → tighten checks; >100% (multi-load) or low confidence → human review / range.
  const requiresReview = confidence === 'low' || effFill > 1.1

  // Range sits on the protected floor. Widen the top when a human should confirm.
  const lowCents = Math.max(round5(sellingPriceCents / 100) * 100, s.serviceMinimumCents)
  const highMult = requiresReview ? 1.4 : 1.18
  const highCents = round5((sellingPriceCents * highMult) / 100) * 100

  const assumptions = [
    `Truck fill ~${Math.round(effFill * 100)}% (${category.replace(/-/g, ' ')}${bulk !== 1 ? `, ×${bulk} bulk` : ''})${learn !== 1 ? `, ×${learn.toFixed(2)} learned` : ''}`,
    `${truckLoads} load${truckLoads > 1 ? 's' : ''} → ${landfillTrips} landfill trip${landfillTrips > 1 ? 's' : ''}`,
    `Disposal: ~$${Math.round(disposalCents / 100)} (never below $${Math.round(s.minDisposalFeePerTripCents / 100)}/trip)`,
    `Labor: ~$${Math.round(laborCents / 100)} · Min sell: $${Math.round(sellingPriceCents / 100)} @ ${Math.round(marginPct * 100)}% margin`,
  ]
  if (requiresReview) assumptions.push('⚠ Low confidence / multi-trip — quote as a range and confirm on site.')

  return {
    low: Math.round(lowCents / 100), high: Math.round(highCents / 100),
    sellingPriceCents,
    disposalCents, laborCents, costBasisCents,
    profitLowCents: lowCents - costBasisCents,
    fillPct: Math.round(effFill * 100), truckLoads, landfillTrips, requiresReview,
    breakdown,
    confidence, category, assumptions,
  }
}

// Map a service type (+ optional debris hint) to a disposal category.
export function categoryFor(serviceType: string, debris?: string): DebrisCategory {
  if (debris && (DEBRIS_CATEGORIES as string[]).includes(debris)) return debris as DebrisCategory
  if (serviceType === 'eviction' || serviceType === 'estate-cleanout' || serviceType === 'garage-cleanout') return 'eviction-cleanout'
  return 'general'
}
