// Sprint S1 — tenant context wiring + guardrails.
//
// Verifies that the request/cron/webhook entry wrappers establish tenant context
// correctly, that behavior is byte-identical while TENANCY_ENABLED=false, and that
// enforcement fails CLOSED (never a silent global fallback). Redis-bypass coverage
// lives in scripts/bypass-detection.test.ts (not duplicated here).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { withTenantRoute } from '../app/lib/platform/tenancy/with-tenant-route'
import { withTenantContextFromRequest, resolveBackgroundTenant, withBackgroundTenant } from '../app/lib/platform/tenancy/request-context'
import { currentTenantId } from '../app/lib/platform/tenancy/context'
import { activeTenantIds } from '../app/lib/platform/tenancy/tenant-store'
import { DEFAULT_TENANT_ID } from '../app/lib/platform/tenancy/types'
import { classifyMismatch, recordComparison } from '../app/lib/platform/tenancy/dark-launch'

// Toggle a real env flag around a body, always restoring it (isEnabled reads process.env).
async function withFlag<T>(name: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try { return await fn() } finally {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }
}

const req = (url = 'http://localhost/api/x') => new NextRequest(url)

// (1) Request tenant context is established BEFORE the handler body runs.
test('withTenantRoute establishes tenant context before the handler executes', async () => {
  await withFlag('TENANCY_ENABLED', undefined, async () => {
    let seen: string | undefined = 'UNSET'
    const handler = withTenantRoute(async () => {
      seen = currentTenantId()
      return new Response('ok')
    })
    const res = await handler(req(), undefined)
    assert.equal(await res.text(), 'ok')
    assert.equal(seen, DEFAULT_TENANT_ID) // reference tenant while tenancy is off
  })
})

// (3) TENANCY_ENABLED=false preserves current behavior (no throw, handler runs, result passthrough).
test('flag OFF: session-less request runs the handler unchanged (no throw)', async () => {
  await withFlag('TENANCY_ENABLED', 'false', async () => {
    const handler = withTenantRoute(async () => new Response('body-123', { status: 201 }))
    const res = await handler(req(), undefined)
    assert.equal(res.status, 201)
    assert.equal(await res.text(), 'body-123')
  })
})

// (2)+(9) Missing context fails CLOSED when enforcement is active — never a global fallback.
test('flag ON + no resolvable tenant → throws (fail-closed, no fallback)', async () => {
  await withFlag('TENANCY_ENABLED', 'true', async () => {
    const handler = withTenantRoute(async () => new Response('should-not-run'))
    await assert.rejects(() => Promise.resolve(handler(req(), undefined)), /tenant context required/)
  })
  // And the raw resolver used by authenticated routes behaves the same.
  await withFlag('TENANCY_ENABLED', 'true', async () => {
    await assert.rejects(() => withTenantContextFromRequest(req(), async () => 'x'), /tenant context required/)
  })
})

// (4) Dark-launch comparison is pure — classifies without altering values, never throws.
test('dark-launch classifyMismatch is correct and recordComparison never throws', async () => {
  assert.equal(classifyMismatch('a', 'a'), null)                    // equal → match
  assert.equal(classifyMismatch('a', null), 'missing-tenant-copy')  // legacy only
  assert.equal(classifyMismatch(null, 'a'), 'stale-tenant-copy')    // tenant only
  assert.equal(classifyMismatch('{"a":1,"b":2}', '{"b":2,"a":1}'), 'serialization-mismatch') // reordered JSON
  assert.equal(classifyMismatch('a', 'b'), 'value-mismatch')
  // recording is side-effect-only (redacted telemetry) and returns the type.
  assert.equal(recordComparison('bk:tok', 'jkiss', 'a', 'a'), null)
  assert.equal(recordComparison('bk:tok', 'jkiss', 'a', null), 'missing-tenant-copy')
})

// (5) Cron/background establishes an explicit, separate tenant context per iteration.
test('withBackgroundTenant runs the body inside the resolved tenant context', async () => {
  await withFlag('TENANCY_ENABLED', 'true', async () => {
    const seen: string[] = []
    for (const tid of ['jkiss', 'acme']) {
      await withBackgroundTenant('cron', async () => { seen.push(currentTenantId() ?? 'NONE') }, tid)
    }
    assert.deepEqual(seen, ['jkiss', 'acme'])
  })
})

// (6) One tenant's failure does not execute work under another tenant.
test('a throwing tenant is isolated; the next tenant runs under its OWN context', async () => {
  await withFlag('TENANCY_ENABLED', 'true', async () => {
    const ran: string[] = []
    for (const tid of ['boom', 'jkiss']) {
      try {
        await withBackgroundTenant('cron', async () => {
          const ctx = currentTenantId()
          if (ctx === 'boom') throw new Error('tenant boom failed')
          ran.push(ctx ?? 'NONE')
        }, tid)
      } catch { /* isolated — must not leak into the next iteration */ }
    }
    assert.deepEqual(ran, ['jkiss']) // only the healthy tenant ran, under its own id
  })
})

// (7) Webhooks/crons reject an unresolved tenant when enforcement is active.
test('resolveBackgroundTenant: flag ON + no explicit tenant → throws; flag OFF → reference tenant', async () => {
  await withFlag('TENANCY_ENABLED', 'true', async () => {
    assert.throws(() => resolveBackgroundTenant('webhook'), /requires an explicit tenant/)
    assert.equal(resolveBackgroundTenant('webhook', 'jkiss'), 'jkiss')
  })
  await withFlag('TENANCY_ENABLED', 'false', async () => {
    assert.equal(resolveBackgroundTenant('webhook'), DEFAULT_TENANT_ID) // continuity while off
  })
})

// (10) The active-tenant set for background fan-out is the reference tenant (single-tenant today).
test('activeTenantIds returns the reference tenant set', () => {
  assert.deepEqual(activeTenantIds(), [DEFAULT_TENANT_ID])
})
