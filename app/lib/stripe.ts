import Stripe from 'stripe'

// Single Stripe account shared with ClaimGuard (same company). Uses the same
// STRIPE_SECRET_KEY env var. Lazily constructed so the rest of the app still
// builds/runs when Stripe isn't configured (manual payments always work).
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_NOT_CONFIGURED')
  return new Stripe(key)
}

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY
}

// ── Processing-fee gross-up ──────────────────────────────────────────────────
// Card payments carry Stripe's fee. We gross up the charge so J Kiss nets the
// intended invoice amount: charge G where G - (G*pct + fixed) = net.
//   G = (net + fixed) / (1 - pct)
export function feeConfig(): { pct: number; fixedCents: number } {
  const pct = parseFloat(process.env.STRIPE_PERCENT_FEE ?? '0.029')
  const fixedCents = parseInt(process.env.STRIPE_FIXED_FEE_CENTS ?? '30', 10)
  return {
    pct: isFinite(pct) && pct >= 0 && pct < 1 ? pct : 0.029,
    fixedCents: isFinite(fixedCents) && fixedCents >= 0 ? fixedCents : 30,
  }
}

export type FeeBreakdown = { netCents: number; feeCents: number; totalCents: number }

export function grossUp(netCents: number): FeeBreakdown {
  const { pct, fixedCents } = feeConfig()
  const total = Math.round((netCents + fixedCents) / (1 - pct))
  return { netCents, feeCents: total - netCents, totalCents: total }
}
