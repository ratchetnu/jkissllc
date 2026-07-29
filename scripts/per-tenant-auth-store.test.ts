// ── WAVE 6: store-backed membership + directory tests ────────────────────────
//
// These exercise the REAL modules against the REAL Upstash REST contract, using the
// loopback KV emulator (scripts/local-audit/kv-emulator.mjs) started by this file.
// Nothing here can reach a remote store: the emulator binds 127.0.0.1 and the base
// URL is set before any app module is imported.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test, { before, after } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  upsertMembership, getMembership, listMembershipsForUser, listActiveMembershipsForUser,
  resolveMembership, removeMembership, membershipId,
} from '../app/lib/platform/tenancy/membership'
import { createUser, getUserByEmail, listUsers, backfillUserDirectory } from '../app/lib/users'
import { runWave6Backfill } from '../app/lib/platform/tenancy/wave6-migration'
import { redis } from '../app/lib/redis'
import { DEFAULT_TENANT_ID } from '../app/lib/platform/tenancy/types'

// A high, per-run port so concurrent test runs cannot collide.
const PORT = 6400 + (process.pid % 500)
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}`
process.env.KV_REST_API_TOKEN = 'emulator-accepts-anything'

let kv: ChildProcess | null = null

before(async () => {
  kv = spawn(process.execPath, ['scripts/local-audit/kv-emulator.mjs', '--port', String(PORT)], {
    stdio: 'ignore',
    detached: false,
  })
  // Wait for the emulator's health endpoint rather than a fixed sleep.
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/__admin/health`)
      if (r.ok) return
    } catch { /* not up yet */ }
    await sleep(50)
  }
  throw new Error('kv emulator did not start')
})

after(() => { kv?.kill('SIGKILL') })

// Static imports are safe here: app/lib/redis.ts reads KV_REST_API_* lazily inside
// each call, not at module load, so the assignments above are in force by the time
// any test body runs.

const A = 'wave6a'
const B = 'wave6b'

// ── Membership persistence ───────────────────────────────────────────────────

test('STORE: a user can hold memberships in two tenants with different roles', async () => {
  await upsertMembership({ tenantId: A, userId: 'u_multi', role: 'admin' })
  await upsertMembership({ tenantId: B, userId: 'u_multi', role: 'crew', staffId: 'staff-b' })

  const all = await listMembershipsForUser('u_multi')
  assert.equal(all.length, 2)
  assert.deepEqual(all.map((m) => `${m.tenantId}:${m.role}`), [`${A}:admin`, `${B}:crew`])
  assert.equal((await getMembership('u_multi', B))?.staffId, 'staff-b')
  assert.equal((await getMembership('u_multi', A))?.staffId, undefined, "tenant A did not inherit B's staff id")
})

test('STORE: upsert is idempotent — no duplicate membership for the same pair', async () => {
  await upsertMembership({ tenantId: A, userId: 'u_dup', role: 'manager' })
  await upsertMembership({ tenantId: A, userId: 'u_dup', role: 'manager' })
  await upsertMembership({ tenantId: A, userId: 'u_dup', role: 'manager' })
  const all = await listMembershipsForUser('u_dup')
  assert.equal(all.length, 1, 'three upserts produced exactly one membership')
  assert.equal(all[0].id, membershipId(A, 'u_dup'))
})

test('STORE: an inactive membership is excluded from the login-eligible set', async () => {
  await upsertMembership({ tenantId: A, userId: 'u_susp', role: 'admin', status: 'suspended' })
  await upsertMembership({ tenantId: B, userId: 'u_susp', role: 'crew', status: 'active' })
  const active = await listActiveMembershipsForUser('u_susp')
  assert.deepEqual(active.map((m) => m.tenantId), [B])
})

test('STORE: resolveMembership grants only where an ACTIVE membership exists', async () => {
  await upsertMembership({ tenantId: A, userId: 'u_res', role: 'admin' })
  const opts = { enabled: true }
  assert.ok(await resolveMembership('u_res', A, opts), 'own tenant granted')
  assert.equal(await resolveMembership('u_res', B, opts), null, 'foreign tenant denied')
  assert.equal(await resolveMembership('u_nobody', A, opts), null, 'unknown user denied')
})

test('STORE: suspending a membership revokes access on the very next check', async () => {
  await upsertMembership({ tenantId: A, userId: 'u_rev', role: 'admin', status: 'active' })
  assert.ok(await resolveMembership('u_rev', A, { enabled: true }))
  await upsertMembership({ tenantId: A, userId: 'u_rev', role: 'admin', status: 'suspended' })
  assert.equal(await resolveMembership('u_rev', A, { enabled: true }), null, 'revocation is immediate')
})

test('STORE: a demotion in the store is visible immediately (token role must not win)', async () => {
  await upsertMembership({ tenantId: A, userId: 'u_demo', role: 'admin' })
  assert.equal((await resolveMembership('u_demo', A, { enabled: true }))?.role, 'admin')
  await upsertMembership({ tenantId: A, userId: 'u_demo', role: 'crew' })
  assert.equal((await resolveMembership('u_demo', A, { enabled: true }))?.role, 'crew')
})

