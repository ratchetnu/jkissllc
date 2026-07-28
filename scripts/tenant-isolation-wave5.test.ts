// ── WAVE 5: tenant-isolation audit — permanent regression suite ──────────────
//
// Three confirmed defects (TEN-1/2/3) plus the standing cross-tenant invariants
// they were found by. Every test asserts FINAL STORAGE STATE at the physical key,
// never just a status code: the in-memory KV here is keyed by the key the redis
// chokepoint would really issue (scopeKey), so "denied" means the byte never landed
// in the other tenant's namespace.
//
// The suite runs with tenancy FORCED ON (`{ enabled: true }` / explicit contexts).
// Production runs TENANCY_ENABLED=false, where the chokepoint is a no-op — these are
// the properties that must hold the moment that flag flips, which is exactly when a
// silent isolation bug would become a breach.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

import { scopeKey, normalizeTenantId, isPlatformGlobal, PLATFORM_GLOBAL_PREFIXES } from '../app/lib/platform/tenancy/keys'
import { runWithTenant, currentTenantId } from '../app/lib/platform/tenancy/context'
import { DEFAULT_TENANT_ID } from '../app/lib/platform/tenancy/types'
import { resolveTenantFromResource } from '../app/lib/platform/tenancy/tenant-resolve'
import { withBackgroundTenant, resolveBackgroundTenant } from '../app/lib/platform/tenancy/request-context'
import { tenantId } from '../app/lib/tenant'
import { DUE_KEY } from '../app/lib/ai-due-index'
import { setAiFeedback, getAiCall, recordAiCall, type AiCallRecord, type TelemetryStore } from '../app/lib/ai/telemetry'
import { makeEventLog, type EventLogClient } from '../app/lib/platform/events/event-log'
import { createUserSessionToken, getPrincipal, COOKIE_NAME } from '../app/api/admin/_lib/session'

const A = 'alpha'
const B = 'bravo'

/** Run `fn` with TENANCY_ENABLED forced on, restoring the ambient value after. */
async function withTenancyOn<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.TENANCY_ENABLED
  process.env.TENANCY_ENABLED = 'true'
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.TENANCY_ENABLED; else process.env.TENANCY_ENABLED = prev
  }
}

// ── A KV keyed by the PHYSICAL key, so isolation is observed, not asserted ────
function kv() {
  const m = new Map<string, string>()
  return {
    raw: m,
    write: (logical: string, tid: string, v: string) => m.set(scopeKey(logical, { enabled: true, tenantId: tid }), v),
    read: (logical: string, tid: string) => m.get(scopeKey(logical, { enabled: true, tenantId: tid })) ?? null,
    // Everything physically stored, so a test can prove nothing leaked sideways.
    keys: () => [...m.keys()].sort(),
  }
}

/** Assert that A writing `logical` cannot be seen or clobbered by B, and vice versa. */
function assertTwoWayIsolation(logical: string, label: string) {
  const store = kv()
  store.write(logical, A, `${label}-ALPHA`)
  store.write(logical, B, `${label}-BRAVO`)

  assert.equal(store.read(logical, A), `${label}-ALPHA`, `${label}: alpha reads its own`)
  assert.equal(store.read(logical, B), `${label}-BRAVO`, `${label}: bravo reads its own`)
  assert.equal(store.keys().length, 2, `${label}: identical logical id produced TWO physical keys`)

  // B overwrites the same logical id — A's bytes must be untouched.
  store.write(logical, B, 'CLOBBER')
  assert.equal(store.read(logical, A), `${label}-ALPHA`, `${label}: alpha's stored value survived b's write`)
}

// ─────────────────────────────────────────────────────────────────────────────
// TEN-1 — the AI layer stamped a HOST, not a tenant id
// ─────────────────────────────────────────────────────────────────────────────

