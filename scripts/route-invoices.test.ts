// Route-invoice (B2B contract lane) regression + consolidation coverage.
//
// Wave B adds this suite BEFORE touching the implementation — the route lane had
// zero dedicated tests, which made it the riskiest part of the invoicing
// consolidation. Everything here is pure (no live Redis), matching the repo idiom
// (pure core + thin I/O). The first block pins pre-consolidation behavior; the
// second covers the newly-extracted shared plumbing (token, payment idempotency,
// InvoiceLike contract).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  subtotalCents, balanceCents, generateToken, getInvoiceByToken,
  isBillableRoute, type RouteInvoice,
} from '../app/lib/route-invoices'
import {
  INVOICE_TOKEN_RE, generateInvoiceToken, planInvoicePayment, type InvoiceLike,
} from '../app/lib/invoicing/shared'
import { routeInvoiceToInvoiceLike, bookingToInvoiceLike } from '../app/lib/invoicing/adapters'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'

function inv(over: Partial<RouteInvoice> = {}): RouteInvoice {
  return {
    token: 'a'.repeat(32), invoiceNumber: 'JK-RI-1001', businessName: 'Acme',
    lines: [{ description: 'Route 1', amountCents: 5000 }, { description: 'Route 2', amountCents: 2500 }],
    status: 'draft', amountPaidCents: 0, createdAt: 1, updatedAt: 1, ...over,
  }
}

// ── Pinned pre-consolidation behavior ─────────────────────────────────────────

test('subtotalCents sums line amounts and ignores non-finite', () => {
  assert.equal(subtotalCents(inv()), 7500)
  assert.equal(subtotalCents({ lines: [{ description: 'x', amountCents: NaN }, { description: 'y', amountCents: 100 }] }), 100)
  assert.equal(subtotalCents({ lines: [] }), 0)
})

test('balanceCents = max(0, subtotal - paid), never negative', () => {
  assert.equal(balanceCents(inv({ amountPaidCents: 0 })), 7500)
  assert.equal(balanceCents(inv({ amountPaidCents: 2500 })), 5000)
  assert.equal(balanceCents(inv({ amountPaidCents: 9999 })), 0) // overpay clamps to 0
})

test('getInvoiceByToken rejects malformed tokens before any store access', async () => {
  assert.equal(await getInvoiceByToken(''), null)
  assert.equal(await getInvoiceByToken('not-a-token'), null)
  assert.equal(await getInvoiceByToken('xyz'), null)
})

// ── Shared plumbing (extracted in Wave B, byte-identical behavior) ─────────────

test('invoice token generator produces a URL-safe 64-hex token that matches the guard', () => {
  for (let i = 0; i < 25; i++) {
    const t = generateInvoiceToken()
    assert.match(t, /^[a-f0-9]{64}$/)
    assert.ok(INVOICE_TOKEN_RE.test(t))
  }
  // route-invoices.generateToken now delegates to the shared generator — same shape.
  assert.match(generateToken(), INVOICE_TOKEN_RE)
})

// ── Payment idempotency — the core guarantee: a paid route invoice cannot remain
// unmarked, and no path can double-apply or over-credit. ──────────────────────

const paidSession = { id: 'cs_test_1', payment_status: 'paid' as const }

test('planInvoicePayment marks a draft invoice paid at its full subtotal', () => {
  const patch = planInvoicePayment({ status: 'draft', subtotalCents: 7500 }, paidSession, 1234)
  assert.deepEqual(patch, { amountPaidCents: 7500, status: 'paid', paidAt: 1234, paidMethod: 'card', stripeSessionId: 'cs_test_1' })
})

test('planInvoicePayment is idempotent: replay of the SAME session is a no-op', () => {
  // Already carries this session id (a prior webhook/return already applied it).
  assert.equal(planInvoicePayment({ status: 'paid', subtotalCents: 7500, stripeSessionId: 'cs_test_1' }, paidSession, 2), null)
  // Already paid by any means → no-op (cannot re-credit / double amountPaid).
  assert.equal(planInvoicePayment({ status: 'paid', subtotalCents: 7500 }, paidSession, 2), null)
})

test('planInvoicePayment refuses void invoices and unpaid/incomplete sessions', () => {
  assert.equal(planInvoicePayment({ status: 'void', subtotalCents: 7500 }, paidSession, 2), null)
  assert.equal(planInvoicePayment({ status: 'draft', subtotalCents: 7500 }, { id: 'cs_x', payment_status: 'unpaid' }, 2), null)
  assert.equal(planInvoicePayment({ status: 'sent', subtotalCents: 7500 }, { id: 'cs_x', payment_status: null }, 2), null)
})

// ── Billable-route selection (pure predicate behind generateFromRoutes) ────────

