// ── Multi-Tenant Phase 1: authorization + isolation suite ────────────────────
//
// Exercises the Phase-1 stores end-to-end through the REAL Redis chokepoint
// (app/lib/redis.ts → scopeKey) by standing up an in-memory Upstash over a stubbed
// global fetch — the same technique as claims-integration.test.ts. Physical keys in
// the fake map ARE the isolation boundary, so cross-tenant separation is observed,
// not assumed.
//
// Coverage map (from the Phase-1 brief):
//   existing J KISS access · unauthorized tenant access · cross-tenant reads ·
//   cross-tenant writes · membership enforcement · platform-admin separation ·
//   missing tenant context · background/system context · migration + rollback ·
//   pilot (branding) behavior.

process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'
process.env.KV_REST_API_URL = 'http://fake-upstash.local'
process.env.KV_REST_API_TOKEN = 'test-token'
delete process.env.TENANCY_ENABLED // default OFF (single-tenant J KISS)
delete process.env.TENANCY_DARK_LAUNCH
delete process.env.TENANCY_DUAL_WRITE

import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

// ── in-memory Upstash keyed by PHYSICAL (scoped) key ─────────────────────────
const kv = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const z = (k: string) => zsets.get(k) ?? zsets.set(k, new Map()).get(k)!
function resetStore() {
  kv.clear()
  zsets.clear()
}

globalThis.fetch = (async (_url: string, init: { body: string }) => {
  const [cmd, ...args] = JSON.parse(init.body) as string[]
  const key = args[0]
  let result: unknown = null
  switch (cmd.toUpperCase()) {
    case 'GET': result = kv.get(key) ?? null; break
    case 'SET': kv.set(key, args[1]); result = 'OK'; break
    case 'DEL': result = kv.delete(key) ? 1 : 0; break
    case 'ZADD': z(key).set(args[2], Number(args[1])); result = 1; break
    case 'ZREM': result = z(key).delete(args[1]) ? 1 : 0; break
    case 'ZCARD': result = z(key).size; break
    case 'ZRANGE':
    case 'ZREVRANGE': {
      const sorted = [...z(key).entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0])
      if (cmd.toUpperCase() === 'ZREVRANGE') sorted.reverse()
      const start = Number(args[1]); const stop = Number(args[2])
      result = sorted.slice(start, stop === -1 ? undefined : stop + 1)
      break
    }
    default: throw new Error(`fake redis: unhandled ${cmd}`)
  }
  return { json: async () => ({ result }) }
}) as unknown as typeof fetch

// Static imports are safe: lib/redis reads env + fetch lazily inside call().
import { scopeKey } from '../app/lib/platform/tenancy/keys'
import { DEFAULT_TENANT_ID } from '../app/lib/platform/tenancy/types'
import { JKISS_TENANT } from '../app/lib/platform/tenancy/jkiss'
import { COMPANY } from '../app/lib/company'
import { withBackgroundTenant } from '../app/lib/platform/tenancy/request-context'
import { redis } from '../app/lib/redis'
import { can } from '../app/lib/rbac'
import { isPlatformOwner } from '../app/api/admin/_lib/session'
import {
  ensureReferenceTenant, listTenants, upsertTenant, activeTenantIdsFromRegistry,
} from '../app/lib/platform/tenancy/tenant-registry'
import {
  upsertMembership, ensureReferenceMembership, resolveMembership, assertMembership,
  getMembership, listTenantIdsForUser, TenantAccessDeniedError,
} from '../app/lib/platform/tenancy/membership'
import {
  getBranding, readBrandingFor, setBranding, brandingDefaultsFor,
} from '../app/lib/platform/tenancy/tenant-settings/branding-store'
import {
  type PhaseKv, buildProvisionPlan, applyPlan, verifyPlan, executeRollback,
} from './tenant-phase1/lib'

const OWNER = { sub: 'owner', role: 'admin' as const }

beforeEach(() => { resetStore(); delete process.env.TENANCY_ENABLED })

function withFlag<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.TENANCY_ENABLED
  process.env.TENANCY_ENABLED = on ? '1' : '0'
  return Promise.resolve()
    .then(fn)
    .finally(() => { if (prev === undefined) delete process.env.TENANCY_ENABLED; else process.env.TENANCY_ENABLED = prev })
}