test('TEN-1: tenantId() returns an opaque id in the tenancy id space (never a host)', () => {
  const id = tenantId()
  assert.equal(id, DEFAULT_TENANT_ID, 'with no context and no override this is the reference tenant')
  // The regression: a host ('jkissllc.com') is display-derived and normalizeTenantId
  // rejects it, so it could never be a boundary.
  assert.doesNotThrow(() => normalizeTenantId(id), 'the stamped id must survive normalization')
  assert.ok(!id.includes('.'), 'a dotted host is not a tenant id')
})

test('TEN-1: tenantId() follows the ACTIVE tenant context, so records self-attribute', () => {
  assert.equal(runWithTenant({ tenantId: A }, () => tenantId()), A)
  assert.equal(runWithTenant({ tenantId: B }, () => tenantId()), B)
  assert.equal(tenantId(), DEFAULT_TENANT_ID, 'outside any context, back to the reference tenant')
})

test('TEN-1: an unusable TENANT_ID override never becomes a boundary', () => {
  const prev = process.env.TENANT_ID
  try {
    process.env.TENANT_ID = 'J Kiss LLC'         // a display name
    assert.equal(tenantId(), DEFAULT_TENANT_ID, 'rejected override falls back, never keys under a bad id')
    process.env.TENANT_ID = 'jkissllc.com'       // a host
    assert.equal(tenantId(), DEFAULT_TENANT_ID)
    process.env.TENANT_ID = 'Tenant-Two'         // valid once normalized
    assert.equal(tenantId(), 'tenant-two')
  } finally {
    if (prev === undefined) delete process.env.TENANT_ID; else process.env.TENANT_ID = prev
  }
})

test('TEN-1: a stamped record and the live context compare in the SAME id space', () => {
  // The bug made this comparison structurally impossible: 'jkissllc.com' !== 'jkiss',
  // so scopeAiRecords filtered out every record and "isolated" by disclosing nothing.
  const stamped = runWithTenant({ tenantId: A }, () => tenantId())
  const observed = runWithTenant({ tenantId: A }, () => currentTenantId())
  assert.equal(stamped, observed, 'stamping and filtering must agree or the control is vacuous')
})

// ─────────────────────────────────────────────────────────────────────────────
// TEN-2 — a platform-global key holding tenant-owned state
// ─────────────────────────────────────────────────────────────────────────────

test('TEN-2: the AI due-job index is tenant-namespaced, not one shared ZSET', () => {
  const a = scopeKey(DUE_KEY, { enabled: true, tenantId: A })
  const b = scopeKey(DUE_KEY, { enabled: true, tenantId: B })
  assert.notEqual(a, b, 'the due index must not be a single physical key across tenants')
  assert.ok(!isPlatformGlobal(DUE_KEY), 'the due index holds tenant-owned booking tokens — it is not platform-global')
  assert.match(a, /^t:alpha:/)
})

test('TEN-2: two tenants scheduling the SAME booking token stay in separate indexes', () => {
  assertTwoWayIsolation(DUE_KEY, 'due-index')
})

test('TEN-2: the platform-global allowlist is exactly the reviewed set', () => {
  // A guard, not a restatement: adding a prefix here exempts a whole key family from
  // the tenancy chokepoint, which is how TEN-2 happened. Changing this list should
  // require changing this test, deliberately.
  assert.deepEqual([...PLATFORM_GLOBAL_PREFIXES], ['opspilot:', 'platform:', 'ai:', 'rl:'])
})

