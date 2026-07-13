import { redis } from './redis'

// ── Quote acceptance metrics (learning-loop input) ───────────────────────────
//
// Lightweight tenant-scoped counters (via the redis chokepoint) for the quote
// funnel's acceptance rate: how many AI-drafted quotes the customer ultimately
// accepts. Incremented fail-soft from the intake workflow; read for the pricing
// calibration insight. Keys are `learn:*` → namespaced per tenant when tenancy is on.

const GENERATED = 'learn:quotes:generated'
const ACCEPTED = 'learn:quotes:accepted'

export async function bumpQuoteGenerated(): Promise<void> {
  try { await redis.incr(GENERATED) } catch { /* fail-soft */ }
}

export async function bumpQuoteAccepted(): Promise<void> {
  try { await redis.incr(ACCEPTED) } catch { /* fail-soft */ }
}

export type AcceptanceStats = { generated: number; accepted: number; rate: number }

/** Pure ratio — separated so it can be unit-tested without Redis. */
export function acceptanceRate(generated: number, accepted: number): number {
  return generated > 0 ? Math.min(1, accepted / generated) : 0
}

export async function acceptanceStats(): Promise<AcceptanceStats> {
  const [g, a] = await Promise.all([redis.get(GENERATED), redis.get(ACCEPTED)])
  const generated = parseInt(g ?? '0', 10) || 0
  const accepted = parseInt(a ?? '0', 10) || 0
  return { generated, accepted, rate: acceptanceRate(generated, accepted) }
}