// ── Tenant registry ───────────────────────────────────────────────────────────
test('registry: ensureReferenceTenant seeds J KISS and is idempotent', async () => {
  const a = await ensureReferenceTenant()
  assert.equal(a.id, DEFAULT_TENANT_ID)
  assert.equal(a.displayName, COMPANY.legalName)
  const b = await ensureReferenceTenant() // second call must not duplicate
  assert.deepEqual(b, a)
  const list = await listTenants()
  assert.equal(list.length, 1)
  assert.deepEqual(await activeTenantIdsFromRegistry(), [DEFAULT_TENANT_ID])
})

test('registry: activeTenantIdsFromRegistry falls back to reference when empty', async () => {
  assert.deepEqual(await activeTenantIdsFromRegistry(), [DEFAULT_TENANT_ID])
})

test('registry: a display-name id can never become a tenant boundary', async () => {
  await assert.rejects(
    () => upsertTenant({ ...JKISS_TENANT, id: 'J Kiss LLC' }),
    /invalid tenant id/,
  )
})

test('registry: records live in the platform-global keyspace (never tenant-prefixed)', () => {
  // Even with tenancy ON and a foreign tenant context, a platform key is unchanged.
  assert.equal(scopeKey('platform:tenant:jkiss', { enabled: true, tenantId: 'acme' }), 'platform:tenant:jkiss')
  assert.equal(scopeKey('platform:membership:jkiss:owner', { enabled: true, tenantId: 'acme' }), 'platform:membership:jkiss:owner')
})

// ── Membership: server-side validation ────────────────────────────────────────
test('existing J KISS access: flag OFF resolves the reference tenant for the legacy owner', async () => {
  const m = await resolveMembership('owner', DEFAULT_TENANT_ID, { enabled: false })
  assert.ok(m)
  assert.equal(m!.tenantId, DEFAULT_TENANT_ID)
  assert.equal(m!.status, 'active')
  // absent request also resolves to the reference tenant (single-tenant continuity)
  assert.ok(await resolveMembership('owner', null, { enabled: false }))
})

test('unauthorized tenant access: flag OFF denies any non-reference tenant id (client not trusted)', async () => {
  assert.equal(await resolveMembership('owner', 'acme', { enabled: false }), null)
  await assert.rejects(() => assertMembership('owner', 'acme', { enabled: false }), TenantAccessDeniedError)
})

test('membership enforcement: flag ON requires a persisted ACTIVE membership (fail closed)', async () => {
  // no membership yet
  assert.equal(await resolveMembership('owner', DEFAULT_TENANT_ID, { enabled: true }), null)
  await ensureReferenceMembership()
  const m = await resolveMembership('owner', DEFAULT_TENANT_ID, { enabled: true })
  assert.ok(m)
  assert.equal(m!.role, 'admin')
})

test('membership enforcement: non-active status (invited/suspended) is denied when ON', async () => {
  await upsertMembership({ tenantId: 'acme', userId: 'alice', role: 'admin', status: 'invited' })
  assert.equal(await resolveMembership('alice', 'acme', { enabled: true }), null)
  await upsertMembership({ tenantId: 'acme', userId: 'alice', role: 'admin', status: 'suspended' })
  assert.equal(await resolveMembership('alice', 'acme', { enabled: true }), null)
  await upsertMembership({ tenantId: 'acme', userId: 'alice', role: 'admin', status: 'active' })
  assert.ok(await resolveMembership('alice', 'acme', { enabled: true }))
})

test('unauthorized tenant access: a non-member is denied when ON', async () => {
  await upsertMembership({ tenantId: 'acme', userId: 'alice', role: 'admin', status: 'active' })
  assert.equal(await resolveMembership('mallory', 'acme', { enabled: true }), null)
  assert.equal(await getMembership('mallory', 'acme'), null)
})

test('cross-tenant: a member of one tenant cannot resolve another (ON)', async () => {
  await upsertMembership({ tenantId: 'acme', userId: 'alice', role: 'admin', status: 'active' })
  await upsertMembership({ tenantId: 'jkiss', userId: 'owner', role: 'admin', status: 'active' })
  assert.equal(await resolveMembership('alice', 'jkiss', { enabled: true }), null) // alice ∉ jkiss
  assert.deepEqual(await listTenantIdsForUser('alice'), ['acme'])
})

test('no cross-tenant identifier leaks in a denial error', async () => {
  try {
    await assertMembership('mallory', 'acme', { enabled: true })
    assert.fail('expected denial')
  } catch (e) {
    assert.ok(e instanceof TenantAccessDeniedError)
    assert.doesNotMatch((e as Error).message, /acme|mallory/) // generic message only
  }
})

