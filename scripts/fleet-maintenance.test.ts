// Wave H — fleet maintenance: additive model, deterministic status engine, service
// history, out-of-service enforcement, maintenance.flag evaluation, authorization.
process.env.ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || 'test-admin-session-secret-0123456789'

import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest, NextResponse } from 'next/server'

import {
  deriveMaintenanceStatus, isOperational, computeNextDueAt, addServiceEvent, setSchedule,
  setOutOfService, returnToService, evaluateFleetFlags, fleetSummary, DUE_SOON_DAYS,
  type EquipmentMaintenance,
} from '../app/lib/fleet/maintenance'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'
import { createUserSessionToken, requirePermission, COOKIE_NAME } from '../app/api/admin/_lib/session'
import type { Role } from '../app/lib/rbac'

const NOW = Date.UTC(2026, 2, 15)
const DAY = 86_400_000
const eqM = (m?: EquipmentMaintenance) => ({ maintenance: m })

// ── Legacy compatibility + status engine ──────────────────────────────────────

test('legacy equipment (no maintenance field) is valid → unknown, still operational', () => {
  assert.equal(deriveMaintenanceStatus({}, NOW), 'unknown')
  assert.equal(deriveMaintenanceStatus(eqM({}), NOW), 'unknown') // empty schedule
  assert.equal(isOperational({ active: true }), true)
})

test('status engine: out-of-service ALWAYS wins, then overdue, inspection, due-soon, current', () => {
  // out-of-service beats an otherwise-overdue schedule
  assert.equal(deriveMaintenanceStatus(eqM({ outOfService: true, nextDueAt: NOW - DAY }), NOW), 'out_of_service')
  assert.equal(isOperational({ active: true, maintenance: { outOfService: true } }), false)
  // overdue by date and by miles
  assert.equal(deriveMaintenanceStatus(eqM({ nextDueAt: NOW - DAY }), NOW), 'overdue')
  assert.equal(deriveMaintenanceStatus(eqM({ nextDueMiles: 10_000, lastOdometer: 10_000 }), NOW), 'overdue')
  // inspection required (no overdue service)
  assert.equal(deriveMaintenanceStatus(eqM({ inspectionDueAt: NOW - DAY }), NOW), 'inspection_required')
  // due soon (date within threshold, miles within threshold)
  assert.equal(deriveMaintenanceStatus(eqM({ nextDueAt: NOW + 7 * DAY }), NOW), 'due_soon')
  assert.equal(deriveMaintenanceStatus(eqM({ nextDueMiles: 10_000, lastOdometer: 9_600 }), NOW), 'due_soon')
  // current (comfortably ahead)
  assert.equal(deriveMaintenanceStatus(eqM({ nextDueAt: NOW + 60 * DAY }), NOW), 'current')
  // threshold edge: exactly DUE_SOON_DAYS out is still due_soon
  assert.equal(deriveMaintenanceStatus(eqM({ nextDueAt: NOW + DUE_SOON_DAYS * DAY }), NOW), 'due_soon')
})

test('invalid/negative inputs are ignored, never mislabeled', () => {
  // negative interval → no derivation → unknown (not overdue)
  assert.equal(deriveMaintenanceStatus(eqM({ intervalDays: -5, lastServiceAt: NOW }), NOW), 'unknown')
  // negative odometer dropped → mile rule can't fire
  assert.equal(deriveMaintenanceStatus(eqM({ nextDueMiles: 100, lastOdometer: -50 }), NOW), 'current')
  assert.equal(computeNextDueAt({ lastServiceAt: NOW, intervalDays: 90 }), NOW + 90 * DAY)
  assert.equal(computeNextDueAt({ intervalDays: 90 }), undefined) // no baseline
})

// ── Service history + idempotency ─────────────────────────────────────────────

