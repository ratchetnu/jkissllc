// Operion tenant-safe boundaries — the remaining PUBLIC customer-token routes.
//
// Covers the routes wired in this sprint on top of the two proven exemplars
// (booking/[token]/verify, quote/status/[token], already covered by
// public-route-tenant.test.ts):
//   • booking/[token]{,/cancel,/confirm-return,/confirmation,/manual-payment,
//     /pay,/promo,/reschedule,/review}      → derive from the loaded Booking
//   • invoice/[token]{,/stripe-return}       → derive from the loaded Invoice
//   • booking/[token]/stripe-return          → derive from the (server-fetched,
//                                               trusted) Stripe session metadata
//
// Each route loads a record by its UNGUESSABLE token, then derives the tenant
// from THAT record's own binding — never from a client-supplied id/param/query/
// body. These tests model that decision with mocked records (no Redis, no Stripe)
// and assert the trust model:
//   • resource-binding resolves the record's own tenant when tenancy is on,
//   • a mismatched/altered client-supplied tenant is NEVER taken as authority,
//   • fail-closed when tenancy is on and the record carries no binding,
//   • reference-tenant fallback while tenancy is off (customer experience unchanged),
//   • a missing record short-circuits to not_found BEFORE any tenant logic,
//   • the derived tenant is actually established as the ambient context.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveTenantFromResource,
  resolveTenantFromStripe,
} from '../app/lib/platform/tenancy/tenant-resolve'
import { runWithTenant, currentTenantId } from '../app/lib/platform/tenancy/context'
import { DEFAULT_TENANT_ID } from '../app/lib/platform/tenancy/types'

type Booking_ = { token: string; tenantId?: string | null }
type Invoice_ = { token: string; status?: string; tenantId?: string | null }

// Models a Booking/Invoice public route's control flow: load-by-token already done,
// now derive the tenant from the RECORD and run the rest of the handler in that
// scope. `clientSuppliedTenantId` exists ONLY to prove the handler ignores it.
function establishFromResource(
  record: Booking_ | Invoice_ | null,
  kind: 'booking' | 'invoice',
  opts: { enabled: boolean; clientSuppliedTenantId?: string },
): { ok: true; tenantId: string; contextTenant: string } | { ok: false; reason: 'not_found' | 'fail_closed' } {
  if (!record) return { ok: false, reason: 'not_found' }
  // NOTE: opts.clientSuppliedTenantId is deliberately NEVER passed to the resolver.
  const resolution = resolveTenantFromResource(record, { enabled: opts.enabled, kind, correlationId: record.token })
  if (!resolution) return { ok: false, reason: 'fail_closed' }
  const contextTenant = runWithTenant({ tenantId: resolution.tenantId }, () => currentTenantId() ?? 'NONE')
  return { ok: true, tenantId: resolution.tenantId, contextTenant }
}

// Models booking/[token]/stripe-return: the session is fetched server-to-server
// with our secret key, so its stamped metadata.tenantId (put there by pay/route)
// is trusted. Derive from that metadata and run the payment write in that scope.
function establishFromStripeSession(
  session: { metadata?: { bookingToken?: string; tenantId?: string | null } } | null,
  token: string,
  opts: { enabled: boolean },
): { ok: true; tenantId: string; contextTenant: string } | { ok: false; reason: 'not_matched' | 'fail_closed' } {
  if (!session || session.metadata?.bookingToken !== token) return { ok: false, reason: 'not_matched' }
  const resolution = resolveTenantFromStripe(session.metadata, { enabled: opts.enabled, correlationId: token })
  if (!resolution) return { ok: false, reason: 'fail_closed' }
  const contextTenant = runWithTenant({ tenantId: resolution.tenantId }, () => currentTenantId() ?? 'NONE')
  return { ok: true, tenantId: resolution.tenantId, contextTenant }
}

const TOKEN = 'x'.repeat(32)

// ── Booking routes: resource-binding resolves the record's own tenant (ON) ────
test('booking route derives the loaded booking\'s own tenant when tenancy is on', () => {
  const res = establishFromResource({ token: TOKEN, tenantId: 'acme' }, 'booking', { enabled: true })
  assert.deepEqual(res, { ok: true, tenantId: 'acme', contextTenant: 'acme' })
})

// ── Invoice routes: resource-binding resolves the record's own tenant (ON) ────
test('invoice route derives the loaded invoice\'s own tenant when tenancy is on', () => {
  const res = establishFromResource({ token: TOKEN, status: 'sent', tenantId: 'globex' }, 'invoice', { enabled: true })
  assert.deepEqual(res, { ok: true, tenantId: 'globex', contextTenant: 'globex' })
})