// ── Platform-admin separation ─────────────────────────────────────────────────
test('platform-admin separation: a tenant admin is NOT a platform owner', () => {
  assert.equal(isPlatformOwner({ sub: 'alice', role: 'admin' }, {}), false) // tenant admin, not platform
  assert.equal(isPlatformOwner({ sub: 'owner', role: 'admin' }, {}), true) // legacy owner is the platform owner
  assert.equal(isPlatformOwner({ sub: 'alice', role: 'admin' }, { PLATFORM_OWNER_SUBS: 'alice' }), true)
  assert.equal(isPlatformOwner({ sub: 'alice', role: 'crew' }, { PLATFORM_OWNER_SUBS: 'alice' }), false)
})

// ── Pilot: branding — existing J KISS behavior (flag OFF) ─────────────────────
test('pilot: J KISS branding defaults reproduce today’s identity (flag OFF)', async () => {
  const b = await getBranding(DEFAULT_TENANT_ID)
  assert.equal(b.displayName, COMPANY.legalName)
  assert.equal(b.tagline, COMPANY.tagline)
  assert.equal(b.primaryColor, JKISS_TENANT.brand.primaryColor)
  assert.equal(b.emailFromAddress, COMPANY.emailFrom)
})

test('pilot: branding write is byte-identical key when OFF, and read-back reflects it', async () => {
  const next = await setBranding(OWNER, DEFAULT_TENANT_ID, { tagline: 'Hauling, done right' })
  assert.equal(next.tagline, 'Hauling, done right')
  // physical key is UNPREFIXED when tenancy is off
  assert.ok(kv.has('settings:branding'), 'writes to the legacy key when off')
  assert.ok(!kv.has('t:jkiss:settings:branding'))
  const read = await getBranding(DEFAULT_TENANT_ID)
  assert.equal(read.tagline, 'Hauling, done right')
})

test('pilot: junk values are sanitized (bad hex/url rejected, strings clamped)', async () => {
  const b = await setBranding(OWNER, DEFAULT_TENANT_ID, {
    primaryColor: 'red', logoUrl: 'javascript:alert(1)', displayName: 'x'.repeat(500),
  })
  assert.equal(b.primaryColor, JKISS_TENANT.brand.primaryColor) // invalid hex kept the default
  assert.equal(b.logoUrl, '') // non-http(s) url rejected
  assert.equal(b.displayName.length, 200) // clamped
})

// ── Pilot: branding — cross-tenant isolation (flag ON) ───────────────────────
test('cross-tenant WRITES land on separate physical keys (ON)', async () => {
  await withFlag(true, async () => {
    await upsertMembership({ tenantId: 'jkiss', userId: 'owner', role: 'admin', status: 'active' })
    await upsertMembership({ tenantId: 'acme', userId: 'alice', role: 'admin', status: 'active' })
    await setBranding({ sub: 'owner', role: 'admin' }, 'jkiss', { displayName: 'J KISS' })
    await setBranding({ sub: 'alice', role: 'admin' }, 'acme', { displayName: 'Acme Movers' })
    assert.ok(kv.has('t:jkiss:settings:branding'))
    assert.ok(kv.has('t:acme:settings:branding'))
    assert.notEqual(kv.get('t:jkiss:settings:branding'), kv.get('t:acme:settings:branding'))
  })
})

test('cross-tenant READ is denied for a non-member (ON)', async () => {
  await withFlag(true, async () => {
    await upsertMembership({ tenantId: 'acme', userId: 'alice', role: 'admin', status: 'active' })
    await setBranding({ sub: 'alice', role: 'admin' }, 'acme', { displayName: 'Acme' })
    await assert.rejects(
      () => readBrandingFor({ sub: 'alice', role: 'admin' }, 'jkiss'), // alice ∉ jkiss
      TenantAccessDeniedError,
    )
  })
})

test('cross-tenant WRITE is denied for a non-member (ON)', async () => {
  await withFlag(true, async () => {
    await upsertMembership({ tenantId: 'acme', userId: 'alice', role: 'admin', status: 'active' })
    await assert.rejects(
      () => setBranding({ sub: 'alice', role: 'admin' }, 'jkiss', { displayName: 'pwn' }),
      TenantAccessDeniedError,
    )
    assert.ok(!kv.has('t:jkiss:settings:branding'), 'no write leaked to the foreign tenant')
  })
})

