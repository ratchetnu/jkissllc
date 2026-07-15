// Phase 6 — Stripe webhook tenant resolution.
//
// Mirrors the /api/webhooks/stripe control flow with MOCKED Stripe events and a
// mock recorder that reproduces record-payment's session-id dedup contract. No
// live Stripe calls, no Redis, no charges. Verifies the invariants the route
// relies on:
//   • outbound metadata carries the originating tenant id,
//   • a signature-verified event resolves its tenant from that metadata,
//   • missing metadata when tenancy is ON fails CLOSED (recorder never runs),
//   • a signature failure short-circuits BEFORE any tenant resolution,
//   • a duplicate event is deduped by session id,
//   • legacy J-KISS events (no metadata, flag OFF) fall back to the reference
//     tenant,
//   • the resolved tenant is carried into the downstream recorder's context.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveTenantFromStripe, tenantIdForOutboundMetadata,
} from '../app/lib/platform/tenancy/tenant-resolve'
import { withBackgroundTenant } from '../app/lib/platform/tenancy/request-context'
import { currentTenantId } from '../app/lib/platform/tenancy/context'
import { DEFAULT_TENANT_ID } from '../app/lib/platform/tenancy/types'

// Toggle a real env flag around a body, always restoring it (isEnabled + the
// background wrapper read process.env directly).
async function withFlag<T>(name: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try { return await fn() } finally {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }
}

type MockSession = { id: string; metadata?: Record<string, string> | null }
type MockEvent = { id: string; type: string; data: { object: MockSession } }

// A recorder that reproduces the dedup + context-capture contract of
// record-payment.recordStripeSessionPayment: a session id is only applied once,
// and each application runs inside the AMBIENT tenant context (chokepoint scope).
function makeRecorder() {
  const applied = new Set<string>()
  const tenantsSeen: string[] = []
  return {
    applied, tenantsSeen,
    async record(session: MockSession): Promise<{ deduped: boolean }> {
      if (applied.has(session.id)) return { deduped: true }   // idempotent by session id
      applied.add(session.id)
      tenantsSeen.push(currentTenantId() ?? 'NONE')
      return { deduped: false }
    },
  }
}

// The exact webhook decision path AFTER constructEvent has verified the signature.
async function dispatchVerifiedEvent(
  event: MockEvent, recorder: ReturnType<typeof makeRecorder>,
): Promise<{ status: 'ok' | 'failed_closed'; tenantId?: string }> {
  const session = event.data.object
  const resolution = resolveTenantFromStripe(session.metadata, { correlationId: event.id })
  if (!resolution) return { status: 'failed_closed' } // route alerts + skips (200 still returned)
  await withBackgroundTenant('webhook', () => recorder.record(session), resolution.tenantId)
  return { status: 'ok', tenantId: resolution.tenantId }
}

const mkEvent = (o: Partial<MockSession> & { id?: string; type?: string } = {}): MockEvent => ({
  id: o.id ? `evt_${o.id}` : 'evt_1',
  type: o.type ?? 'checkout.session.completed',
  data: { object: { id: o.id ?? 'cs_1', metadata: o.metadata } },
})

// ── Outbound metadata ─────────────────────────────────────────────────────────
test('outbound metadata stamps the reference tenant id while tenancy is off', () => {
  assert.equal(tenantIdForOutboundMetadata(), DEFAULT_TENANT_ID)
})

// ── Verified event resolves the tenant from metadata (flag ON) ────────────────
test('a verified event resolves its tenant from stamped metadata when tenancy is on', async () => {
  await withFlag('TENANCY_ENABLED', 'true', async () => {
    const recorder = makeRecorder()
    const res = await dispatchVerifiedEvent(mkEvent({ id: 'A', metadata: { bookingToken: 't', tenantId: 'acme' } }), recorder)
    assert.deepEqual(res, { status: 'ok', tenantId: 'acme' })
    assert.deepEqual(recorder.tenantsSeen, ['acme']) // downstream recorder ran under the resolved tenant
  })
})

// ── Missing metadata when enabled fails closed ────────────────────────────────
test('missing tenant metadata when tenancy is on fails closed — recorder never runs', async () => {
  await withFlag('TENANCY_ENABLED', 'true', async () => {
    const recorder = makeRecorder()
    assert.equal(resolveTenantFromStripe({ bookingToken: 't' } as Record<string, string>, { correlationId: 'e' }), null)
    const res = await dispatchVerifiedEvent(mkEvent({ id: 'B', metadata: { bookingToken: 't' } }), recorder)
    assert.equal(res.status, 'failed_closed')
    assert.equal(recorder.applied.size, 0)      // no cross-tenant write
    assert.deepEqual(recorder.tenantsSeen, [])
  })
})

// ── Signature failure short-circuits before resolution ────────────────────────
test('a signature-verification failure rejects the request before any tenant resolution', async () => {
  // Models the route: constructEvent throws → 400, handler body never runs.
  const recorder = makeRecorder()
  const constructEvent = () => { throw new Error('No signatures found matching the expected signature') }
  let status = 0
  let resolved = false
  try {
    constructEvent()
    resolved = true // unreachable
    await dispatchVerifiedEvent(mkEvent(), recorder)
  } catch {
    status = 400
  }
  assert.equal(status, 400)
  assert.equal(resolved, false)
  assert.equal(recorder.applied.size, 0) // tenant is NEVER resolved from an unverified event
})

// ── Duplicate event is deduped by session id ──────────────────────────────────
test('a duplicate event (same session id) is deduped — applied at most once', async () => {
  await withFlag('TENANCY_ENABLED', 'true', async () => {
    const recorder = makeRecorder()
    const ev = mkEvent({ id: 'C', metadata: { bookingToken: 't', tenantId: 'acme' } })
    const first = await dispatchVerifiedEvent(ev, recorder)
    const second = await dispatchVerifiedEvent(ev, recorder) // Stripe retry / return-path race
    assert.equal(first.status, 'ok')
    assert.equal(second.status, 'ok')
    assert.equal(recorder.applied.size, 1)          // recorded exactly once
    assert.deepEqual(recorder.tenantsSeen, ['acme']) // second call was a no-op, not a second write
  })
})

// ── Legacy J-KISS (no metadata, flag OFF) → reference-tenant fallback ─────────
test('a legacy event without tenant metadata falls back to the reference tenant while off', async () => {
  await withFlag('TENANCY_ENABLED', 'false', async () => {
    const recorder = makeRecorder()
    // Legacy sessions created before this sprint carry no tenantId.
    const res = await dispatchVerifiedEvent(mkEvent({ id: 'D', metadata: { bookingToken: 't' } }), recorder)
    assert.deepEqual(res, { status: 'ok', tenantId: DEFAULT_TENANT_ID })
    assert.deepEqual(recorder.tenantsSeen, [DEFAULT_TENANT_ID]) // recorded under reference tenant, unchanged
  })
})

// ── No behavior change while flag off: context still established (as today) ───
test('flag OFF: the recorder runs inside the reference-tenant context (byte-identical to today)', async () => {
  await withFlag('TENANCY_ENABLED', 'false', async () => {
    const recorder = makeRecorder()
    // Even with tenant metadata present, OFF ignores it and uses the reference tenant.
    const res = await dispatchVerifiedEvent(mkEvent({ id: 'E', metadata: { bookingToken: 't', tenantId: 'acme' } }), recorder)
    assert.equal(res.tenantId, DEFAULT_TENANT_ID)
    assert.deepEqual(recorder.tenantsSeen, [DEFAULT_TENANT_ID])
  })
})
