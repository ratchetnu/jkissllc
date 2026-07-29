// ── WAVE 6: per-tenant authentication + membership-backed sessions ───────────
//
// The property under test: a session's tenant and role come from a VALIDATED
// MEMBERSHIP, never from the request and never from a global user row. Tests assert
// the decision AND, where a store is involved, the final persisted state.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'

import {
  createUserSessionToken,
  createTenantSelectionToken,
  getPrincipal,
  getPrincipalFromToken,
  getPendingUserId,
  verifySessionToken,
  slideSessionToken,
  isPlatformOwner,
  COOKIE_NAME,
} from '../app/api/admin/_lib/session'
import {
  resolveLogin,
  toTenantChoices,
  syntheticReferenceMembership,
} from '../app/lib/platform/tenancy/login-resolution'
import { membershipId } from '../app/lib/platform/tenancy/membership'
import { DEFAULT_TENANT_ID, type Membership } from '../app/lib/platform/tenancy/types'
import type { Role } from '../app/lib/rbac'

const A = 'wave6a'
const B = 'wave6b'

const mbr = (tenantId: string, userId: string, role: Role, over: Partial<Membership> = {}): Membership => ({
  id: membershipId(tenantId, userId),
  tenantId,
  userId,
  role,
  status: 'active',
  createdAt: 0,
  ...over,
})

const reqWith = (token: string) =>
  new NextRequest('http://localhost/api/admin/x', { headers: { cookie: `${COOKIE_NAME}=${token}` } })

// ── Membership model ─────────────────────────────────────────────────────────

test('membership id is deterministic per (tenant, user) — re-provisioning cannot duplicate', () => {
  assert.equal(membershipId(A, 'u1'), membershipId(A, 'u1'))
  assert.notEqual(membershipId(A, 'u1'), membershipId(B, 'u1'), 'same user, different tenant → different membership')
  assert.notEqual(membershipId(A, 'u1'), membershipId(A, 'u2'))
})

test('membership id normalizes case so two spellings cannot become two memberships', () => {
  assert.equal(membershipId('Wave6A', 'U1'), membershipId('wave6a', 'u1'))
})

test('role is PER TENANT — the same person can be admin in one and crew in another', () => {
  const memberships = [mbr(A, 'u1', 'admin'), mbr(B, 'u1', 'crew', { staffId: 'staff-b' })]
  const choices = toTenantChoices(memberships)
  assert.deepEqual(choices, [
    { tenantId: A, role: 'admin' },
    { tenantId: B, role: 'crew' },
  ])
})

test('staff linkage is PER TENANT and never carried across', () => {
  const inA = mbr(A, 'u1', 'crew', { staffId: 'staff-in-a' })
  const inB = mbr(B, 'u1', 'crew', { staffId: 'staff-in-b' })
  assert.notEqual(inA.staffId, inB.staffId)
  const single = resolveLogin([inB], { id: 'u1', role: 'crew', staffId: 'staff-in-a' }, { tenancyEnabled: true })
  assert.equal(single.kind, 'single')
  if (single.kind === 'single') {
    assert.equal(single.membership.staffId, 'staff-in-b', "tenant B's session must not carry tenant A's staff id")
  }
})

// ── Login resolution ─────────────────────────────────────────────────────────

test('LOGIN single membership: resolves straight through, no prompt', () => {
  const r = resolveLogin([mbr(A, 'u1', 'manager')], { id: 'u1', role: 'admin' }, { tenancyEnabled: true })
  assert.equal(r.kind, 'single')
  if (r.kind === 'single') {
    assert.equal(r.membership.tenantId, A)
    assert.equal(r.membership.role, 'manager', 'the MEMBERSHIP role wins over the global user role')
  }
})

test('LOGIN multi membership: requires an explicit choice, never picks the first', () => {
  const r = resolveLogin([mbr(A, 'u1', 'admin'), mbr(B, 'u1', 'crew')], { id: 'u1', role: 'admin' }, { tenancyEnabled: true })
  assert.equal(r.kind, 'select')
  if (r.kind === 'select') assert.equal(r.choices.length, 2)
})

test('LOGIN multi membership: order of the stored list does not change the outcome', () => {
  const forward = resolveLogin([mbr(A, 'u1', 'admin'), mbr(B, 'u1', 'crew')], { id: 'u1', role: 'admin' }, { tenancyEnabled: true })
  const reverse = resolveLogin([mbr(B, 'u1', 'crew'), mbr(A, 'u1', 'admin')], { id: 'u1', role: 'admin' }, { tenancyEnabled: true })
  assert.equal(forward.kind, 'select')
  assert.equal(reverse.kind, 'select')
})

test('LOGIN inactive memberships are invisible to selection', () => {
  const r = resolveLogin(
    [mbr(A, 'u1', 'admin', { status: 'suspended' }), mbr(B, 'u1', 'crew')],
    { id: 'u1', role: 'admin' },
    { tenancyEnabled: true },
  )
  assert.equal(r.kind, 'single', 'only the active one remains')
  if (r.kind === 'single') assert.equal(r.membership.tenantId, B)
})