test('RBAC: a member WITHOUT settings:manage cannot write branding (ON)', async () => {
  assert.equal(can('manager', 'settings:manage'), false) // guard precondition
  await withFlag(true, async () => {
    await upsertMembership({ tenantId: 'acme', userId: 'bob', role: 'manager', status: 'active' })
    await assert.rejects(
      () => setBranding({ sub: 'bob', role: 'manager' }, 'acme', { displayName: 'nope' }),
      /permission denied/,
    )
  })
})

// ── Missing tenant context / background context ───────────────────────────────
test('missing tenant context fails closed at the chokepoint (ON, no context)', async () => {
  await withFlag(true, async () => {
    await assert.rejects(() => redis.get('settings:branding'), /tenant context required/)
  })
})

test('background/system context: cron must name its tenant when ON, runs as reference when OFF', async () => {
  const off = await withBackgroundTenant('cron', async () => 'ran', undefined) // flag OFF (default)
  assert.equal(off, 'ran')
  await withFlag(true, async () => {
    await assert.rejects(() => withBackgroundTenant('cron', async () => 'x'), /requires an explicit tenant/)
    assert.equal(await withBackgroundTenant('cron', async () => 'ok', 'jkiss'), 'ok')
  })
})

// ── Migration + rollback tooling (pure, in-memory) ────────────────────────────
function memKv(): PhaseKv & { dump: () => Record<string, string>; zdump: () => Record<string, string[]> } {
  const m = new Map<string, string>()
  const zs = new Map<string, Map<string, number>>()
  const zk = (k: string) => zs.get(k) ?? zs.set(k, new Map()).get(k)!
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v) },
    del: async (k) => { m.delete(k) },
    zadd: async (k, s, mem) => { zk(k).set(mem, s) },
    zrem: async (k, mem) => { zk(k).delete(mem) },
    dump: () => Object.fromEntries(m),
    zdump: () => Object.fromEntries([...zs].map(([k, v]) => [k, [...v.keys()]])),
  }
}

test('migration: the plan is deterministic (two builds are identical)', () => {
  assert.deepEqual(buildProvisionPlan(), buildProvisionPlan())
})

test('migration: apply seeds all targets, verify passes, re-apply is idempotent', async () => {
  const store = memKv()
  const plan = buildProvisionPlan()
  const r1 = await applyPlan(store, plan)
  assert.equal(r1.conflicts.length, 0)
  assert.ok(r1.applied >= 4)
  assert.equal((await verifyPlan(store, plan)).ok, true)
  // records exist
  assert.ok(store.dump()['platform:tenant:jkiss'])
  assert.ok(store.dump()['platform:membership:jkiss:owner'])
  assert.ok(store.dump()['t:jkiss:settings:branding'])
  // re-apply: nothing new, no conflicts
  const r2 = await applyPlan(store, plan)
  assert.equal(r2.conflicts.length, 0)
  assert.equal(r2.applied, 3, 'only the idempotent ZADDs re-run; SETs are skipped')
  assert.equal(r2.skipped, 3)
})

test('migration: a differing existing value is a conflict, never overwritten', async () => {
  const store = memKv()
  const plan = buildProvisionPlan()
  await store.set('platform:tenant:jkiss', '{"tampered":true}')
  const r = await applyPlan(store, plan)
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].key, 'platform:tenant:jkiss')
  assert.equal(store.dump()['platform:tenant:jkiss'], '{"tampered":true}', 'existing value preserved')
})

test('rollback: removes exactly the seeded targets and leaves unrelated keys intact', async () => {
  const store = memKv()
  const plan = buildProvisionPlan()
  await store.set('bk:legacy', 'PRODUCTION-DATA') // a pre-existing legacy key
  await applyPlan(store, plan)
  await executeRollback(store, plan)
  assert.equal(store.dump()['platform:tenant:jkiss'], undefined)
  assert.equal(store.dump()['platform:membership:jkiss:owner'], undefined)
  assert.equal(store.dump()['t:jkiss:settings:branding'], undefined)
  assert.deepEqual(store.zdump()['platform:tenant:index'] ?? [], [])
  assert.equal(store.dump()['bk:legacy'], 'PRODUCTION-DATA', 'legacy data untouched')
})

test('migration: seeded branding equals the pilot defaults for J KISS', async () => {
  const store = memKv()
  const plan = buildProvisionPlan()
  await applyPlan(store, plan)
  const seeded = JSON.parse(store.dump()['t:jkiss:settings:branding'])
  assert.equal(seeded.displayName, brandingDefaultsFor(JKISS_TENANT).displayName)
  assert.equal(seeded.primaryColor, JKISS_TENANT.brand.primaryColor)
})
