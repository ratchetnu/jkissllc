// Wave F — analytics hygiene: comms aggregation + redaction, date-range bounds,
// funnel surfaced, tenant/role authorization, registry pin.
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-admin-session-secret-0123456789'

import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

import { computeCommsAnalytics, type CommsInstance } from '../app/lib/comms/analytics'
import { parseDays, windowStartMs } from '../app/lib/analytics/range'
import { FUNNEL_EVENTS } from '../app/lib/analytics-events'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'
import { createUserSessionToken, requirePermission, COOKIE_NAME } from '../app/api/admin/_lib/session'
import type { Role } from '../app/lib/rbac'

const inst = (o: Partial<CommsInstance>): CommsInstance =>
  ({ staffId: 's1', staffName: 'Alex', sentAt: 1000, requireAck: false, title: 'Ping', ...o })

// ── Comms aggregation ─────────────────────────────────────────────────────────

test('computeCommsAnalytics aggregates sent/read/ack/completion/failed + escalations', () => {
  const rows = [
    inst({ staffId: 's1', sentAt: 1000, deliveredAt: 1001, openedAt: 1002, requireAck: true, ackAt: 1000 + 300_000, completedAt: 1, reminderId: 'r1' }),
    inst({ staffId: 's1', sentAt: 2000, requireAck: false }),                       // delivered? no deliveredAt → failed
    inst({ staffId: 's2', sentAt: 3000, deliveredAt: 3001, requireAck: true, escalatedAt: [1], reminderId: 'r1' }), // delivered, not acked
  ]
  const a = computeCommsAnalytics(rows, [{ active: true }, { active: false, archived: true }], 0)
  assert.equal(a.totals.sent, 3)
  assert.equal(a.totals.opened, 1)
  assert.equal(a.totals.acked, 1)         // of 2 require-ack, 1 acked
  assert.equal(a.totals.completed, 1)
  assert.equal(a.totals.failed, 1)        // the one with no deliveredAt
  assert.equal(a.totals.escalations, 1)
  assert.equal(a.totals.ackRate, 50)
  assert.equal(a.totals.readRate, 33)
  assert.equal(a.activeReminders, 1)      // active && !archived
  assert.equal(a.mostMissed[0].reminderId, 'r1') // r1: 2 sent, 1 acked → 50% miss
})

test('the since window excludes older instances', () => {
  const rows = [inst({ sentAt: 100 }), inst({ sentAt: 5000 })]
  assert.equal(computeCommsAnalytics(rows, [], 1000).totals.sent, 1)
})

test('REDACTION: no phone / email / message body / token ever leaves the aggregation', () => {
  const dirty = [{ ...inst({ requireAck: true, ackAt: 1500 }), phone: '555-867-5309', email: 'crew@example.com', body: 'the secret message text', token: 'tok_abc123' }] as unknown as CommsInstance[]
  const out = JSON.stringify(computeCommsAnalytics(dirty, [], 0))
  for (const leak of ['555-867-5309', 'crew@example.com', 'the secret message text', 'tok_abc123']) {
    assert.ok(!out.includes(leak), `leaked ${leak}`)
  }
})

// ── Date-range bounds ─────────────────────────────────────────────────────────

test('parseDays clamps, defaults, and fails safe on malformed/oversized input', () => {
  assert.equal(parseDays('30'), 30)
  assert.equal(parseDays(null), 30)          // default
  assert.equal(parseDays('abc'), 30)         // malformed → default
  assert.equal(parseDays('0'), 30)           // non-positive → default
  assert.equal(parseDays('9999'), 180)       // clamp to max
  assert.equal(parseDays('9999', 30, 90), 90)
  assert.equal(parseDays('1.9'), 1)          // floored
  assert.ok(windowStartMs(30, 1_000_000_000) < 1_000_000_000)
})

// ── Funnel is surfaced (reader exists; producers untouched) ───────────────────

test('funnel event vocabulary is intact (producers preserved, reader now exists)', () => {
  assert.ok(FUNNEL_EVENTS.length > 0)
  assert.ok(FUNNEL_EVENTS.includes('quote_analyze_started'))
})

// ── Authorization through the real guard ──────────────────────────────────────

async function reqAs(role: Role, tenantId?: string): Promise<NextRequest> {
  const token = await createUserSessionToken({ id: role === 'admin' ? 'owner' : `u_${role}`, role, tenantId })
  return new NextRequest('http://localhost/api/admin/analytics/funnel', { headers: { cookie: `${COOKIE_NAME}=${token}` } })
}
const allowed = (x: unknown) => !(x instanceof NextResponse)

test('analytics feeds: admin + manager allowed; crew forbidden; anon unauthorized', async () => {
  for (const perm of ['comms:analytics', 'reports:view', 'ai:analytics'] as const) {
    assert.ok(allowed(await requirePermission(await reqAs('admin'), perm)), `admin ${perm}`)
    assert.ok(allowed(await requirePermission(await reqAs('manager'), perm)), `manager ${perm}`)
    assert.equal((await requirePermission(await reqAs('crew'), perm) as NextResponse).status, 403)
    assert.equal((await requirePermission(new NextRequest('http://localhost/api/admin/analytics/funnel'), perm) as NextResponse).status, 401)
  }
})

test('the signed session binds the tenant — the basis for cross-tenant isolation', async () => {
  const who = await requirePermission(await reqAs('admin', 'acme'), 'reports:view')
  assert.equal((who as { tenantId: string }).tenantId, 'acme')
})

// ── Registry pin ──────────────────────────────────────────────────────────────

test('analytics capability is full with reconciled permissions', () => {
  const a = CAPABILITY_REGISTRY['analytics']
  assert.equal(a.status, 'full')
  for (const p of ['reports:view', 'ai:analytics', 'comms:analytics']) assert.ok(a.requiredPermissions.includes(p as never), `analytics requires ${p}`)
})
