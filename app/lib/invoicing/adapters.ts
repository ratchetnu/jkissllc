// ── InvoiceLike adapters ─────────────────────────────────────────────────────
//
// Project each lane's native record onto the shared read-only InvoiceLike view
// (./shared). This is how "both lanes satisfy one contract" WITHOUT merging their
// entities: each keeps its own stored shape; these are one-way view mappers used
// by unified listing and the invoice.draft AI action. Neither adapter mutates or
// persists anything.

import { subtotalCents, balanceCents, type RouteInvoice } from '../route-invoices'
import type { InvoiceLike } from './shared'

// B2B contract lane (rt:inv:*, JK-RI-).
export function routeInvoiceToInvoiceLike(inv: RouteInvoice): InvoiceLike {
  return {
    invoiceNumber: inv.invoiceNumber,
    status: inv.status,
    subtotalCents: subtotalCents(inv),
    amountPaidCents: inv.amountPaidCents,
    balanceCents: balanceCents(inv),
    lines: inv.lines.map((l) => ({ description: l.description, amountCents: l.amountCents })),
    party: { name: inv.clientName || inv.businessName, email: inv.clientEmail },
  }
}

// B2C retail lane — the invoice embedded on a Booking (bk:*, JK-INV-). Structural
// (duck-typed) so it accepts the real Booking without dragging the whole bookings
// module in as a hard dependency, and so the booking's own recompute() stays the
// authoritative source for its balance. Booking line items carry no per-line
// amount, so lines map to zero-amount descriptors (the audited shape).
export function bookingToInvoiceLike(b: {
  invoiceNumber?: string
  status: string
  invoiceAmountCents: number
  discountCents?: number
  amountPaidCents: number
  customerName?: string
  customerEmail?: string
  items?: string[]
}): InvoiceLike {
  const subtotal = inv0(b.invoiceAmountCents)
  const discount = inv0(b.discountCents)
  const paid = inv0(b.amountPaidCents)
  return {
    invoiceNumber: b.invoiceNumber || '(unassigned)',
    status: b.status,
    subtotalCents: subtotal,
    amountPaidCents: paid,
    balanceCents: Math.max(0, subtotal - discount - paid),
    lines: (b.items ?? []).map((description) => ({ description, amountCents: 0 })),
    party: { name: b.customerName || 'Customer', email: b.customerEmail },
  }
}

const inv0 = (n: number | undefined): number => (Number.isFinite(n) ? (n as number) : 0)