const baseRoute = { status: 'completed', invoiceId: undefined, businessName: 'Acme', routeDate: '2026-03-10' }

test('isBillableRoute selects only completed, un-billed routes for the client in-window', () => {
  const t = 'acme'
  assert.equal(isBillableRoute(baseRoute, t, '2026-03-01', '2026-03-31'), true)
  assert.equal(isBillableRoute({ ...baseRoute, status: 'scheduled' }, t, '2026-03-01', '2026-03-31'), false) // not completed
  assert.equal(isBillableRoute({ ...baseRoute, invoiceId: 'someinv' }, t, '2026-03-01', '2026-03-31'), false) // already billed
  assert.equal(isBillableRoute({ ...baseRoute, businessName: 'Other' }, t, '2026-03-01', '2026-03-31'), false) // different client
  assert.equal(isBillableRoute(baseRoute, t, '2026-04-01', '2026-04-30'), false) // out of window
  assert.equal(isBillableRoute({ ...baseRoute, businessName: '  ACME ' }, t, '2026-03-01', '2026-03-31'), true) // trims + case-insensitive
})

// ── InvoiceLike contract — BOTH lanes satisfy one shape (no entity merge) ──────

function assertInvoiceLike(v: InvoiceLike) {
  assert.equal(typeof v.invoiceNumber, 'string')
  assert.equal(typeof v.status, 'string')
  assert.equal(typeof v.subtotalCents, 'number')
  assert.equal(typeof v.amountPaidCents, 'number')
  assert.equal(typeof v.balanceCents, 'number')
  assert.ok(Array.isArray(v.lines))
  assert.equal(typeof v.party.name, 'string')
}

test('routeInvoiceToInvoiceLike produces a valid InvoiceLike (B2B lane)', () => {
  const v = routeInvoiceToInvoiceLike(inv({ amountPaidCents: 2500, clientName: 'Acme Corp' }))
  assertInvoiceLike(v)
  assert.equal(v.invoiceNumber, 'JK-RI-1001')
  assert.equal(v.subtotalCents, 7500)
  assert.equal(v.balanceCents, 5000)
  assert.equal(v.party.name, 'Acme Corp')
  assert.equal(v.lines.length, 2)
})

test('bookingToInvoiceLike produces a valid InvoiceLike (B2C lane) without merging entities', () => {
  const booking = {
    invoiceNumber: 'JK-INV-1005', status: 'confirmed',
    invoiceAmountCents: 30000, discountCents: 0, amountPaidCents: 10000,
    customerName: 'Jane Doe', customerEmail: 'jane@example.com',
    items: ['Sofa', 'Boxes'],
  }
  const v = bookingToInvoiceLike(booking)
  assertInvoiceLike(v)
  assert.equal(v.invoiceNumber, 'JK-INV-1005')
  assert.equal(v.amountPaidCents, 10000)
  assert.equal(v.party.name, 'Jane Doe')
})

test('invoicing capability is marked full after consolidation, spanning both lanes', () => {
  const cap = CAPABILITY_REGISTRY['invoicing']
  assert.equal(cap.status, 'full')
  for (const dep of ['bookings', 'routes']) assert.ok(cap.dependencies.includes(dep as never), `invoicing depends on ${dep}`)
  assert.ok(cap.requiredPermissions.includes('invoices:manage'))
})

// Corrected: `payments` was a HARD dependency of invoicing, which asserted — in the
// one machine-readable place that answers the question — that a business cannot bill
// anyone without a payment lane, and by extension without a card processor. An
// invoice is a record: it is numbered, rendered, sent, viewed at /invoice/{token} and
// marked paid from an offline payment with no processor involved. It is now a SOFT
// dependency, so a target with no Stripe can still receive and run the invoicing code.
test('invoicing does NOT hard-depend on payments or Stripe — an invoice is a record', () => {
  const cap = CAPABILITY_REGISTRY['invoicing']
  assert.ok(!cap.dependencies.includes('payments'), 'payments must not be a hard prerequisite of invoicing')
  assert.ok(!cap.dependencies.includes('payments-stripe'), 'card payments must never be a hard prerequisite of invoicing')
  assert.ok(cap.softDependencies.includes('payments'), 'payments is still declared — as an enhancement')
  assert.ok(cap.softDependencies.includes('payments-stripe'))
})

// Same correction for reporting: opening a revenue report must not require a card
// processor. The report reads booking + invoice records.
test('reporting does NOT hard-depend on payments', () => {
  const cap = CAPABILITY_REGISTRY['reporting']
  assert.ok(!cap.dependencies.includes('payments'), 'a report must not need Stripe merely to load')
  assert.ok(cap.softDependencies.includes('payments'))
})
