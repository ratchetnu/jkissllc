import { redis } from './redis'

// Promo / discount codes. Stored in Redis; applied to a booking's invoice as a
// discountCents (see bookings.netInvoiceCents). Validation is always server-side.

export type PromoType = 'percent' | 'fixed'
export type PromoCode = {
  code: string                 // normalized uppercase
  type: PromoType
  value: number                // percent 1–100, or dollars for fixed
  active: boolean
  description?: string
  expiresAt?: number
  maxUses?: number
  uses: number
  minSubtotalCents?: number
  createdAt: number
  updatedAt: number
}

const KEY = (code: string) => `promo:${code}`
const INDEX = 'promo:index'

export function normalizeCode(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32)
}

export async function getPromo(code: string): Promise<PromoCode | null> {
  const c = normalizeCode(code)
  if (!c) return null
  const raw = await redis.get(KEY(c))
  if (!raw) return null
  try { return JSON.parse(raw) as PromoCode } catch { return null }
}

export async function savePromo(p: PromoCode): Promise<void> {
  p.updatedAt = Date.now()
  await redis.set(KEY(p.code), JSON.stringify(p))
  await redis.zadd(INDEX, p.createdAt, p.code)
}

export async function listPromos(limit = 200): Promise<PromoCode[]> {
  const codes = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!codes.length) return []
  const raws = await Promise.all(codes.map(c => redis.get(KEY(c))))
  return raws
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r as string) as PromoCode } catch { return null } })
    .filter((x): x is PromoCode => x !== null)
}

export async function deletePromo(code: string): Promise<void> {
  const c = normalizeCode(code)
  await redis.del(KEY(c))
  await redis.zrem(INDEX, c)
}

// Discount (in cents) a code yields on a subtotal, capped at the subtotal.
export function discountCentsFor(p: PromoCode, subtotalCents: number): number {
  const raw = p.type === 'percent'
    ? Math.round(subtotalCents * (p.value / 100))
    : Math.round(p.value * 100)
  return Math.max(0, Math.min(subtotalCents, raw))
}

export type PromoValidation =
  | { ok: true; promo: PromoCode; discountCents: number }
  | { ok: false; error: string }

// Issue (once) a 10%-off loyalty/referral code for a paid-in-full booking. The
// customer can use it on their next job or share it with a friend. Idempotent.
export async function ensureLoyaltyCode(token: string, bookingNumber: string, now: number): Promise<string> {
  const code = `THANKS-${token.slice(0, 5).toUpperCase()}`
  const existing = await getPromo(code)
  if (!existing) {
    await savePromo({
      code, type: 'percent', value: 10, active: true,
      description: `Loyalty / referral — ${bookingNumber}`,
      maxUses: 10, uses: 0, createdAt: now, updatedAt: now,
    })
  }
  return code
}

export function validatePromo(p: PromoCode | null, subtotalCents: number, now: number): PromoValidation {
  if (!p || !p.active) return { ok: false, error: 'That code isn’t valid.' }
  if (p.expiresAt && now > p.expiresAt) return { ok: false, error: 'That code has expired.' }
  if (p.maxUses && p.uses >= p.maxUses) return { ok: false, error: 'That code has reached its limit.' }
  if (p.minSubtotalCents && subtotalCents < p.minSubtotalCents) {
    return { ok: false, error: `A minimum invoice of $${Math.round(p.minSubtotalCents / 100)} is required for this code.` }
  }
  const discountCents = discountCentsFor(p, subtotalCents)
  if (discountCents <= 0) return { ok: false, error: 'That code has no effect on this invoice.' }
  return { ok: true, promo: p, discountCents }
}
