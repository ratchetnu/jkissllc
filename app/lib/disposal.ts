import { redis } from './redis'

// ── Disposal-fee intelligence ────────────────────────────────────────────────
// Admin-configurable disposal costs + a pricing model that protects margin on
// junk removal, brush, cleanouts, evictions, and debris jobs. Pricing references
// typical U.S. junk-removal + transfer-station rates (load-based pricing; dump
// fees ~$40–120/ton; per-category disposal). All values are admin-tunable so the
// owner can dial them to their actual DFW facility costs.

export type DebrisCategory = 'general' | 'furniture' | 'construction-debris' | 'yard-waste' | 'appliance' | 'mattress' | 'eviction-cleanout'

export type DisposalSettings = {
  serviceMinimumCents: number     // never quote a job below this
  defaultDisposalCents: number    // fallback disposal floor when unknown
  dumpTripCents: number           // flat cost of the run to the facility
  laborMinCents: number
  laborFullLoadCents: number      // labor cost for a full 24ft-truck load
  marginPct: number               // required gross margin (0–0.9)
  perTonCents: number             // reference rates (shown to admin)
  perCubicYardCents: number
  perLoadCents: number
  // Disposal cost for a FULL load of each category:
  category: Record<DebrisCategory, number>
  facility: {
    name?: string; address?: string; notes?: string; openDays?: string
    boxTruckOk?: boolean
    acceptsBrush?: boolean; acceptsFurniture?: boolean; acceptsAppliances?: boolean
    acceptsDebris?: boolean; acceptsMattresses?: boolean
  }
  showDumpFee: boolean            // show disposal as a customer line item?
}

export const DEFAULT_DISPOSAL: DisposalSettings = {
  serviceMinimumCents: 12000,
  defaultDisposalCents: 5000,
  dumpTripCents: 3500,
  laborMinCents: 9000,
  laborFullLoadCents: 25000,
  marginPct: 0.45,
  perTonCents: 6000,
  perCubicYardCents: 4000,
  perLoadCents: 12000,
  category: {
    general: 12000, furniture: 10000, 'construction-debris': 20000,
    'yard-waste': 8000, appliance: 9000, mattress: 6000, 'eviction-cleanout': 18000,
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
    return { ...DEFAULT_DISPOSAL, ...parsed, category: { ...DEFAULT_DISPOSAL.category, ...(parsed.category ?? {}) }, facility: { ...DEFAULT_DISPOSAL.facility, ...(parsed.facility ?? {}) } }
  } catch { return DEFAULT_DISPOSAL }
}

export async function saveDisposalSettings(patch: Partial<DisposalSettings>): Promise<DisposalSettings> {
  const next = { ...(await getDisposalSettings()), ...patch }
  await redis.set(KEY, JSON.stringify(next))
  return next
}

// Load size → fraction of a full 24ft truck.
const LOAD_FACTORS: Record<string, number> = {
  'few-items': 0.12, quarter: 0.3, half: 0.55, 'three-quarter': 0.78, full: 1.0, multiple: 1.9,
}

export type Confidence = 'high' | 'medium' | 'low'

export type DisposalQuote = {
  low: number; high: number          // customer price range, whole USD
  disposalCents: number              // internal disposal estimate
  laborCents: number
  costBasisCents: number             // disposal + labor + dump trip
  profitLowCents: number             // low − cost basis
  confidence: Confidence
  category: DebrisCategory
  assumptions: string[]
}

const round5 = (n: number) => Math.round(n / 5) * 5

// Instant price for a job-based service (junk/eviction/brush/debris), with
// disposal cost folded in and margin + service-minimum floors protecting profit.
export function priceJob(opts: {
  settings: DisposalSettings
  category: DebrisCategory
  loadSize?: string
  photoAdjusted?: boolean   // a photo gave a clear read
}): DisposalQuote {
  const { settings: s, category } = opts
  const knownLoad = !!opts.loadSize && opts.loadSize in LOAD_FACTORS
  const loadFactor = knownLoad ? LOAD_FACTORS[opts.loadSize as string] : 0.5

  const catBase = s.category[category] ?? s.category.general
  const disposalCents = Math.max(s.defaultDisposalCents, Math.round(catBase * loadFactor))
  const laborCents = Math.max(s.laborMinCents, Math.round(s.laborFullLoadCents * loadFactor))
  const costBasisCents = disposalCents + laborCents + s.dumpTripCents

  const marginPct = Math.min(0.9, Math.max(0, s.marginPct))
  let point = Math.round(costBasisCents / (1 - marginPct))
  point = Math.max(point, s.serviceMinimumCents)

  const low = Math.max(round5(point * 0.90 / 100) * 100, s.serviceMinimumCents)
  const high = round5(point * 1.18 / 100) * 100

  // Confidence
  let confidence: Confidence = 'medium'
  if (opts.photoAdjusted && knownLoad) confidence = 'high'
  else if (knownLoad) confidence = 'medium'
  else confidence = 'low'
  if (category === 'construction-debris' && !opts.photoAdjusted) confidence = confidence === 'high' ? 'medium' : 'low'

  const assumptions = [
    `Disposal (${category.replace(/-/g, ' ')}, ${knownLoad ? opts.loadSize : 'est.'} load): ~$${Math.round(disposalCents / 100)}`,
    `Labor: ~$${Math.round(laborCents / 100)}`,
    `Dump run: $${Math.round(s.dumpTripCents / 100)}`,
    `Target margin: ${Math.round(marginPct * 100)}%`,
  ]

  return {
    low: Math.round(low / 100), high: Math.round(high / 100),
    disposalCents, laborCents, costBasisCents,
    profitLowCents: low - costBasisCents,
    confidence, category, assumptions,
  }
}

// Map a service type (+ optional debris hint) to a disposal category.
export function categoryFor(serviceType: string, debris?: string): DebrisCategory {
  if (debris && ['general', 'furniture', 'construction-debris', 'yard-waste', 'appliance', 'mattress', 'eviction-cleanout'].includes(debris)) return debris as DebrisCategory
  if (serviceType === 'eviction' || serviceType === 'estate-cleanout' || serviceType === 'garage-cleanout') return 'eviction-cleanout'
  return 'general'
}
