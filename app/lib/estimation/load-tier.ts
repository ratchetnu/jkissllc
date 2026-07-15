// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Pass C — LOAD TIERS.
//
// A governed catalog that maps a DETERMINISTIC truck-fill fraction (0 = empty,
// 1 = one full 24 ft box truck) into J KISS's named load buckets. This is the same
// vocabulary the owner uses on the phone ("about a quarter load", "half a truck",
// "more than one load") so the estimate speaks the shop's language.
//
// IMPORTANT: tiers are VOLUME buckets only. They carry NO price. Pricing stays with
// priceJob (lib/pricing/quote-decision.ts) — a tier merely LABELS the deterministic
// fill the engine already computed. Ordered, contiguous, and total: every fraction
// >= 0 lands in exactly one tier (the last tier absorbs everything above the cap).
//
// Pure + dependency-free — no I/O, no Date.now, no randomness. Configurable via
// loadTierFor(fraction, { tiers }) so ops can retune buckets without a deploy.
// ─────────────────────────────────────────────────────────────────────────────

export const LOAD_TIER_VERSION = 1

export type LoadTierKey =
  | 'minimum_pickup'
  | 'eighth'
  | 'quarter'
  | 'three_eighths'
  | 'half'
  | 'five_eighths'
  | 'three_quarter'
  | 'seven_eighths'
  | 'full'
  | 'more_than_one_load'
  | 'on_site_required'

export type LoadTier = {
  key: LoadTierKey
  label: string
  fractionLow: number   // inclusive lower bound (fraction of one box truck)
  fractionHigh: number   // exclusive upper bound (Infinity on the last tier)
}

// Buckets are centered on the fraction their name implies (1/8, 1/4, 3/8, …) with
// the boundary sitting halfway between adjacent centers, so a fill reads to the
// tier a human would call it. `more_than_one_load` covers a genuine second load;
// past `onSiteMaxLoads` the job is too large/ambiguous to auto-quote → on-site.
export const LOAD_TIERS: LoadTier[] = [
  { key: 'minimum_pickup',     label: 'Minimum pickup (a few items)', fractionLow: 0,       fractionHigh: 0.0625 },
  { key: 'eighth',             label: '1/8 load',                     fractionLow: 0.0625,  fractionHigh: 0.1875 },
  { key: 'quarter',            label: '1/4 load',                     fractionLow: 0.1875,  fractionHigh: 0.3125 },
  { key: 'three_eighths',      label: '3/8 load',                     fractionLow: 0.3125,  fractionHigh: 0.4375 },
  { key: 'half',               label: '1/2 load',                     fractionLow: 0.4375,  fractionHigh: 0.5625 },
  { key: 'five_eighths',       label: '5/8 load',                     fractionLow: 0.5625,  fractionHigh: 0.6875 },
  { key: 'three_quarter',      label: '3/4 load',                     fractionLow: 0.6875,  fractionHigh: 0.8125 },
  { key: 'seven_eighths',      label: '7/8 load',                     fractionLow: 0.8125,  fractionHigh: 0.9375 },
  { key: 'full',               label: 'Full load',                    fractionLow: 0.9375,  fractionHigh: 1.0625 },
  { key: 'more_than_one_load', label: 'More than one load',           fractionLow: 1.0625,  fractionHigh: 2.5 },
  { key: 'on_site_required',   label: 'On-site estimate required',    fractionLow: 2.5,     fractionHigh: Infinity },
]

export type LoadTierConfig = {
  tiers?: LoadTier[]
}

/**
 * Resolve a deterministic truck-fill fraction into its named load tier. Negative
 * or NaN fractions clamp to 0 (minimum pickup). Never throws.
 */
export function loadTierFor(truckFraction: number, config: LoadTierConfig = {}): LoadTier {
  const tiers = config.tiers && config.tiers.length ? config.tiers : LOAD_TIERS
  const f = Number.isFinite(truckFraction) && truckFraction > 0 ? truckFraction : 0
  for (const tier of tiers) {
    if (f >= tier.fractionLow && f < tier.fractionHigh) return tier
  }
  // Total by construction — but never throw: fall back to the last (largest) tier.
  return tiers[tiers.length - 1]
}
