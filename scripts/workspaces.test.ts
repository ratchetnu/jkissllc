// Role-adaptive workspaces: destination integrity, persona visibility, route map.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKSPACE_DESTINATIONS, ROLE_WORKSPACES, PERSONAS, workspaceFor, ALL_DESTINATION_IDS,
} from '../app/lib/platform/workspaces/registry'
import { WORKSPACE_ROUTE_MAP, destinationGaps } from '../app/lib/platform/workspaces/route-map'
import { CAPABILITY_REGISTRY } from '../app/lib/platform/capabilities/registry'

test('all nine personas have a workspace', () => {
  assert.equal(PERSONAS.length, 9)
  for (const p of PERSONAS) assert.ok(ROLE_WORKSPACES[p])
})

test('every destination references a real capability', () => {
  for (const d of WORKSPACE_DESTINATIONS) {
    assert.ok(CAPABILITY_REGISTRY[d.capability], `destination ${d.id} → unknown capability ${d.capability}`)
  }
})

test('no persona is handed a destination it cannot access', () => {
  for (const p of PERSONAS) {
    const ws = workspaceFor(p)
    for (const d of ws.destinations) {
      assert.ok(ws.capabilities.includes(d.capability), `${p} sees ${d.id} but lacks capability ${d.capability}`)
      assert.ok(d.personas.includes(p), `${p} got ${d.id} not meant for it`)
    }
  }
})

test('crew/contractor never see money or settings; customer sees only their bookings', () => {
  for (const p of ['crew', 'contractor'] as const) {
    const ids = workspaceFor(p).destinations.map((d) => d.id)
    assert.ok(!ids.includes('money'))
    assert.ok(!ids.includes('settings'))
  }
  const customer = workspaceFor('customer').destinations.map((d) => d.id)
  assert.deepEqual(customer, ['my-bookings'])
})

test('approval authority: admins/manager yes, crew/customer no', () => {
  assert.equal(workspaceFor('administrator').approvalAuthority, true)
  assert.equal(workspaceFor('manager').approvalAuthority, true)
  assert.equal(workspaceFor('crew').approvalAuthority, false)
  assert.equal(workspaceFor('customer').approvalAuthority, false)
})

test('route map covers every destination (empty array = documented gap)', () => {
  for (const id of ALL_DESTINATION_IDS) {
    assert.ok(id in WORKSPACE_ROUTE_MAP, `route map missing destination ${id}`)
  }
  // The "customers" destination is a known gap (no first-class customer surface).
  assert.ok(destinationGaps().includes('customers'))
})