test('LOGIN all memberships inactive → no-membership (tenancy on), never a fallback session', () => {
  const r = resolveLogin(
    [mbr(A, 'u1', 'admin', { status: 'suspended' }), mbr(B, 'u1', 'crew', { status: 'invited' })],
    { id: 'u1', role: 'admin' },
    { tenancyEnabled: true },
  )
  assert.equal(r.kind, 'no-membership')
})

test('LOGIN no memberships + tenancy ON → denied (fail closed)', () => {
  const r = resolveLogin([], { id: 'u1', role: 'admin' }, { tenancyEnabled: true })
  assert.equal(r.kind, 'no-membership')
})

test('LEGACY COMPAT: no memberships + tenancy OFF → reference tenant with the USER\'s own role', () => {
  const crew = resolveLogin([], { id: 'u_crew', role: 'crew', staffId: 's1' }, { tenancyEnabled: false })
  assert.equal(crew.kind, 'single')
  if (crew.kind === 'single') {
    assert.equal(crew.membership.tenantId, DEFAULT_TENANT_ID)
    assert.equal(crew.membership.role, 'crew', 'a crew account must NOT be synthesized as admin')
    assert.equal(crew.membership.staffId, 's1')
  }
  const mgr = resolveLogin([], { id: 'u_mgr', role: 'manager' }, { tenancyEnabled: false })
  if (mgr.kind === 'single') assert.equal(mgr.membership.role, 'manager')
})

test('LEGACY COMPAT: the synthetic membership is the reference tenant only', () => {
  const m = syntheticReferenceMembership({ id: 'u1', role: 'admin' })
  assert.equal(m.tenantId, DEFAULT_TENANT_ID)
  assert.equal(m.status, 'active')
  assert.equal(m.id, membershipId(DEFAULT_TENANT_ID, 'u1'))
})

test('a persisted membership always beats the compatibility shim', () => {
  const r = resolveLogin([mbr(B, 'u1', 'crew')], { id: 'u1', role: 'admin' }, { tenancyEnabled: false })
  assert.equal(r.kind, 'single')
  if (r.kind === 'single') {
    assert.equal(r.membership.tenantId, B, 'never silently redirected to the reference tenant')
    assert.equal(r.membership.role, 'crew')
  }
})

test('the selection list exposes ONLY the user\'s own memberships and no internals', () => {
  const choices = toTenantChoices([mbr(A, 'u1', 'admin'), mbr(B, 'u1', 'crew', { status: 'suspended' })])
  assert.deepEqual(choices, [{ tenantId: A, role: 'admin' }], 'suspended tenant is not offered')
  for (const c of choices) {
    assert.deepEqual(Object.keys(c).sort(), ['role', 'tenantId'], 'no membership id, no user id')
  }
})

// ── Session claims ───────────────────────────────────────────────────────────

test('SESSION carries the tenant, membership id, role and staff id from the membership', async () => {
  const token = await createUserSessionToken({ id: 'u1', role: 'crew', staffId: 's-b', tenantId: B, membershipId: membershipId(B, 'u1') })
  const who = await getPrincipal(reqWith(token))
  assert.ok(who)
  assert.equal(who!.tenantId, B)
  assert.equal(who!.role, 'crew')
  assert.equal(who!.staffId, 's-b')
  assert.equal(who!.membershipId, membershipId(B, 'u1'))
})

test('SESSION tenant cannot be overridden by a header or a body', async () => {
  const token = await createUserSessionToken({ id: 'u1', role: 'admin', tenantId: A, membershipId: membershipId(A, 'u1') })
  const req = new NextRequest('http://localhost/api/admin/x', {
    method: 'POST',
    headers: { cookie: `${COOKIE_NAME}=${token}`, 'x-tenant-id': B, 'x-tenant': B },
    body: JSON.stringify({ tenantId: B }),
  })
  const who = await getPrincipal(req)
  assert.equal(who!.tenantId, A, 'the signed claim wins over every request-supplied value')
})

test('SESSION a tampered tenant claim invalidates the signature', async () => {
  const token = await createUserSessionToken({ id: 'u1', role: 'admin', tenantId: A })
  const [payload, sig] = token.split('.')
  const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
  decoded.tid = B
  const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url')
  assert.equal(await getPrincipalFromToken(`${forgedPayload}.${sig}`), null, 'forged tenant is rejected outright')
})

test('SESSION a tampered ROLE claim invalidates the signature', async () => {
  const token = await createUserSessionToken({ id: 'u1', role: 'crew', tenantId: A })
  const [payload, sig] = token.split('.')
  const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
  decoded.role = 'admin'
  const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url')
  assert.equal(await getPrincipalFromToken(`${forged}.${sig}`), null)
})

