// RBAC + password + session-principal security tests. Pure functions / crypto only
// — no Redis. Guards the authorization foundation the Crew Portal and admin
// surface both depend on.
import assert from 'node:assert/strict'
import test from 'node:test'

import { hashPassword, verifyPassword, passwordPolicyError } from '../app/lib/password'
import { can, isRole, isStaffRole, ROLES, type Permission } from '../app/lib/rbac'

// ── password hashing ─────────────────────────────────────────────────────────
test('hashPassword produces a self-describing pbkdf2 string that verifies', async () => {
  const hash = await hashPassword('correct horse battery staple')
  assert.match(hash, /^pbkdf2\$\d+\$[^$]+\$[^$]+$/)
  assert.equal(await verifyPassword('correct horse battery staple', hash), true)
})

test('verifyPassword rejects the wrong password', async () => {
  const hash = await hashPassword('s3cret-password')
  assert.equal(await verifyPassword('S3cret-password', hash), false)
  assert.equal(await verifyPassword('', hash), false)
})

test('two hashes of the same password differ (random salt) but both verify', async () => {
  const a = await hashPassword('same-password-123')
  const b = await hashPassword('same-password-123')
  assert.notEqual(a, b)
  assert.equal(await verifyPassword('same-password-123', a), true)
  assert.equal(await verifyPassword('same-password-123', b), true)
})

test('verifyPassword never throws on malformed stored hashes', async () => {
  for (const bad of ['', 'garbage', 'pbkdf2$notanumber$x$y', 'a$b$c', null, undefined]) {
    assert.equal(await verifyPassword('whatever', bad as string), false)
  }
})

test('passwordPolicyError enforces a minimum length', () => {
  assert.ok(passwordPolicyError('short'))
  assert.equal(passwordPolicyError('longenough'), null)
})

// ── role guards ──────────────────────────────────────────────────────────────
test('isRole / isStaffRole classify correctly', () => {
  assert.equal(isRole('admin'), true)
  assert.equal(isRole('owner'), false)
  assert.equal(isStaffRole('admin'), true)
  assert.equal(isStaffRole('manager'), true)
  assert.equal(isStaffRole('crew'), false)
  assert.equal(isStaffRole(undefined), false)
})

// ── RBAC matrix: the spec's explicit boundaries ──────────────────────────────
test('admin holds every operational/management permission', () => {
  // self:* are crew-portal-only (an admin is not a crew member and has no staffId),
  // so they are intentionally excluded from the admin grant.
  const perms: Permission[] = [
    'routes:manage', 'crew:assign', 'crew:manage', 'claims:create', 'users:manage',
    'roles:manage', 'pay:configure', 'pay:approve', 'tax:view', 'profitability:view',
    'settings:manage', 'audit:view', 'accounts:suspend', 'reports:view', 'crew:score:view',
  ]
  for (const p of perms) assert.equal(can('admin', p), true, `admin missing ${p}`)
  void ROLES
})

test('managers get operations but NOT the admin-only sensitive actions', () => {
  // allowed (operational)
  for (const p of ['routes:manage', 'crew:assign', 'crew:score:view', 'claims:create', 'reports:view', 'pay:adjust:submit'] as Permission[]) {
    assert.equal(can('manager', p), true, `manager should have ${p}`)
  }
  // denied (the spec's "Managers should NOT" list)
  for (const p of ['roles:manage', 'users:manage', 'settings:manage', 'pay:configure', 'pay:approve', 'tax:view', 'profitability:view', 'integrations:manage', 'accounts:suspend'] as Permission[]) {
    assert.equal(can('manager', p), false, `manager must NOT have ${p}`)
  }
})

test('crew are limited to self-service permissions only', () => {
  for (const p of ['self:view', 'self:availability', 'self:timeoff', 'self:timeclock', 'self:pay:request'] as Permission[]) {
    assert.equal(can('crew', p), true, `crew should have ${p}`)
  }
  for (const p of ['routes:manage', 'crew:view', 'pay:view:all', 'claims:create', 'reports:view', 'users:manage'] as Permission[]) {
    assert.equal(can('crew', p), false, `crew must NOT have ${p}`)
  }
})

test('crew cannot see the internal Crew Score', () => {
  assert.equal(can('crew', 'crew:score:view'), false)
  assert.equal(can('manager', 'crew:score:view'), true)
  assert.equal(can('admin', 'crew:score:view'), true)
})
