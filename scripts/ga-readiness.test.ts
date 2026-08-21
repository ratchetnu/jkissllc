// ── Multi-tenant GA readiness projection ────────────────────────────────────
//
// The single property under test: this report cannot be talked into saying yes.
// "Update distribution works" and "tenant data is isolated" are unrelated claims,
// and the whole reason the dimensions are separate is that a single green light
// would let the first stand in for the second.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildGaReadiness, GA_DIMENSIONS, type GaReadinessInput } from '../app/lib/platform/tenancy/ga-readiness'
import { GUARDED_ENTRY_POINTS } from '../app/lib/platform/capabilities/guard'

const here = dirname(fileURLToPath(import.meta.url))

const NOW = 1_800_000_000_000

/** A deployment exactly as J KISS is today: one tenant, flag off, nothing migrated. */
const today = (over: Partial<GaReadinessInput> = {}): GaReadinessInput => ({
  now: NOW,
  flags: { tenancyEnabled: false, darkLaunch: false, dualWrite: false },
  activeTenantIds: ['jkiss'],
  tenantsWithMemberships: ['jkiss'],
  tenantsWithCapabilityProfiles: [],
  migrationMarkers: [],
  darkLaunchObservations: null,
  certification: null,
  delivery: { previewVerifiedTargets: [], productionVerifiedTargets: [], rollbackCapturedTargets: [], targetsReportingCapabilityEvidence: [] },
  optionalIntegrations: { adapterCapabilities: ['payments-stripe', 'sms-delivery', 'email-delivery'], guardedEntryPoints: [...GUARDED_ENTRY_POINTS] },
  ...over,
})

/** Everything proven — the only shape that may report GA. */
const proven = (): GaReadinessInput => ({
  ...today(),
  flags: { tenancyEnabled: true, darkLaunch: true, dualWrite: false },
  activeTenantIds: ['jkiss', 'supercharged'],
  tenantsWithMemberships: ['jkiss', 'supercharged'],
  tenantsWithCapabilityProfiles: ['jkiss', 'supercharged'],
  migrationMarkers: [
    { id: 'wave6-membership-backfill', completedAt: NOW, actor: 'owner', counts: { membershipsCreated: 4, membershipsExisting: 1 } },
    { id: 'public-token-binding-backfill', tenantId: 'jkiss', completedAt: NOW, actor: 'owner', counts: { bound: 120, conflicts: 0 } },
  ],
  darkLaunchObservations: { comparisons: 5000, mismatches: 0 },
  certification: { passed: true, unclassifiedRoutes: 0, derivedKeyFamilies: 0, unscopedBlobWrites: 0, at: NOW },
  delivery: {
    previewVerifiedTargets: ['supercharged'], productionVerifiedTargets: ['supercharged'],
    rollbackCapturedTargets: ['supercharged'], targetsReportingCapabilityEvidence: ['supercharged'],
  },
})

test('today’s deployment is NOT multi-tenant GA, and says so plainly', () => {
  const r = buildGaReadiness(today())
  assert.equal(r.gaReady, false)
  assert.equal(r.tenancyEnablementSafe, false)
  assert.match(r.summary, /Not multi-tenant GA/)
  assert.ok(r.remainingActions.length > 0)
})

test('every dimension is reported, separately, exactly once', () => {
  const r = buildGaReadiness(today())
  assert.equal(r.dimensions.length, GA_DIMENSIONS.length)
  assert.deepEqual(r.dimensions.map(d => d.id).sort(), [...GA_DIMENSIONS].sort())
  assert.equal(new Set(r.dimensions.map(d => d.id)).size, GA_DIMENSIONS.length)
})

test('every non-proven dimension names an EXACT remaining action', () => {
  const r = buildGaReadiness(today())
  for (const d of r.dimensions) {
    if (d.verdict === 'proven') { assert.equal(d.remainingAction, undefined); continue }
    assert.ok(d.remainingAction && d.remainingAction.length > 20, `${d.id} has no actionable next step`)
  }
  assert.equal(r.remainingActions.length, r.dimensions.filter(d => d.verdict !== 'proven').length)
})