test('SESSION sliding preserves tenant, membership, role and staff id', async () => {
  const token = await createUserSessionToken({ id: 'u1', role: 'manager', staffId: 's1', tenantId: B, membershipId: membershipId(B, 'u1') })
  const slid = await slideSessionToken(token)
  assert.ok(slid)
  const who = await getPrincipalFromToken(slid)
  assert.equal(who!.tenantId, B)
  assert.equal(who!.role, 'manager')
  assert.equal(who!.membershipId, membershipId(B, 'u1'))
})

test('PLATFORM OWNER behaviour is preserved and is not granted by a tenant claim', async () => {
  assert.equal(isPlatformOwner({ sub: 'owner', role: 'admin' }, {}), true)
  assert.equal(isPlatformOwner({ sub: 'u1', role: 'admin' }, {}), false, 'a tenant admin is not a platform owner')
  assert.equal(isPlatformOwner({ sub: 'u1', role: 'admin' }, { PLATFORM_OWNER_SUBS: 'u1' }), true)
  assert.equal(isPlatformOwner({ sub: 'owner', role: 'crew' }, {}), false)
})

test('LEGACY tokens without a tenant claim still resolve to the reference tenant', async () => {
  const token = await createUserSessionToken({ id: 'u1', role: 'admin' })
  const who = await getPrincipalFromToken(token)
  assert.equal(who!.tenantId, DEFAULT_TENANT_ID, 'pre-Wave-6 sessions keep working')
})

// ── Pending selection token ──────────────────────────────────────────────────

test('PENDING token is NOT a session — it satisfies no authorization guard', async () => {
  const pending = await createTenantSelectionToken('u1')
  assert.equal(await getPrincipal(reqWith(pending)), null, 'getPrincipal refuses it')
  assert.equal(await getPrincipalFromToken(pending), null)
  assert.equal(await verifySessionToken(pending), false, 'requireSession refuses it')
})

test('PENDING token identifies the user for the selection step only', async () => {
  const pending = await createTenantSelectionToken('u1')
  assert.equal(await getPendingUserId(reqWith(pending)), 'u1')
})

test('PENDING token cannot be slid into a real session', async () => {
  const pending = await createTenantSelectionToken('u1')
  assert.equal(await slideSessionToken(pending), null)
})

test('a real session is NOT mistaken for a pending one', async () => {
  const real = await createUserSessionToken({ id: 'u1', role: 'admin', tenantId: A })
  assert.equal(await getPendingUserId(reqWith(real)), null)
  assert.ok(await getPrincipal(reqWith(real)))
})

test('an unsigned/forged pending flag is rejected', async () => {
  const forged = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + 60000, sub: 'u1', pend: 1 })).toString('base64url')
  assert.equal(await getPendingUserId(reqWith(`${forged}.not-a-signature`)), null)
})

// ── Tenant switching (decision layer) ────────────────────────────────────────

test('SWITCH a tenant the user is not a member of is not offered', () => {
  const mine = [mbr(A, 'u1', 'admin')]
  const choices = toTenantChoices(mine)
  assert.ok(!choices.some((c) => c.tenantId === B), "a non-member tenant never appears in the user's own list")
})

test('SWITCH the destination role/staff come from the destination membership', async () => {
  const dest = mbr(B, 'u1', 'crew', { staffId: 'staff-b' })
  const token = await createUserSessionToken({
    id: dest.userId, role: dest.role, staffId: dest.staffId, tenantId: dest.tenantId, membershipId: dest.id,
  })
  const who = await getPrincipalFromToken(token)
  assert.equal(who!.tenantId, B)
  assert.equal(who!.role, 'crew', "the previous tenant's admin role does not survive the switch")
  assert.equal(who!.staffId, 'staff-b')
})

// ── Cross-tenant isolation at the session layer ──────────────────────────────

test('two users in two tenants never produce interchangeable sessions', async () => {
  const ta = await createUserSessionToken({ id: 'ua', role: 'admin', tenantId: A, membershipId: membershipId(A, 'ua') })
  const tb = await createUserSessionToken({ id: 'ub', role: 'admin', tenantId: B, membershipId: membershipId(B, 'ub') })
  const wa = await getPrincipalFromToken(ta)
  const wb = await getPrincipalFromToken(tb)
  assert.notEqual(wa!.tenantId, wb!.tenantId)
  assert.notEqual(wa!.membershipId, wb!.membershipId)
  assert.notEqual(ta, tb)
})

test("one tenant's session token cannot be re-pointed at another tenant by editing the cookie", async () => {
  const ta = await createUserSessionToken({ id: 'ua', role: 'admin', tenantId: A })
  const mangled = ta.replace(/^[^.]+/, (p) => {
    const d = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())
    d.tid = B
    return Buffer.from(JSON.stringify(d)).toString('base64url')
  })
  assert.equal(await getPrincipalFromToken(mangled), null)
})
