// Security hardening (pure): CSPRNG reminder ack token + attributed route audit.
// Webhook/cron fail-closed behavior lives in scripts/webhook-cron-auth.test.ts
// (it invokes route handlers, kept isolated).
import assert from 'node:assert/strict'
import test from 'node:test'

import { newAckToken } from '../app/lib/reminders'
import { pushAudit, pushAuditFor, type AuditEntry } from '../app/lib/routes'

test('reminder ack token is CSPRNG hex (not predictable Math.random base36)', () => {
  const t = newAckToken()
  assert.match(t, /^[a-f0-9]{64}$/, 'should be 256-bit hex')
  const many = new Set(Array.from({ length: 200 }, () => newAckToken()))
  assert.equal(many.size, 200, 'tokens must be unique across draws')
})

test('attributed audit records WHICH named user acted (H3)', () => {
  const r: { audit: AuditEntry[] } = { audit: [] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pushAuditFor(r as any, { sub: 'u_7', role: 'manager' }, 'admin', 'confirmed route')
  assert.equal(r.audit.length, 1)
  assert.equal(r.audit[0].actorId, 'u_7')
  assert.equal(r.audit[0].actorRole, 'manager')
  assert.equal(r.audit[0].actor, 'admin')
})

test('legacy pushAudit remains coarse (backward-compatible)', () => {
  const r: { audit: AuditEntry[] } = { audit: [] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pushAudit(r as any, 'admin', 'legacy action')
  assert.equal(r.audit[0].actor, 'admin')
  assert.equal(r.audit[0].actorId, undefined, 'unattributed by design until migrated')
})
