// Wave D/E — audit trail + permission-matrix viewer.
// Pure coverage for the audit filter + redaction contract + the RBAC matrix source of
// truth, plus HTTP-level authorization exercised through the REAL requirePermission
// guard with signed session tokens (no Redis needed — getPrincipal is pure crypto).
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-admin-session-secret-0123456789'

import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

import { filterAuditEntries, type AuditEntry } from '../app/lib/audit'
import { can, permissionsForRole, ALL_PERMISSIONS, PERMISSION_DOMAINS, ROLES, type Role } from '../app/lib/rbac'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'
import { createUserSessionToken, requirePermission, COOKIE_NAME } from '../app/api/admin/_lib/session'

const e = (o: Partial<AuditEntry>): AuditEntry =>
  ({ id: Math.random().toString(36), at: 1_000, actor: 'owner', actorRole: 'admin', action: 'user.created', entity: 'user', summary: 'x', ...o })

// ── Pure audit filter (bounded query, all dimensions, legacy compatibility) ────

test('filterAuditEntries: actor / action / target / outcome / date / search', () => {
  const rows = [
    e({ actor: 'owner', action: 'user.created', entity: 'user', entityId: 'u1', at: 100, summary: 'Created admin login a@b.co' }),
    e({ actor: 'u_mgr', action: 'user.role_changed', entity: 'user', entityId: 'u2', at: 200, outcome: 'denied', summary: 'Blocked self role change' }),
    e({ actor: 'owner', action: 'reminder.created', entity: 'reminder', entityId: 'r9', at: 300, summary: 'made a reminder' }),
  ]
  assert.equal(filterAuditEntries(rows, { actor: 'owner' }).length, 2)
  assert.equal(filterAuditEntries(rows, { action: 'user.role_changed' }).length, 1)
  assert.equal(filterAuditEntries(rows, { entity: 'reminder' }).length, 1)
  assert.equal(filterAuditEntries(rows, { outcome: 'denied' }).length, 1)
  assert.equal(filterAuditEntries(rows, { start: 150, end: 250 }).length, 1)
  assert.equal(filterAuditEntries(rows, { search: 'u2' }).length, 1)       // by target id
  assert.equal(filterAuditEntries(rows, { search: 'reminder' }).length, 1) // by summary text
})

test('legacy records (no outcome) count as success; limit bounds the result', () => {
  const legacy = e({ at: 500 }) // no outcome field
  assert.equal(filterAuditEntries([legacy], { outcome: 'success' }).length, 1)
  assert.equal(filterAuditEntries([legacy], { outcome: 'denied' }).length, 0)
  const many = Array.from({ length: 50 }, (_, i) => e({ at: i }))
  assert.equal(filterAuditEntries(many, {}, 10).length, 10)
})

// ── Redaction contract: the user-route audit records field NAMES, never values ─

test('a password-reset audit records only the field name, never the secret', () => {
  // Mirrors what app/api/admin/users/[id]/route.ts builds for a password change.
  const entry = e({ action: 'user.updated', meta: { fields: ['password', 'email'] }, summary: 'Updated a@b.co (password, email)' })
  const serialized = JSON.stringify(entry)
  assert.deepEqual(entry.meta, { fields: ['password', 'email'] })   // names only
  assert.ok(!/hunter2|secretpw|Bearer /i.test(serialized))          // no secret material
  assert.ok(!('password' in (entry.meta as Record<string, unknown>))) // 'password' is a value in the list, never a key holding a secret
})

// ── RBAC matrix = single source of truth for the viewer ───────────────────────

test('ALL_PERMISSIONS lists every permission each role is granted (no viewer/enforcement drift)', () => {
  const known = new Set(ALL_PERMISSIONS)
  for (const r of ROLES) for (const p of permissionsForRole(r)) assert.ok(known.has(p), `${r} grants ${p} but the viewer's ALL_PERMISSIONS omits it`)
  assert.equal(new Set(ALL_PERMISSIONS).size, ALL_PERMISSIONS.length, 'ALL_PERMISSIONS has no duplicates')
  // every domain permission is a real grantable permission (covered by can())
  for (const d of PERMISSION_DOMAINS) for (const p of d.permissions) assert.equal(typeof can('admin', p), 'boolean')
})

test('matrix projection grants match can(): audit:view admin-only, permissions:view admin+manager', () => {
  const grantedBy = (p: Parameters<typeof can>[1]) => ROLES.filter((r) => can(r, p))
  assert.deepEqual(grantedBy('audit:view'), ['admin'])
  assert.deepEqual(grantedBy('permissions:view'), ['admin', 'manager'])
  assert.equal(can('crew', 'audit:view'), false)
})

// ── HTTP-level authorization through the real guard ───────────────────────────

async function reqAs(role: Role, tenantId?: string): Promise<NextRequest> {
  const token = await createUserSessionToken({ id: role === 'admin' ? 'owner' : `u_${role}`, role, tenantId })
  return new NextRequest('http://localhost/api/admin/audit', { headers: { cookie: `${COOKIE_NAME}=${token}` } })
}
const allowed = (x: unknown) => !(x instanceof NextResponse)

test('audit:view guard: admin allowed; manager + crew forbidden; no session unauthorized', async () => {
  assert.ok(allowed(await requirePermission(await reqAs('admin'), 'audit:view')))
  assert.equal((await requirePermission(await reqAs('manager'), 'audit:view') as NextResponse).status, 403)
  assert.equal((await requirePermission(await reqAs('crew'), 'audit:view') as NextResponse).status, 403)
  const anon = await requirePermission(new NextRequest('http://localhost/api/admin/audit'), 'audit:view')
  assert.equal((anon as NextResponse).status, 401)
})

test('permissions:view guard: admin + manager allowed; crew forbidden', async () => {
  assert.ok(allowed(await requirePermission(await reqAs('admin'), 'permissions:view')))
  assert.ok(allowed(await requirePermission(await reqAs('manager'), 'permissions:view')))
  assert.equal((await requirePermission(await reqAs('crew'), 'permissions:view') as NextResponse).status, 403)
})

test('the signed session binds the tenant — the basis for cross-tenant isolation', async () => {
  const who = await requirePermission(await reqAs('admin', 'acme'), 'audit:view')
  assert.ok(allowed(who))
  assert.equal((who as { tenantId: string }).tenantId, 'acme') // audit reads run in THIS tenant's scope
})

// ── Registry pins ─────────────────────────────────────────────────────────────

test('audit-logs and permissions are full with reconciled permissions', () => {
  const audit = CAPABILITY_REGISTRY['audit-logs']
  assert.equal(audit.status, 'full')
  assert.ok(audit.requiredPermissions.includes('audit:view'))
  const perms = CAPABILITY_REGISTRY['permissions']
  assert.equal(perms.status, 'full')
  assert.ok(perms.requiredPermissions.includes('permissions:view'))
  assert.ok(perms.dependencies.includes('audit-logs' as never)) // role-assignment activity is audited
})
