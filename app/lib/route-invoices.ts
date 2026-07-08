// Client billing — turn completed routes into an invoice to the contract client.
// payRate on a route is the CONTRACTOR's cost, not the client price, so invoice
// line amounts are seeded from it as a suggestion but are fully editable. Each
// billed route is stamped with invoiceId so it can't be double-billed; voiding or
// deleting the invoice frees its routes again.
import { redis } from './redis'
import { listRoutes, getRouteByToken, saveRoute } from './routes'
import { parsePayCents } from './route-pay'

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'void'

export type InvoiceLine = {
  routeToken?: string          // present for lines generated from a route
  routeNumber?: string
  routeDate?: string
  description: string
  amountCents: number
}

export type RouteInvoice = {
  token: string
  invoiceNumber: string        // JK-INV-1001
  businessName: string         // client this bills (matches route.businessName)
  clientName?: string          // display name / contact
  clientEmail?: string
  periodStart?: string
  periodEnd?: string
  lines: InvoiceLine[]
  notes?: string
  status: InvoiceStatus
  amountPaidCents: number
  paidAt?: number
  paidMethod?: 'card' | 'manual'
  stripeSessionId?: string
  sentAt?: number
  createdAt: number
  updatedAt: number
}

export function subtotalCents(inv: Pick<RouteInvoice, 'lines'>): number {
  return inv.lines.reduce((s, l) => s + (Number.isFinite(l.amountCents) ? l.amountCents : 0), 0)
}
export function balanceCents(inv: RouteInvoice): number {
  return Math.max(0, subtotalCents(inv) - inv.amountPaidCents)
}

const KEY = (t: string) => `rt:inv:${t}`
const KEY_NUM = (n: string) => `rt:inv:num:${n}`
const KEY_INDEX = 'rt:inv:index'
const KEY_COUNTER = 'rt:inv:counter'
const TOKEN_RE = /^[a-f0-9]{16,}$/i

export function generateToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
}
// `JK-RI-`, not `JK-INV-`. Booking invoices (lib/bookings.nextInvoiceNumber) mint
// `JK-INV-` off a DIFFERENT counter, so both used to hand out the same human-facing
// number to two unrelated records — a booking invoice JK-INV-1005 and a route
// invoice JK-INV-1005. Route invoices bill contract clients; they get their own
// prefix. Invoices already issued keep the number stored on the record, and lookups
// go through `rt:inv:num:{number}`, so historic JK-INV-#### route invoices still
// resolve.
//
// No Redis fallback here on purpose — see the note in lib/bookings.ts.
export async function nextInvoiceNumber(): Promise<string> {
  const n = await redis.incr(KEY_COUNTER)
  return `JK-RI-${1000 + n}`
}

export async function getInvoiceByToken(token: string): Promise<RouteInvoice | null> {
  if (!token || !TOKEN_RE.test(token)) return null
  const raw = await redis.get(KEY(token))
  if (!raw) return null
  try {
    const inv = JSON.parse(raw) as RouteInvoice
    inv.lines = Array.isArray(inv.lines) ? inv.lines : []
    return inv
  } catch { return null }
}
export async function saveInvoice(inv: RouteInvoice): Promise<void> {
  inv.updatedAt = Date.now()
  await redis.set(KEY(inv.token), JSON.stringify(inv))
  await redis.set(KEY_NUM(inv.invoiceNumber.toUpperCase()), inv.token)
  await redis.zadd(KEY_INDEX, inv.updatedAt, inv.token)
}
export async function listInvoices(limit = 500): Promise<RouteInvoice[]> {
  const tokens = await redis.zrevrange(KEY_INDEX, 0, limit - 1)
  if (!tokens.length) return []
  const raws = await Promise.all(tokens.map(t => redis.get(KEY(t))))
  return raws
    .map(r => { try { return r ? JSON.parse(r) as RouteInvoice : null } catch { return null } })
    .filter((i): i is RouteInvoice => i !== null)
    .map(i => { i.lines = Array.isArray(i.lines) ? i.lines : []; return i })
}

// Free every route this invoice billed (so it can be re-invoiced), then remove it.
async function releaseRoutes(inv: RouteInvoice): Promise<void> {
  for (const l of inv.lines) {
    if (!l.routeToken) continue
    try {
      const r = await getRouteByToken(l.routeToken)
      if (r && r.invoiceId === inv.token) { r.invoiceId = undefined; await saveRoute(r) }
    } catch { /* best effort */ }
  }
}
export async function voidInvoice(inv: RouteInvoice): Promise<void> {
  inv.status = 'void'
  await releaseRoutes(inv)
  await saveInvoice(inv)
}
export async function deleteInvoice(token: string): Promise<void> {
  const inv = await getInvoiceByToken(token)
  if (inv) await releaseRoutes(inv)
  await redis.del(KEY(token))
  if (inv) await redis.del(KEY_NUM(inv.invoiceNumber.toUpperCase()))
  await redis.zrem(KEY_INDEX, token)
}

// Completed, not-yet-billed routes for a business in a date window — what an
// invoice would draw from. Used for both the preview and the actual generate.
export async function uninvoicedRoutes(businessName: string, start: string, end: string) {
  const target = businessName.trim().toLowerCase()
  return (await listRoutes(2000))
    .filter(r => r.status === 'completed' && !r.invoiceId &&
      r.businessName.trim().toLowerCase() === target && r.routeDate >= start && r.routeDate <= end)
    .sort((a, b) => a.routeDate.localeCompare(b.routeDate) || a.routeNumber.localeCompare(b.routeNumber))
}

// Create a draft invoice from a business's uninvoiced completed routes in a
// window, seeding line amounts from each route's payRate (editable afterward),
// and stamp each route so it won't be billed twice.
export async function generateFromRoutes(
  businessName: string, start: string, end: string,
  extra: { clientName?: string; clientEmail?: string },
): Promise<{ invoice: RouteInvoice; count: number } | { error: string }> {
  const routes = await uninvoicedRoutes(businessName, start, end)
  if (!routes.length) return { error: 'No completed, un-billed routes for that client in this period.' }

  const now = Date.now()
  const invoice: RouteInvoice = {
    token: generateToken(),
    invoiceNumber: await nextInvoiceNumber(),
    businessName: routes[0].businessName,          // canonical casing from the route
    clientName: extra.clientName, clientEmail: extra.clientEmail,
    periodStart: start, periodEnd: end,
    lines: routes.map(r => ({
      routeToken: r.token, routeNumber: r.routeNumber, routeDate: r.routeDate,
      description: (r.description || 'Contract route').slice(0, 140),
      amountCents: parsePayCents(r.payRate) ?? 0,
    })),
    status: 'draft', amountPaidCents: 0, createdAt: now, updatedAt: now,
  }
  await saveInvoice(invoice)

  for (const r of routes) {
    r.invoiceId = invoice.token
    try { await saveRoute(r) } catch { /* non-fatal — line still exists */ }
  }
  return { invoice, count: routes.length }
}
