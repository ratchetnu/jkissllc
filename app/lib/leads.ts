import { redis } from './redis'
import type { Booking } from './bookings'

// ── Lead projection (read-model, NOT a parallel lifecycle) ───────────────────
//
// A thin, disposable view of a booking-as-lead, keyed by the booking token and
// rebuilt from the Booking aggregate + the customer id. The event stream is the
// source of truth; this exists only so a future "Leads" surface can list/filter
// without re-deriving from every booking. Safe to drop and rebuild.

export type LeadProjection = {
  token: string
  tenantId?: string
  customerId?: string
  name: string
  email?: string
  phone?: string
  serviceType: string
  source?: string
  status: string
  estimateLowCents?: number
  estimateHighCents?: number
  recommendedCents?: number
  aiDecision?: string
  createdAt: number
  updatedAt: number
}

const leadKey = (token: string) => `lead:${token}`
const usdToCents = (u?: number) => (typeof u === 'number' ? Math.round(u * 100) : undefined)

/** Pure mapping Booking → LeadProjection (unit-testable; no I/O). */
export function buildLeadProjection(booking: Booking, extra?: { customerId?: string; tenantId?: string }): LeadProjection {
  const est = booking.aiEstimate
  return {
    token: booking.token,
    tenantId: extra?.tenantId,
    customerId: extra?.customerId,
    name: booking.customerName,
    email: booking.customerEmail,
    phone: booking.customerPhone,
    serviceType: booking.serviceType,
    source: booking.source,
    status: booking.status,
    estimateLowCents: usdToCents(est?.pricing.lowUsd),
    estimateHighCents: usdToCents(est?.pricing.highUsd),
    recommendedCents: usdToCents(est?.pricing.recommendedUsd),
    aiDecision: est?.decision,
    createdAt: booking.createdAt,
    updatedAt: Date.now(),
  }
}

export async function projectLead(booking: Booking, extra?: { customerId?: string; tenantId?: string }): Promise<void> {
  await redis.set(leadKey(booking.token), JSON.stringify(buildLeadProjection(booking, extra)))
}

export async function getLead(token: string): Promise<LeadProjection | null> {
  const raw = await redis.get(leadKey(token))
  if (!raw) return null
  try { return JSON.parse(raw) as LeadProjection } catch { return null }
}
