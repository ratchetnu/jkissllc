// Session token identity round-trips. Verifies the security-critical invariants:
//   1. a named user token carries its role/staffId
//   2. sliding the idle window PRESERVES role/staffId (never silently escalates)
//   3. a legacy token (no subject) resolves to the implicit owner admin
// Requires ADMIN_SESSION_SECRET; set here so the HMAC signer is happy.
process.env.ADMIN_SESSION_SECRET ||= 'test-secret-at-least-16-chars-long'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSessionToken, createUserSessionToken, getPrincipalFromToken, slideSessionToken,
} from '../app/api/admin/_lib/session'

test('a crew user token resolves to the crew principal with its staffId', async () => {
  const token = await createUserSessionToken({ id: 'u_1', role: 'crew', staffId: 'staff_9' })
  const who = await getPrincipalFromToken(token)
  assert.equal(who?.sub, 'u_1')
  assert.equal(who?.role, 'crew')
  assert.equal(who?.staffId, 'staff_9')
})

test('sliding a manager token preserves role (no escalation to admin)', async () => {
  const token = await createUserSessionToken({ id: 'u_2', role: 'manager' })
  const slid = await slideSessionToken(token)
  assert.ok(slid)
  const who = await getPrincipalFromToken(slid)
  assert.equal(who?.role, 'manager', 'sliding must NOT drop the role')
  assert.equal(who?.sub, 'u_2')
})

test('a legacy token (no subject) resolves to the owner admin', async () => {
  const token = await createSessionToken()
  const who = await getPrincipalFromToken(token)
  assert.equal(who?.role, 'admin')
  assert.equal(who?.sub, 'owner')
})

test('a tampered token is rejected', async () => {
  const token = await createUserSessionToken({ id: 'u_3', role: 'crew', staffId: 's1' })
  const [payload] = token.split('.')
  const forged = `${payload}.deadbeef`
  assert.equal(await getPrincipalFromToken(forged), null)
})