test('addServiceEvent appends, advances lastService, recomputes; replay is idempotent', () => {
  const m0: EquipmentMaintenance = { intervalDays: 90 }
  const m1 = addServiceEvent(m0, { id: 'sv1', at: NOW, kind: 'service', odometer: 50_000 })
  assert.equal(m1.history?.length, 1)
  assert.equal(m1.lastServiceAt, NOW)
  assert.equal(m1.lastOdometer, 50_000)
  assert.equal(deriveMaintenanceStatus({ maintenance: m1 }, NOW), 'current') // NOW+90d
  // replay the SAME event id → no change
  const m2 = addServiceEvent(m1, { id: 'sv1', at: NOW + 1000, kind: 'service' })
  assert.equal(m2.history?.length, 1)
  assert.equal(m2.lastServiceAt, NOW)
  // a genuinely new event appends
  assert.equal(addServiceEvent(m1, { id: 'sv2', at: NOW + DAY, kind: 'repair' }).history?.length, 2)
})

test('setSchedule only touches provided fields; out/return-to-service toggle', () => {
  const m = setSchedule({ intervalMiles: 5000 }, { intervalDays: 30 }, 'owner', NOW)
  assert.equal(m.intervalDays, 30)
  assert.equal(m.intervalMiles, 5000)          // preserved (not in patch)
  assert.equal(m.updatedBy, 'owner')
  const oos = setOutOfService(m, 'brakes', 'owner', NOW)
  assert.equal(oos.outOfService, true)
  assert.equal(deriveMaintenanceStatus({ maintenance: oos }, NOW), 'out_of_service')
  assert.equal(returnToService(oos, 'owner', NOW).outOfService, false)
})

// ── maintenance.flag evaluation ───────────────────────────────────────────────

test('evaluateFleetFlags flags only overdue / inspection / out-of-service', () => {
  const fleet = [
    { id: 'a', name: 'A', maintenance: { nextDueAt: NOW - DAY } },          // overdue
    { id: 'b', name: 'B', maintenance: { inspectionDueAt: NOW - DAY } },    // inspection
    { id: 'c', name: 'C', maintenance: { outOfService: true } },           // oos
    { id: 'd', name: 'D', maintenance: { nextDueAt: NOW + 60 * DAY } },     // current — NOT flagged
    { id: 'e', name: 'E' },                                                 // unknown — NOT flagged
  ]
  const flags = evaluateFleetFlags(fleet, NOW)
  assert.deepEqual(flags.map(f => f.equipmentId).sort(), ['a', 'b', 'c'])
  const sum = fleetSummary(fleet, NOW)
  assert.equal(sum.overdue, 1); assert.equal(sum.inspection_required, 1); assert.equal(sum.out_of_service, 1)
  assert.equal(sum.current, 1); assert.equal(sum.unknown, 1)
})

// ── Authorization (equipment:view read, fleet:maintenance mutate) ─────────────

async function reqAs(role: Role, tenantId?: string): Promise<NextRequest> {
  const token = await createUserSessionToken({ id: role === 'admin' ? 'owner' : `u_${role}`, role, tenantId })
  return new NextRequest('http://localhost/api/admin/fleet/maintenance', { headers: { cookie: `${COOKIE_NAME}=${token}` } })
}
const allowed = (x: unknown) => !(x instanceof NextResponse)

test('fleet guards: read (equipment:view) + mutate (fleet:maintenance) — admin+manager ok, crew 403, anon 401', async () => {
  for (const perm of ['equipment:view', 'fleet:maintenance'] as const) {
    assert.ok(allowed(await requirePermission(await reqAs('admin'), perm)))
    assert.ok(allowed(await requirePermission(await reqAs('manager'), perm)))
    assert.equal((await requirePermission(await reqAs('crew'), perm) as NextResponse).status, 403)
    assert.equal((await requirePermission(new NextRequest('http://localhost/api/admin/fleet/maintenance'), perm) as NextResponse).status, 401)
  }
})

test('signed session binds the tenant (cross-tenant isolation basis)', async () => {
  const who = await requirePermission(await reqAs('admin', 'acme'), 'equipment:view')
  assert.equal((who as { tenantId: string }).tenantId, 'acme')
})

// ── Registry pin ──────────────────────────────────────────────────────────────

test('fleet capability is full with maintenance permissions; automations unchanged', () => {
  const f = CAPABILITY_REGISTRY['fleet']
  assert.equal(f.status, 'full')
  for (const p of ['equipment:assign', 'equipment:view', 'fleet:maintenance']) assert.ok(f.requiredPermissions.includes(p as never), `fleet requires ${p}`)
  assert.equal(CAPABILITY_REGISTRY['automations'].status, 'partial') // narrow executor, NOT a general engine
})
