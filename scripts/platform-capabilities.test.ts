// Capability registry: integrity, role visibility, tenant enablement, AI eligibility.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CAPABILITY_IDS } from '../app/lib/platform/capabilities/types'
import { CAPABILITY_REGISTRY, allCapabilities } from '../app/lib/platform/capabilities/registry'
import { validateCapabilityRegistry } from '../app/lib/platform/capabilities/validate'
import {
  capabilitiesForRole, isCapabilityEnabledForTenant, aiEligibleCapabilities,
} from '../app/lib/platform/capabilities'

test('registry is structurally valid (deps resolve, no cycles, keys match ids)', () => {
  assert.deepEqual(validateCapabilityRegistry(), [])
})

test('every declared capability id has an entry', () => {
  for (const id of CAPABILITY_IDS) assert.ok(CAPABILITY_REGISTRY[id], `missing ${id}`)
  assert.equal(allCapabilities().length, CAPABILITY_IDS.length)
})

test('role visibility: crew sees crew surfaces but not the management workspace', () => {
  const crew = capabilitiesForRole('crew').map((c) => c.id)
  assert.ok(crew.includes('crew-portal'))
  assert.ok(crew.includes('availability'))
  assert.ok(!crew.includes('management-workspace'), 'crew must not see the ops workspace')
})

test('tenant enablement: jkiss uses core caps; an unknown tenant gets nothing yet', () => {
  assert.equal(isCapabilityEnabledForTenant('routes', { id: 'jkiss' }), true)
  assert.equal(isCapabilityEnabledForTenant('bookings', { id: 'jkiss' }), true)
  assert.equal(isCapabilityEnabledForTenant('routes', { id: 'acme' }), false)
  // A planned-but-absent capability is not enabled even for jkiss.
  assert.equal(isCapabilityEnabledForTenant('expenses', { id: 'jkiss' }), false)
})

test('AI-eligible capabilities each declare at least one AI action', () => {
  const eligible = aiEligibleCapabilities()
  assert.ok(eligible.length > 0)
  for (const c of eligible) assert.ok(c.aiActions.length > 0)
})

test('dependency example resolves (memberships → organizations, roles)', () => {
  assert.deepEqual(CAPABILITY_REGISTRY['memberships'].dependencies.sort(), ['identity', 'organizations', 'roles'])
})

// ── Verified-reality corrections (Wave A) — pin them so the registry cannot silently
// drift back to the pre-audit descriptions. Each assertion mirrors an audited fact. ──

test('gps-verification is partial: capture + admin-review UI ship; geofence verification is the remaining gap', () => {
  assert.equal(CAPABILITY_REGISTRY['gps-verification'].status, 'partial')
})

test('reporting and analytics declare the permissions their routes actually enforce', () => {
  const reporting = CAPABILITY_REGISTRY['reporting'].requiredPermissions
  assert.ok(reporting.includes('reports:view'), 'reporting read is gated reports:view (Wave G reconciled the claims report to reports:view; claims:manage stays on the claims capability)')
  const analytics = CAPABILITY_REGISTRY['analytics'].requiredPermissions
  assert.ok(
    analytics.includes('reports:view') && analytics.includes('ai:analytics') && analytics.includes('comms:analytics'),
    'analytics routes enforce reports:view + ai:analytics + comms:analytics',
  )
})

test('audited dependency corrections are present', () => {
  const jobs = CAPABILITY_REGISTRY['jobs'].dependencies
  assert.ok(jobs.includes('workforce') && jobs.includes('equipment'), 'jobs joins the workforce + equipment lanes')
  assert.ok(CAPABILITY_REGISTRY['audit-logs'].dependencies.includes('identity'), 'audit attribution needs identity')
  assert.ok(CAPABILITY_REGISTRY['automations'].dependencies.includes('messaging'), 'reminders deliver via messaging')
  assert.ok(CAPABILITY_REGISTRY['reporting'].dependencies.includes('bookings'), 'reporting reads bookings')
})

test('integrity: every declared dependency resolves to a real capability', () => {
  const ids = new Set<string>(CAPABILITY_IDS)
  for (const c of allCapabilities()) {
    for (const dep of c.dependencies) assert.ok(ids.has(dep), `${c.id} → unknown dependency "${dep}"`)
  }
})