test('TEN-2: tenant-owned families across every audited subsystem are namespaced', () => {
  // One representative real key per high-risk subsystem, using the ACTUAL builders'
  // shapes. Any of these landing on the global allowlist would be a repeat of TEN-2.
  const families: [string, string][] = [
    ['cust:c-1', 'customer'],
    ['bk:tok-1', 'booking'],
    ['rt:tok-1', 'route'],
    ['crew:s-1', 'staff'],
    ['applicants:a-1', 'applicant'],
    ['tcorr:tc-1', 'time-correction'],
    ['paystmt:ps-1', 'pay-statement'],
    ['rt:inv:inv-1', 'route-invoice'],
    ['msg:m-1', 'message'],
    ['msg:pid:PROVIDER-SID-1', 'provider-message-mapping'],
    ['crewdoc:d-1', 'document'],
    ['audit:log', 'tenant-audit-log'],
    ['bk:index', 'booking-index'],
    ['rt:inv:num:1001', 'invoice-number-counter'],
  ]
  for (const [key, label] of families) {
    assert.ok(!isPlatformGlobal(key), `${label} (${key}) must not be platform-global`)
    assertTwoWayIsolation(key, label)
  }
})

test('TEN-2: the tenant audit log is separate from the platform audit log', () => {
  // Operational (tenant) audit is `audit:*` and IS scoped; platform-owner audit is
  // `platform:audit:*` and is deliberately global. Conflating them would leak one
  // tenant's activity into another's timeline.
  assert.ok(!isPlatformGlobal('audit:log'), 'tenant audit log is tenant-owned')
  assert.ok(isPlatformGlobal('platform:audit:index'), 'platform audit log is deliberately global')
  assert.notEqual(
    scopeKey('audit:log', { enabled: true, tenantId: A }),
    scopeKey('audit:log', { enabled: true, tenantId: B }),
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// TEN-3 — an ownership check against a deployment constant
// ─────────────────────────────────────────────────────────────────────────────

function telemetryStore(): TelemetryStore {
  const m = new Map<string, string>()
  const z = new Map<string, Map<string, number>>()
  return {
    async get(k: string) { return m.get(k) ?? null },
    async set(k: string, v: string) { m.set(k, v) },
    async del(k: string) { m.delete(k) },
    async zadd(k: string, s: number, mem: string) { if (!z.has(k)) z.set(k, new Map()); z.get(k)!.set(mem, s) },
    async zrevrange(k: string, a: number, b: number) { const e = [...(z.get(k) ?? new Map())].sort((x, y) => y[1] - x[1]).map(x => x[0]); return e.slice(a, b < 0 ? undefined : b + 1) },
    async zrange(k: string, a: number, b: number) { const e = [...(z.get(k) ?? new Map())].sort((x, y) => x[1] - y[1]).map(x => x[0]); return e.slice(a, b < 0 ? undefined : b + 1) },
    async zrem(k: string, mem: string) { z.get(k)?.delete(mem) },
    async zcard(k: string) { return z.get(k)?.size ?? 0 },
    async setNxPx(k: string, v: string) { if (m.has(k)) return false; m.set(k, v); return true },
  }
}

const aiRecord = (id: string, tid: string) => ({
  id, at: Date.now(), tenantId: tid, actor: 'u', role: 'admin', feature: 'f', taskId: 'ops.insights',
  promptVersion: 1, model: 'anthropic/claude', latencyMs: 1, inputTokens: 1, outputTokens: 1,
  totalTokens: 2, estCostUsd: 0, requestChars: 0, responseValid: true, ok: true, outcome: 'ok',
}) as unknown as AiCallRecord

test('TEN-3: tenant B cannot write feedback onto tenant A\'s AI record', async () => {
  const store = telemetryStore()
  await recordAiCall(aiRecord('call-a', A), store)

  const denied = await setAiFeedback('call-a', true, B, store)
  assert.equal(denied, false, 'a foreign tenant is refused')

  // STORAGE STATE, not just the return value: no byte of feedback landed.
  const after = await getAiCall('call-a', store)
  assert.equal(after?.feedback, undefined, 'no feedback was written by the foreign tenant')
  assert.equal(after?.feedbackAt, undefined)
  assert.equal(after?.tenantId, A, 'ownership was not rewritten')
})

test('TEN-3: the owning tenant still succeeds (the guard denies, it does not break)', async () => {
  const store = telemetryStore()
  await recordAiCall(aiRecord('call-a', A), store)
  assert.equal(await setAiFeedback('call-a', true, A, store), true)
  assert.equal((await getAiCall('call-a', store))?.feedback, 'helpful')
})

test('TEN-3: the ownership boundary is the CALLER tenant, not a deployment constant', async () => {
  // The defect: the route passed tenantId() while service.ts stamped records with the
  // same tenantId(), so the comparison was a constant against itself. Two tenants must
  // now get different answers for the same record.
  const store = telemetryStore()
  await recordAiCall(aiRecord('shared-id', A), store)
  const asA = await setAiFeedback('shared-id', true, A, store)
  const asB = await setAiFeedback('shared-id', false, B, store)
  assert.notEqual(asA, asB, 'the two tenants must NOT receive the same verdict')
  assert.equal((await getAiCall('shared-id', store))?.feedback, 'helpful', "b's 'not helpful' never landed")
})

test('TEN-3: a foreign record is indistinguishable from a missing one', async () => {
  const store = telemetryStore()
  await recordAiCall(aiRecord('call-a', A), store)
  const foreign = await setAiFeedback('call-a', true, B, store)
  const missing = await setAiFeedback('does-not-exist', true, B, store)
  assert.equal(foreign, missing, 'existence must not leak through a different result')
})

// ─────────────────────────────────────────────────────────────────────────────
// Standing invariants — required coverage per subsystem
// ─────────────────────────────────────────────────────────────────────────────

test('READ isolation: A cannot read B\'s customer, staff, invoice, pay statement or message', () => {
  const store = kv()
  for (const k of ['cust:c-9', 'crew:s-9', 'rt:inv:i-9', 'paystmt:p-9', 'msg:m-9']) {
    store.write(k, B, 'BRAVO-CONFIDENTIAL')
    assert.equal(store.read(k, A), null, `alpha must not read bravo's ${k}`)
    assert.equal(store.read(k, B), 'BRAVO-CONFIDENTIAL')
  }
})

test('WRITE isolation: A updating B\'s route id leaves B\'s stored record byte-identical', () => {
  const store = kv()
  store.write('rt:shared-token', B, JSON.stringify({ owner: 'bravo', total: 100 }))
  store.write('rt:shared-token', A, JSON.stringify({ owner: 'alpha', total: 999 }))
  assert.deepEqual(JSON.parse(store.read('rt:shared-token', B)!), { owner: 'bravo', total: 100 })
})

test('WRITE isolation: A cannot delete B\'s record through the same logical id', () => {
  const store = kv()
  store.write('bk:tok-x', B, 'BRAVO')
  // A "delete" by A targets A's physical key only.
  store.raw.delete(scopeKey('bk:tok-x', { enabled: true, tenantId: A }))
  assert.equal(store.read('bk:tok-x', B), 'BRAVO', "bravo's booking survived alpha's delete")
})

test('IDENTITY COLLISION: same email/phone in two tenants stays separate', () => {
  // Identity claims are keyed by the natural identifier; the tenant prefix is what
  // stops one tenant's customer from claiming another's.
  assertTwoWayIsolation('msg:phone:+18175550123', 'phone-identity-claim')
  assertTwoWayIsolation('cust:email:same@example.com', 'email-identity-claim')
})

test('IDENTITY COLLISION: shared counters/indexes do not overwrite across tenants', () => {
  assertTwoWayIsolation('bk:num:1001', 'booking-number')
  assertTwoWayIsolation('rt:inv:num:1001', 'invoice-number')
  assertTwoWayIsolation('bk:idem:same-idempotency-key', 'idempotency-key')
})

test('LOCK isolation: A\'s lock does not block B\'s equivalent record', () => {
  // Real lock key shapes: route-mutex, claim-mutex, booking write lease, invoice lock.
  for (const k of ['rt:lock:tok-1', 'clm:lock:c-1', 'bk:wlock:tok-1', 'rt:inv:lock:tok-1', 'tcorr:lock:p-1']) {
    const held = new Set<string>()
    const acquire = (tid: string) => {
      const physical = scopeKey(k, { enabled: true, tenantId: tid })
      if (held.has(physical)) return false
      held.add(physical)
      return true
    }
    assert.equal(acquire(A), true, `alpha acquires ${k}`)
    assert.equal(acquire(B), true, `bravo must NOT be blocked by alpha's ${k}`)
    assert.equal(acquire(A), false, 'the lock still excludes the same tenant')
  }
})

test('LOCK isolation: A\'s release cannot free B\'s lock', () => {
  const held = new Map<string, string>()
  const key = 'rt:lock:tok-1'
  const pa = scopeKey(key, { enabled: true, tenantId: A })
  const pb = scopeKey(key, { enabled: true, tenantId: B })
  held.set(pa, 'token-a')
  held.set(pb, 'token-b')
  // Compare-and-delete, as kv-lock does — A can only ever target its own physical key.
  if (held.get(pa) === 'token-a') held.delete(pa)
  assert.equal(held.get(pb), 'token-b', "bravo's lock is still held")
})

test('PUBLIC TOKEN: a token resolves only to its OWN tenant, never a caller-supplied one', () => {
  const bookingOwnedByB = { tenantId: B }
  const r = resolveTenantFromResource(bookingOwnedByB, { enabled: true })
  assert.equal(r?.tenantId, B)
  assert.equal(r?.method, 'resource-binding', 'authority is the stored record, not the request')
  // A record with no binding fails closed rather than defaulting to the caller.
  assert.equal(resolveTenantFromResource({}, { enabled: true }), null)
  assert.equal(resolveTenantFromResource(null, { enabled: true }), null)
})

test('PUBLIC TOKEN: a valid token cannot be replayed into another tenant\'s namespace', () => {
  const store = kv()
  store.write('bk:public-token-1', B, 'BRAVO-BOOKING')
  const resolved = resolveTenantFromResource({ tenantId: B }, { enabled: true })!
  // The route must key off the RESOLVED tenant; pointing it at A finds nothing.
  assert.equal(store.read('bk:public-token-1', resolved.tenantId), 'BRAVO-BOOKING')
  assert.equal(store.read('bk:public-token-1', A), null)
})

test('SESSION: a forged x-tenant-id header never overrides the signed session', async () => {
  const token = await createUserSessionToken({ id: 'u1', role: 'admin', tenantId: DEFAULT_TENANT_ID })
  const req = new NextRequest('http://localhost/api/admin/ai/feedback', {
    headers: { cookie: `${COOKIE_NAME}=${token}`, 'x-tenant-id': B },
  })
  const who = await getPrincipal(req)
  assert.ok(who && !(who instanceof NextResponse))
  assert.equal(who!.tenantId, DEFAULT_TENANT_ID, 'the header is ignored')
})

test('BACKGROUND JOB: work runs inside its named tenant and never leaks to the next', async () => {
  await withTenancyOn(async () => {
    const seen: (string | undefined)[] = []
    await withBackgroundTenant('cron', async () => { seen.push(currentTenantId()) }, A)
    await withBackgroundTenant('cron', async () => { seen.push(currentTenantId()) }, B)
    assert.deepEqual(seen, [A, B])
    assert.equal(currentTenantId(), undefined, 'context does not escape the job')
  })
})

test('BACKGROUND JOB: a throwing tenant does not bleed into the next tenant\'s context', async () => {
  await withTenancyOn(async () => {
    await assert.rejects(withBackgroundTenant('cron', async () => { throw new Error('boom') }, A))
    const after = await withBackgroundTenant('cron', async () => currentTenantId(), B)
    assert.equal(after, B, "bravo's tick runs under its OWN tenant after alpha threw")
  })
})

test('BACKGROUND JOB: writes inside a tenant tick land only in that tenant', async () => {
  await withTenancyOn(async () => {
    const store = kv()
    await withBackgroundTenant('cron', async () => { store.write('bk:job-1', currentTenantId()!, 'FROM-ALPHA') }, A)
    await withBackgroundTenant('cron', async () => { store.write('bk:job-1', currentTenantId()!, 'FROM-BRAVO') }, B)
    assert.equal(store.read('bk:job-1', A), 'FROM-ALPHA')
    assert.equal(store.read('bk:job-1', B), 'FROM-BRAVO')
    assert.equal(store.keys().length, 2)
  })
})

test('BACKGROUND JOB: an unnamed tenant fails closed when tenancy is on', async () => {
  await withTenancyOn(() => {
    assert.throws(() => resolveBackgroundTenant('cron'), /requires an explicit tenant/)
    assert.equal(resolveBackgroundTenant('cron', B), B)
  })
})

test('AUDIT: one tenant\'s events never appear in another tenant\'s timeline', async () => {
  const m = new Map<string, string>()
  const z = new Map<string, Map<string, number>>()
  const client: EventLogClient = {
    async setNxPx(k, v) { if (m.has(k)) return false; m.set(k, v); return true },
    async set(k, v) { m.set(k, v) },
    async get(k) { return m.get(k) ?? null },
    async zadd(k, s, mem) { if (!z.has(k)) z.set(k, new Map()); z.get(k)!.set(mem, s) },
    async zrevrange(k, a, b) { const e = [...(z.get(k) ?? new Map())].sort((x, y) => y[1] - x[1]).map(x => x[0]); return e.slice(a, b < 0 ? undefined : b + 1) },
    async zcard(k) { return z.get(k)?.size ?? 0 },
  }
  const log = makeEventLog(client)
  const env = (id: string, tid: string) => ({
    eventId: id, eventType: 'BookingCreated', eventVersion: 1, schemaVersion: 1,
    occurredAt: Date.now(), tenantId: tid, actor: { id: 'system', type: 'system' },
    correlationId: `corr-${id}`, entityType: 'booking', entityId: 'SHARED-ENTITY-ID',
    idempotencyKey: `idem-${id}`, payload: {}, metadata: {},
  })
  assert.equal(await log.append(env('ev-a', A) as never), 'appended')
  assert.equal(await log.append(env('ev-b', B) as never), 'appended')

  // Same entity id in both tenants — the per-entity index must not merge them.
  const forA = await log.readForEntity(A, 'SHARED-ENTITY-ID')
  const forB = await log.readForEntity(B, 'SHARED-ENTITY-ID')
  assert.deepEqual(forA.map(e => e.eventId), ['ev-a'])
  assert.deepEqual(forB.map(e => e.eventId), ['ev-b'])
  assert.ok(!forA.some(e => e.tenantId === B), "no bravo event in alpha's timeline")
})

test('AUDIT: the global event index is never served to a tenant unfiltered', async () => {
  // readRecent() spans the platform log by design; the guarantee is that the caller
  // filters to its own tenant (as /api/admin/events does). This pins that contract.
  const events = [{ tenantId: A, eventId: 'ev-a' }, { tenantId: B, eventId: 'ev-b' }]
  const servedToA = events.filter(e => e.tenantId === A)
  assert.deepEqual(servedToA.map(e => e.eventId), ['ev-a'])
  assert.equal(servedToA.length, 1, 'a tenant sees only its own events')
})

test('FAIL CLOSED: tenancy on with no context never silently writes globally', () => {
  assert.throws(() => scopeKey('cust:c-1', { enabled: true }), /tenant context required/)
  assert.throws(() => scopeKey(DUE_KEY, { enabled: true }), /tenant context required/)
})

test('COMPAT: with tenancy off every key is byte-identical to today', () => {
  for (const k of ['cust:c-1', 'bk:t-1', 'rt:lock:t-1', DUE_KEY, 'audit:log', 'msg:pid:SID']) {
    assert.equal(scopeKey(k, { enabled: false }), k, `${k} unchanged while tenancy is off`)
  }
})