test('shipping an update to a target does NOT make the platform multi-tenant', () => {
  // The exact confusion this endpoint exists to prevent: full delivery evidence,
  // and nothing whatsoever proven about tenant isolation.
  const r = buildGaReadiness(today({
    delivery: {
      previewVerifiedTargets: ['supercharged'], productionVerifiedTargets: ['supercharged'],
      rollbackCapturedTargets: ['supercharged'], targetsReportingCapabilityEvidence: ['supercharged'],
    },
  }))
  assert.equal(r.dimensions.find(d => d.id === 'update_delivery_to_preview')!.verdict, 'proven')
  assert.equal(r.dimensions.find(d => d.id === 'production_approval_verification')!.verdict, 'proven')
  assert.equal(r.dimensions.find(d => d.id === 'rollback_evidence')!.verdict, 'proven')
  // …and still:
  assert.equal(r.gaReady, false)
  assert.equal(r.tenancyEnablementSafe, false)
})

test('gaReady requires EVERY dimension — one short is still no', () => {
  assert.equal(buildGaReadiness(proven()).gaReady, true)
  for (const id of GA_DIMENSIONS) {
    const input = proven()
    // Knock out exactly one dimension's evidence and confirm the verdict flips.
    switch (id) {
      case 'redis_key_certification': input.certification = { passed: false, unclassifiedRoutes: 3, derivedKeyFamilies: 10, unscopedBlobWrites: 0 }; break
      case 'active_tenant_registry': input.activeTenantIds = ['jkiss']; break
      case 'membership_authentication_isolation': input.migrationMarkers = input.migrationMarkers.filter(m => m.id !== 'wave6-membership-backfill'); break
      case 'public_host_token_resolution': input.migrationMarkers = input.migrationMarkers.filter(m => m.id !== 'public-token-binding-backfill'); break
      case 'runtime_tenant_isolation':
      case 'blob_path_isolation':
      case 'webhook_background_tenant_resolution': input.flags = { ...input.flags, tenancyEnabled: false }; break
      case 'per_tenant_capability_configuration': input.tenantsWithCapabilityProfiles = []; break
      case 'optional_integration_independence': input.optionalIntegrations = { adapterCapabilities: [], guardedEntryPoints: [] }; break
      case 'migration_dark_launch_evidence': input.flags = { ...input.flags, darkLaunch: false, dualWrite: false }; input.darkLaunchObservations = null; break
      case 'update_delivery_to_preview': input.delivery = { ...input.delivery, previewVerifiedTargets: [] }; break
      case 'production_approval_verification': input.delivery = { ...input.delivery, productionVerifiedTargets: [] }; break
      case 'rollback_evidence': input.delivery = { ...input.delivery, rollbackCapturedTargets: [] }; break
    }
    assert.equal(buildGaReadiness(input).gaReady, false, `gaReady survived losing ${id}`)
  }
})

test('tenancyEnablementSafe is NARROWER than gaReady and never satisfied by "built"', () => {
  // Delivery fully proven, isolation merely implemented: the flag must stay unsafe.
  const r = buildGaReadiness(today({
    activeTenantIds: ['jkiss', 'supercharged'],
    delivery: { previewVerifiedTargets: ['supercharged'], productionVerifiedTargets: ['supercharged'], rollbackCapturedTargets: ['supercharged'], targetsReportingCapabilityEvidence: ['supercharged'] },
  }))
  assert.equal(r.tenancyEnablementSafe, false)

  // Even with certification passing, an un-run token backfill keeps it unsafe —
  // a public booking token with no binding is a cross-tenant read waiting to happen.
  const almost = buildGaReadiness({
    ...proven(),
    migrationMarkers: proven().migrationMarkers.filter(m => m.id !== 'public-token-binding-backfill'),
  })
  assert.equal(almost.tenancyEnablementSafe, false)
})

