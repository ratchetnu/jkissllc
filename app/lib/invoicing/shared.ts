// ── Shared invoice plumbing ──────────────────────────────────────────────────
//
// One home for the pieces the two invoice lanes had accidentally copied — the
// B2B route-invoice lane (lib/route-invoices.ts, keyspace rt:inv:*, series JK-RI-)
// and the B2C booking-invoice lane (lib/bookings.ts, keyspace bk:*, series
// JK-INV-). This unifies CODE ONLY: the two entities, keyspaces, counters, and
// historical numbers stay completely separate — each caller passes its own prefix
// and counter key. Nothing here reads or writes on its own except the trivial
// sequence INCR, and that is byte-identical to the two originals it replaces.

import { redis } from '../redis'

// An opaque, URL-safe token = 64 hex chars of CSPRNG entropy. Both lanes minted
// this identically; the shared guard validates the same shape.
export const INVOICE_TOKEN_RE = /^[a-f0-9]{16,}$/i

export function generateInvoiceToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
}

// Human-facing sequential id: `${prefix}${1000 + n}`. The prefix + counterKey are
// supplied by the caller so the two series never share a counter or collide.
export async function nextSequentialNumber(prefix: string, counterKey: string): Promise<string> {
  const n = await redis.incr(counterKey)
  return `${prefix}${1000 + n}`
}

// ── The shared InvoiceLike contract ──────────────────────────────────────────
// A minimal read-shape that BOTH a RouteInvoice and a booking's embedded invoice
// can be projected onto (see ./adapters). It is a view contract for unified
// listing / the invoice.draft AI action — NOT a stored entity. Each lane keeps
// its own record; this never merges them.
export type InvoiceParty = { name: string; email?: string }
export type InvoiceLikeLine = { description: string; amountCents: number }
export type InvoiceLike = {
  invoiceNumber: string
  status: string
  subtotalCents: number
  amountPaidCents: number
  balanceCents: number
  lines: InvoiceLikeLine[]
  party: InvoiceParty
}

// ── Payment-idempotency core (pure) ──────────────────────────────────────────
// The single decision both the Stripe webhook backstop and the success-URL return
// path use to mark a route invoice paid. Pure + duck-typed (no Redis, no Stripe
// SDK types) so it is fully unit-tested and cannot double-apply:
//   - a void or already-paid invoice → no-op (never re-credits amountPaidCents)
//   - the same session already recorded on the invoice → no-op
//   - a session that is not actually paid → no-op
// Otherwise it returns the exact fields to persist (amountPaid = full subtotal).
export function planInvoicePayment(
  inv: { status: string; subtotalCents: number; stripeSessionId?: string },
  session: { id: string; payment_status?: string | null },
  now: number,
): { amountPaidCents: number; status: 'paid'; paidAt: number; paidMethod: 'card'; stripeSessionId: string } | null {
  if (inv.status === 'void' || inv.status === 'paid') return null
  if (session.payment_status !== 'paid') return null
  if (inv.stripeSessionId && inv.stripeSessionId === session.id) return null
  return { amountPaidCents: inv.subtotalCents, status: 'paid', paidAt: now, paidMethod: 'card', stripeSessionId: session.id }
}