test('STORE: removing a membership clears the record and both indexes', async () => {
  await upsertMembership({ tenantId: A, userId: 'u_rm', role: 'admin' })
  await removeMembership('u_rm', A)
  assert.equal(await getMembership('u_rm', A), null)
  assert.deepEqual(await listMembershipsForUser('u_rm'), [], 'index entry removed too')
})

test('STORE: a forged/name-derived tenant id can never resolve', async () => {
  assert.equal(await resolveMembership('u_multi', 'J Kiss LLC', { enabled: true }), null)
  assert.equal(await resolveMembership('u_multi', 'jkissllc.com', { enabled: true }), null)
  assert.equal(await resolveMembership('u_multi', '', { enabled: true }), null)
})

test('STORE: memberships live in the PLATFORM keyspace, never tenant-prefixed', async () => {
  await upsertMembership({ tenantId: A, userId: 'u_key', role: 'admin' })
  const direct = await redis.get(`platform:membership:${A}:u_key`)
  assert.ok(direct, 'readable at the platform-global key')
})

// ── User directory + Wave 6 backfill ─────────────────────────────────────────

test('DIRECTORY: a new user is findable by email with no tenant context', async () => {
  await createUser({ email: 'Dir.User@Example.com', name: 'Dir', role: 'manager', password: 'pw-not-a-real-secret-1' })
  const found = await getUserByEmail('dir.user@example.com')
  assert.ok(found, 'login can find the account before any tenant is known')
  assert.equal(found!.role, 'manager')
})

test('DIRECTORY: the account is written to the PLATFORM keyspace', async () => {
  const u = await getUserByEmail('dir.user@example.com')
  assert.ok(await redis.get(`platform:user:${u!.id}`), 'platform copy exists')
  assert.ok(await redis.get(`platform:user:email:dir.user@example.com`), 'platform email index exists')
})

test('DIRECTORY: a legacy-only account is still found, before any backfill runs', async () => {
  // Simulate a pre-Wave-6 row: legacy keys only.
  const legacyUser = {
    id: 'u_legacyonly', email: 'legacy@example.com', name: 'Legacy', role: 'crew',
    passwordHash: 'pbkdf2$1$AA==$AA==', staffId: 's-legacy', active: true, createdAt: 1, updatedAt: 1,
  }
  await redis.set(`user:${legacyUser.id}`, JSON.stringify(legacyUser))
  await redis.set('user:email:legacy@example.com', legacyUser.id)
  await redis.zadd('user:index', 1, legacyUser.id)

  const found = await getUserByEmail('legacy@example.com')
  assert.ok(found, 'no Production lockout: the legacy key is still read')
  assert.equal(found!.id, 'u_legacyonly')
})

test('BACKFILL: copies legacy accounts into the platform directory, idempotently', async () => {
  const first = await backfillUserDirectory()
  assert.ok(first.copied >= 1, 'the legacy-only account was copied')
  assert.ok(await redis.get('platform:user:u_legacyonly'))

  const second = await backfillUserDirectory()
  assert.equal(second.copied, 0, 're-running copies nothing new')
})

test('BACKFILL: seeds a reference membership per account using its OWN role', async () => {
  const report = await runWave6Backfill()
  assert.ok(report.memberships.created >= 1)
  assert.equal(report.ownerSeeded, true, 'the legacy owner is seeded too')

  const legacyMembership = await getMembership('u_legacyonly', DEFAULT_TENANT_ID)
  assert.ok(legacyMembership)
  assert.equal(legacyMembership!.role, 'crew', 'a crew account is NOT promoted to admin by the migration')
  assert.equal(legacyMembership!.staffId, 's-legacy', 'the roster link is preserved')
  assert.equal(legacyMembership!.status, 'active')

  const owner = await getMembership('owner', DEFAULT_TENANT_ID)
  assert.equal(owner?.role, 'admin')
})

test('BACKFILL: re-running never overwrites a deliberately changed membership', async () => {
  // An operator promotes the legacy crew account after the first migration.
  await upsertMembership({ tenantId: DEFAULT_TENANT_ID, userId: 'u_legacyonly', role: 'manager' })
  const again = await runWave6Backfill()
  assert.equal(again.memberships.created, 0, 'nothing re-created')
  assert.equal((await getMembership('u_legacyonly', DEFAULT_TENANT_ID))?.role, 'manager', 'the change survived')
})

test('BACKFILL: a dry run writes nothing', async () => {
  await createUser({ email: 'dry@example.com', name: 'Dry', role: 'crew', password: 'pw-not-a-real-secret-2' })
  const before = await getMembership((await getUserByEmail('dry@example.com'))!.id, DEFAULT_TENANT_ID)
  assert.equal(before, null)
  const report = await runWave6Backfill({ dryRun: true })
  assert.equal(report.dryRun, true)
  assert.ok(report.memberships.created >= 1, 'it REPORTS what it would do')
  const after = await getMembership((await getUserByEmail('dry@example.com'))!.id, DEFAULT_TENANT_ID)
  assert.equal(after, null, 'but wrote nothing')
})

test('every account in the directory can log in after the migration', async () => {
  await runWave6Backfill()
  const users = await listUsers(1000)
  assert.ok(users.length >= 3)
  for (const u of users) {
    const m = await getMembership(u.id, DEFAULT_TENANT_ID)
    assert.ok(m, `${u.email} has a membership — no lockout`)
    assert.equal(m!.status, 'active')
  }
})
