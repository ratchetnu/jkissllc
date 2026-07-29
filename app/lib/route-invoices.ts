// Client billing — turn completed routes into an invoice to the contract client.
// payRate on a route is the CONTRACTOR's cost, not the client price, so invoice
// line amounts are seeded from it as a suggestion but are fully editable. Each
// billed route is stamped with invoiceId so it can't be double-billed; voiding or
// deleting the invoice frees its routes again.
import type Stripe from 'stripe'
import { redis } from './redis'
import { bindToken, revokeTokenBinding } from './platform/tenancy/token-binding'
import { currentTenantId } from './platform/tenancy/context'
import { DEFAULT_TENANT_ID } from './platform/tenancy/types'
import { listRoutes } from './routes'
import { mutateRoute } from './route-mutex'
import { parsePayCents } from './route-pay'
import { generateInvoiceToken, INVOICE_TOKEN_RE, nextSequentialNumber, planInvoicePayment } from './invoicing/shared'
import { withLock } from './kv-lock'

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

// Kept as a stable export (now delegates to the shared generator) so existing
// callers and the on-disk token shape are unchanged.
export function generateToken(): string {
  return generateInvoiceToken()
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
  return nextSequentialNumber('JK-RI-', KEY_COUNTER)
}

export async function getInvoiceByToken(token: string): Promise<RouteInvoice | null> {
  if (!token || !INVOICE_TOKEN_RE.test(token)) return null
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
  // WAVE 6D-B. Bind AFTER the record persists, so the public token is never
  // resolvable before the invoice it names exists. Idempotent on re-save (the same
  // tenant re-binding is a no-op), and a conflict — the token already belongs to
  // another tenant — is refused rather than overwritten.
  //
  // Deliberately NOT revoked on `void` or `paid`: the customer-facing contract lets
  // someone reopen a paid or voided invoice link to see its state, and the route
  // itself already returns 404 for void. Killing the binding would turn "this invoice
  // was voided" into "this link is broken".
  try {
    await bindToken(inv.token, {
      tenantId: currentTenantId() ?? DEFAULT_TENANT_ID,
      resourceType: 'route-invoice',
      resourceId: inv.token,
    })
  } catch { /* conflict: never overwrite another tenant's binding */ }
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
    // Under the per-route lock so freeing a route can't clobber a concurrent write
    // to it (a late clock-out, an admin status change). See lib/route-mutex.
    try {
      await mutateRoute(l.routeToken, (route) => {
        if (route.invoiceId !== inv.token) return false
        route.invoiceId = undefined
        return true
      })
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
  // The capability dies with the resource — no dangling platform binding.
  await revokeTokenBinding(token)
}

// Completed, not-yet-billed routes for a business in a date window — what an
// invoice would draw from. Used for both the preview and the actual generate.
// Pure predicate: a route is billable to a client iff it is completed, not yet
// billed, matches the normalized client name, and falls inside the date window.
// Extracted so the selection rule is unit-tested without a live store.
export function isBillableRoute(
  route: { status: string; invoiceId?: string; businessName: string; routeDate: string },
  businessNameLower: string, start: string, end: string,
): boolean {
  return route.status === 'completed' && !route.invoiceId &&
    route.businessName.trim().toLowerCase() === businessNameLower &&
    route.routeDate >= start && route.routeDate <= end
}

export async function uninvoicedRoutes(businessName: string, start: string, end: string) {
  const target = businessName.trim().toLowerCase()
  return (await listRoutes(2000))
    .filter(r => isBillableRoute(r, target, start, end))
    .sort((a, b) => a.routeDate.localeCompare(b.routeDate) || a.routeNumber.localeCompare(b.routeNumber))
}

// ── Per-invoice write lease (INV-1) ──────────────────────────────────────────
//
// The race audit confirmed this: payment recording was read → plan → save with no
// lease, while every admin edit is its own read → mutate → save. An edit that read
// the invoice BEFORE the payment landed would save afterwards and revert
// `status` to 'sent', erasing paidAt / paidMethod / stripeSessionId /
// amountPaidCents. Stripe had the money; Operion showed the invoice unpaid.
//
// Every mutation of one invoice now serializes on its own lease. The key lives in
// the invoice's OWN namespace (`rt:inv:lock:*`, tenant-scoped by the redis
// chokepoint) — deliberately not the booking write-lock namespace. Different
// invoices never contend.
export const INVOICE_LOCK_KEY = (token: string) => `rt:inv:lock:${token}`

/** Raised when the invoice lease could not be acquired within the retry budget. */
export class InvoiceBusyError extends Error {
  constructor() { super('INVOICE_BUSY'); this.name = 'InvoiceBusyError' }
}

/**
 * Run `fn` holding the invoice's lease. `onBusy` decides what contention means for
 * this caller (a controlled 423 for an interactive edit; "return what's stored" for
 * the webhook backstop) — never a 500. Uses the shared kv-lock primitive: unique
 * token, SET NX PX, compare-and-delete release.
 */
export async function withInvoiceLock<T>(
  token: string,
  fn: () => Promise<T>,
  opts: { onBusy: () => T | Promise<T>; ttlMs?: number },
): Promise<T> {
  return withLock<T>(INVOICE_LOCK_KEY(token), fn, {
    ttlMs: opts.ttlMs ?? 15_000,
    attempts: 25,          // ~2.5s of retries before a caller is told the invoice is busy
    backoffMs: 100,
    onBusy: opts.onBusy,
    onStoreError: 'busy',  // money record: prefer a controlled retry over an unguarded write
  })
}

/**
 * Load the invoice FRESH under its lease, mutate, persist. This freshness is the
 * point: a caller that loaded the invoice before acquiring the lease must not save
 * that stale copy over a payment recorded in the meantime. `mutate` returns false
 * to skip the save (a validation bail-out).
 */
export async function mutateInvoice<T>(
  token: string,
  mutate: (inv: RouteInvoice) => T | false | Promise<T | false>,
  opts: { onBusy: () => T | false | Promise<T | false> },
): Promise<T | false | null> {
  return withInvoiceLock<T | false | null>(token, async () => {
    const fresh = await getInvoiceByToken(token)
    if (!fresh) return null
    const value = await mutate(fresh)
    if (value !== false) await saveInvoice(fresh)      // `false` = validation bail-out
    return value
  }, { onBusy: opts.onBusy })
}

// Mark a route invoice paid from its completed Stripe Checkout Session — the SAME
// idempotent transition the success-URL return path applies, exposed so the Stripe
// webhook can act as the durable backstop. A route invoice paid at Stripe can no
// longer stay unmarked if the customer closes the tab before the redirect.
// Idempotent by construction (planInvoicePayment): replay / double-delivery is a
// no-op and never re-credits amountPaidCents. Callers MUST run inside an
// established tenant scope (same contract as lib/record-payment.ts).
export async function recordStripeInvoicePayment(session: Stripe.Checkout.Session): Promise<RouteInvoice | null> {
  const token = session.metadata?.invoiceToken
  if (!token) return null
  // INV-1: serialize with every admin edit of this invoice, and re-read inside the
  // lease so the decision is made on the freshest record. On contention return what
  // is stored rather than failing the webhook — the backstop is retried anyway, and
  // planInvoicePayment keeps the whole thing idempotent.
  return withInvoiceLock<RouteInvoice | null>(token, async () => {
    const inv = await getInvoiceByToken(token)
    if (!inv) return null
    const patch = planInvoicePayment(
      { status: inv.status, subtotalCents: subtotalCents(inv), stripeSessionId: inv.stripeSessionId },
      { id: session.id, payment_status: session.payment_status },
      Date.now(),
    )
    if (!patch) return inv
    Object.assign(inv, patch)
    await saveInvoice(inv)
    return inv
  }, { onBusy: () => getInvoiceByToken(token) })
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

  // Stamp each route under its lock, re-reading fresh. The invoiceId guard also
  // makes two concurrent generations race-safe: whoever locks second sees the
  // route already billed and skips it rather than clobbering the other's write.
  for (const r of routes) {
    try {
      await mutateRoute(r.token, (route) => {
        if (route.invoiceId) return false     // already billed by a concurrent invoice
        route.invoiceId = invoice.token
        return true
      })
    } catch { /* non-fatal — line still exists */ }
  }
  return { invoice, count: routes.length }
}
