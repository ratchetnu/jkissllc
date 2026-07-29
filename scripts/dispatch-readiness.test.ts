import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import type { Assignee, RouteRecord } from '../app/lib/routes'
import {
  deriveDispatchReadiness,
  isDispatchReady,
  syncDispatchReadiness,
  toPublicRouteFor,
} from '../app/lib/routes'

const crew = (overrides: Partial<Assignee> = {}): Assignee => ({
  staffId: 'staff-1',
  name: 'Alex',
  token: 'assignee-token-123',
  confirmedAt: 10,
  ...overrides,
})

const route = (overrides: Partial<RouteRecord> = {}): RouteRecord => ({
  token: 'route-token-1234',
  routeNumber: 'JK-R-2001',
  status: 'confirmed',
  businessName: 'Warehouse',
  reportAddress: '1 Main St',
  reportTime: '7:00 AM',
  routeDate: '2026-07-30',
  assignees: [crew()],
  events: [],
  audit: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

test('dispatch readiness is distinct from crew acceptance', () => {
  const r = route({ requiresVehicle: true })
  assert.equal(r.status, 'confirmed')
  assert.equal(deriveDispatchReadiness(r), 'needs_equipment')
  assert.equal(isDispatchReady(r), false)
})

test('a confirmed route with required equipment is ready', () => {
  const r = route({ requiresVehicle: true, equipmentId: 'eq-1' })
  assert.equal(deriveDispatchReadiness(r), 'ready')
  assert.equal(isDispatchReady(r), true)
})

test('a route that legitimately needs no company asset can be ready', () => {
  const r = route({ requiresVehicle: undefined })
  assert.equal(deriveDispatchReadiness(r), 'ready')
})

test('crew gaps and unanswered assignments have explicit states', () => {
  assert.equal(deriveDispatchReadiness(route({ assignees: [] })), 'needs_crew')
  assert.equal(
    deriveDispatchReadiness(route({ status: 'assigned', assignees: [crew({ confirmedAt: undefined })] })),
    'awaiting_crew',
  )
})

test('declined crew do not count as an accepted dispatch team', () => {
  assert.equal(
    deriveDispatchReadiness(route({ status: 'declined', assignees: [crew({ confirmedAt: undefined, declinedAt: 10 })] })),
    'needs_crew',
  )
})

test('terminal routes have a closed readiness state', () => {
  for (const status of ['cancelled', 'completed', 'no_show'] as const) {
    assert.equal(deriveDispatchReadiness(route({ status })), 'closed')
  }
})

test('sync stamps a real state transition once and is idempotent', () => {
  const r = route({ requiresVehicle: true, dispatchReadiness: 'needs_equipment', dispatchReadinessUpdatedAt: 25 })
  syncDispatchReadiness(r, 100)
  assert.equal(r.dispatchReadinessUpdatedAt, 25)
  r.equipmentId = 'eq-1'
  syncDispatchReadiness(r, 200)
  assert.equal(r.dispatchReadiness, 'ready')
  assert.equal(r.dispatchReadinessUpdatedAt, 200)
  syncDispatchReadiness(r, 300)
  assert.equal(r.dispatchReadinessUpdatedAt, 200)
})

test('public projection exposes a safe readiness summary, not internal state', () => {
  const r = route({ requiresVehicle: true })
  const pub = toPublicRouteFor(r, r.assignees![0])
  assert.equal(pub.dispatchReady, false)
  assert.equal(pub.dispatchHold, 'equipment')
  assert.equal('dispatchReadiness' in pub, false)
  assert.equal('dispatchReadinessUpdatedAt' in pub, false)
})

test('owner assignment texts are blocked server-side while equipment is missing', () => {
  const src = readFileSync(new URL('../app/api/admin/routes/[id]/route.ts', import.meta.url), 'utf8')
  const sendBranch = src.slice(src.indexOf("action === 'send'"), src.indexOf("action === 'status'"))
  assert.match(sendBranch, /needsVehicleAssignment\(route\)/)
  assert.match(sendBranch, /DISPATCH_BLOCKED_MESSAGE/)
  assert.ok(sendBranch.indexOf('needsVehicleAssignment(route)') < sendBranch.indexOf('sendAssignmentText'))
})

test('owner UI exposes the rule and disables assignment texts consistently', () => {
  const src = readFileSync(new URL('../app/admin/operations/[token]/page.tsx', import.meta.url), 'utf8')
  assert.match(src, /Vehicle\/equipment required before dispatch/)
  assert.match(src, /requiresVehicle: e\.target\.checked/)
  assert.match(src, /busy !== '' \|\| equipmentBlocked/)
})

test('crew confirmation remains successful but explains the equipment wait', () => {
  const api = readFileSync(new URL('../app/api/route/[token]/route.ts', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../app/route/[token]/page.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(api, /needsVehicleAssignment/)
  assert.match(page, /your spot is confirmed/)
  assert.match(page, /assigning the required equipment/)
  assert.match(page, /you do not need to confirm again/)
})
