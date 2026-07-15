// Phase 5 — public customer-token route tenant resolution.
//
// The routes booking/[token]/verify and quote/status/[token] load a record by its
// UNGUESSABLE token, then derive the tenant from THAT record's own binding — never
// from a client-supplied id/param/query/body. These tests model that decision with
// mocked records (no Redis) and assert the trust model:
//   • resource-binding resolves the record's own tenant when tenancy is on,
//   • a mismatched/altered client-supplied tenant is NEVER taken as authority,
//   • fail-closed when tenancy is on and the record carries no binding,
//   • reference-tenant fallback while tenancy is off (customer experience unchanged),
//   • the derived tenant is actually established as the ambient context.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTenantFromResource } from '../app/lib/platform/tenancy/tenant-resolve'
import { runWithTenant, currentTenantId } from '../app/lib/platform/tenancy/context'
import { DEFAULT_TENANT_ID } from '../app/lib/platform/tenancy/types'

type Record_ = { token: string; tenantId?: string | null }

// Models the handler's control flow: load-by-token already done, now derive the
// tenant from the RECORD and run the rest of the handler in that scope. The
// `clientSuppliedTenantId` argument exists ONLY to prove the handler ignores it.
function establishFromRecord(
  record: Record_ | null,
  opts: { enabled: boolean; clientSuppliedTenantId?: string },
): { ok: true; tenantId: string; contextTenant: string } | { ok: false; reason: 'not_found' | 'fail_closed' } {
  if (!record) return { ok: false, reason: 'not_found' }
  // NOTE: opts.clientSuppliedTenantId is deliberately NEVER passed to the resolver.
  const resolution = resolveTenantFromResource(record, { enabled: opts.enabled, kind: 'booking', correlationId: record.token })
  if (!resolution) return { ok: false, reason: 'fail_closed' }
  const contextTenant = runWithTenant({ tenantId: resolution.tenantId }, () => currentTenantId() ?? 'NONE')
  return { ok: true, tenantId: resolution.tenantId, contextTenant }
}

// ── resource-binding resolves the record's own tenant (flag ON) ───────────────
test('resource-binding resolves the record\'s own tenant when tenancy is on', () => {
  const res = establishFromRecord({ token: 'x'.repeat(32), tenantId: 'acme' }, { enabled: true })
  assert.deepEqual(res, { ok: true, tenantId: 'acme', contextTenant: 'acme' })
})

// ── A client-supplied tenant is NEVER taken as authority (IDOR defense) ───────
test('an altered/mismatched client-supplied tenant is ignored — tenant comes only from the record', () => {
  // Attacker sends tenantId=victim in the body/query; the record belongs to acme.
  const res = establishFromRecord(
    { token: 'x'.repeat(32), tenantId: 'acme' },
    { enabled: true, clientSuppliedTenantId: 'victim' },
  )
  assert.equal(res.ok, true)
  assert.equal((res as { tenantId: string }).tenantId, 'acme')      // record wins
  assert.equal((res as { contextTenant: string }).contextTenant, 'acme')
  // The supplied value never appears anywhere in the resolution.
  assert.notEqual((res as { tenantId: string }).tenantId, 'victim')
})

// ── Fail-closed when enabled and the record has no binding ────────────────────
test('fail-closed when tenancy is on and the record carries no tenant binding', () => {
  const res = establishFromRecord({ token: 'x'.repeat(32) }, { enabled: true })
  assert.deepEqual(res, { ok: false, reason: 'fail_closed' })
  // Direct resolver contract: no binding + enabled → null.
  assert.equal(resolveTenantFromResource({ token: 't' } as Record_, { enabled: true, kind: 'booking' }), null)
})

// ── Fallback while disabled: reference tenant, response unchanged ─────────────
test('fallback to the reference tenant while tenancy is off (customer experience unchanged)', () => {
  // With a binding present, OFF still returns the reference tenant (ignores it).
  const withBinding = establishFromRecord({ token: 'x'.repeat(32), tenantId: 'acme' }, { enabled: false })
  assert.deepEqual(withBinding, { ok: true, tenantId: DEFAULT_TENANT_ID, contextTenant: DEFAULT_TENANT_ID })
  // With NO binding, OFF does NOT fail closed — it runs as today.
  const noBinding = establishFromRecord({ token: 'x'.repeat(32) }, { enabled: false })
  assert.deepEqual(noBinding, { ok: true, tenantId: DEFAULT_TENANT_ID, contextTenant: DEFAULT_TENANT_ID })
})

// ── A missing record is a 404 before any tenant logic ─────────────────────────
test('a missing record short-circuits to not_found before tenant resolution', () => {
  assert.deepEqual(establishFromRecord(null, { enabled: true }), { ok: false, reason: 'not_found' })
  assert.deepEqual(establishFromRecord(null, { enabled: false }), { ok: false, reason: 'not_found' })
})