// ── A client-supplied tenant is NEVER taken as authority (IDOR defense) ───────
test('an altered/mismatched client-supplied tenant is ignored — tenant comes only from the record', () => {
  // Attacker sends tenantId=victim in the body/query; the record belongs to acme.
  const res = establishFromResource(
    { token: TOKEN, tenantId: 'acme' },
    'booking',
    { enabled: true, clientSuppliedTenantId: 'victim' },
  )
  assert.equal(res.ok, true)
  assert.equal((res as { tenantId: string }).tenantId, 'acme')      // record wins
  assert.equal((res as { contextTenant: string }).contextTenant, 'acme')
  assert.notEqual((res as { tenantId: string }).tenantId, 'victim') // supplied value never surfaces
})

// ── Fail-closed when enabled and the record has no binding (booking + invoice) ─
test('fail-closed when tenancy is on and the record carries no tenant binding', () => {
  assert.deepEqual(establishFromResource({ token: TOKEN }, 'booking', { enabled: true }), { ok: false, reason: 'fail_closed' })
  assert.deepEqual(establishFromResource({ token: TOKEN, status: 'sent' }, 'invoice', { enabled: true }), { ok: false, reason: 'fail_closed' })
  // Direct resolver contract: no binding + enabled → null.
  assert.equal(resolveTenantFromResource({ token: 't' } as Booking_, { enabled: true, kind: 'booking' }), null)
})

// ── Fallback while disabled: reference tenant, response unchanged ─────────────
test('fallback to the reference tenant while tenancy is off (customer experience unchanged)', () => {
  // With a binding present, OFF still returns the reference tenant (ignores it).
  const withBinding = establishFromResource({ token: TOKEN, tenantId: 'acme' }, 'booking', { enabled: false })
  assert.deepEqual(withBinding, { ok: true, tenantId: DEFAULT_TENANT_ID, contextTenant: DEFAULT_TENANT_ID })
  // With NO binding, OFF does NOT fail closed — it runs as today (both kinds).
  assert.deepEqual(establishFromResource({ token: TOKEN }, 'booking', { enabled: false }), { ok: true, tenantId: DEFAULT_TENANT_ID, contextTenant: DEFAULT_TENANT_ID })
  assert.deepEqual(establishFromResource({ token: TOKEN, status: 'sent' }, 'invoice', { enabled: false }), { ok: true, tenantId: DEFAULT_TENANT_ID, contextTenant: DEFAULT_TENANT_ID })
})

// ── A missing record is a 404 before any tenant logic (booking + invoice) ─────
test('a missing record short-circuits to not_found before tenant resolution', () => {
  assert.deepEqual(establishFromResource(null, 'booking', { enabled: true }), { ok: false, reason: 'not_found' })
  assert.deepEqual(establishFromResource(null, 'invoice', { enabled: false }), { ok: false, reason: 'not_found' })
})

// ── booking/[token]/stripe-return: derive from the trusted Stripe metadata ────
test('booking stripe-return derives tenant from the server-fetched session metadata when tenancy is on', () => {
  const res = establishFromStripeSession(
    { metadata: { bookingToken: TOKEN, tenantId: 'acme' } },
    TOKEN,
    { enabled: true },
  )
  assert.deepEqual(res, { ok: true, tenantId: 'acme', contextTenant: 'acme' })
})

test('booking stripe-return fails closed when enabled and the session carries no tenant metadata', () => {
  const res = establishFromStripeSession({ metadata: { bookingToken: TOKEN } }, TOKEN, { enabled: true })
  assert.deepEqual(res, { ok: false, reason: 'fail_closed' })
})

test('booking stripe-return falls back to the reference tenant while tenancy is off', () => {
  // No tenant metadata at all → OFF still resolves the reference tenant, so the
  // payment write records exactly as it does today.
  const res = establishFromStripeSession({ metadata: { bookingToken: TOKEN } }, TOKEN, { enabled: false })
  assert.deepEqual(res, { ok: true, tenantId: DEFAULT_TENANT_ID, contextTenant: DEFAULT_TENANT_ID })
})

test('booking stripe-return does not resolve a tenant for a session whose token does not match', () => {
  const res = establishFromStripeSession({ metadata: { bookingToken: 'other', tenantId: 'acme' } }, TOKEN, { enabled: true })
  assert.deepEqual(res, { ok: false, reason: 'not_matched' })
})