test('an UNRESOLVED token-binding conflict is a gap, never a completion', () => {
  const r = buildGaReadiness({
    ...proven(),
    migrationMarkers: [
      { id: 'wave6-membership-backfill', completedAt: NOW, actor: 'owner', counts: {} },
      { id: 'public-token-binding-backfill', tenantId: 'jkiss', completedAt: NOW, actor: 'owner', counts: { bound: 10, conflicts: 2 }, unresolved: ['2 token(s) are bound to a different tenant and need an operator decision'] },
    ],
  })
  const d = r.dimensions.find(x => x.id === 'public_host_token_resolution')!
  assert.equal(d.verdict, 'gap')
  assert.match(d.remainingAction!, /conflicting token bindings/)
  assert.equal(r.tenancyEnablementSafe, false)
})

test('a FAILED certification is a gap, and an UNRECORDED one is never "proven"', () => {
  const failed = buildGaReadiness(today({ certification: { passed: false, unclassifiedRoutes: 3, derivedKeyFamilies: 10, unscopedBlobWrites: 0 } }))
  const d = failed.dimensions.find(x => x.id === 'redis_key_certification')!
  assert.equal(d.verdict, 'gap')
  assert.ok(d.evidence.some(e => /FAILED/.test(e)))
  // No result at all must never read as clean.
  const unrecorded = buildGaReadiness(today({ certification: null }))
  assert.notEqual(unrecorded.dimensions.find(x => x.id === 'redis_key_certification')!.verdict, 'proven')
})

test('a single tenant is never "proven" isolation, however clean the code is', () => {
  const r = buildGaReadiness(today({ flags: { tenancyEnabled: true, darkLaunch: true, dualWrite: false } }))
  assert.equal(r.dimensions.find(d => d.id === 'active_tenant_registry')!.verdict, 'built')
  assert.equal(r.dimensions.find(d => d.id === 'blob_path_isolation')!.verdict, 'built')
  assert.equal(r.gaReady, false)
})

test('a registry DEFAULT is not counted as a tenant decision', () => {
  const r = buildGaReadiness(today({ tenantsWithCapabilityProfiles: [] }))
  const d = r.dimensions.find(x => x.id === 'per_tenant_capability_configuration')!
  assert.equal(d.verdict, 'built')
  assert.match(d.remainingAction!, /registry default/)
})

// ── The guarded-entry-point list must be true, not aspirational ──────────────

test('every entry point the projection CLAIMS is guarded really calls a guard', () => {
  for (const path of GUARDED_ENTRY_POINTS) {
    const src = readFileSync(join(here, '..', path), 'utf8')
    assert.match(
      src,
      /requireCapability|checkCapability|capabilityAvailable|requireCardPayments/,
      `${path} is listed as guarded but calls no capability guard`,
    )
  }
})

test('the projection is READ-ONLY — it cannot enable anything', () => {
  const src = readFileSync(join(here, '..', 'app', 'lib', 'platform', 'tenancy', 'ga-readiness.ts'), 'utf8')
  // The strongest available proof, and a mechanical one: its ONLY import is a type,
  // which is erased at compile time. A module that imports nothing at runtime cannot
  // read a store, call a migration, or flip a flag — whatever its remediation strings
  // happen to NAME. (Naming the migration an operator must run is the point.)
  const imports = [...src.matchAll(/^import .*$/gm)].map(m => m[0])
  assert.deepEqual(imports, ["import type { MigrationMarker } from './migration-markers'"])
  // Belt and braces for the two things reachable without an import.
  assert.ok(!src.includes('process.env'), 'the projection must take its inputs, not read the environment')
  assert.ok(!src.includes('await '), 'the projection is synchronous — nothing to await means nothing to do')
})
