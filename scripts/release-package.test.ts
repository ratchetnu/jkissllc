import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateReleasePackageReadiness, type ReleasePackageDraft } from '../app/lib/platform/release/release-package'
import type { PlatformBusiness, PlatformUpdate, ReleasePackage } from '../app/lib/platform/updates/types'

const now = 1_800_000_000_000
const business: PlatformBusiness = {
  recordVersion: 1, id: 'supercharged', name: 'Supercharged', slug: 'supercharged',
  role: 'target', status: 'active', defaultBranch: 'main', releaseChannel: 'stable',
  updatePolicy: 'owner_approval', updatesPaused: false, manualApprovalRequired: true,
  autoDeployAllowed: false, healthStatus: 'healthy', currentVersion: '1.2.0',
  baselineSource: 'adopted', createdAt: now - 1000, updatedAt: now - 500,
}
const update: PlatformUpdate = {
  recordVersion: 1, key: 'UPD-2001', title: 'Crew workflow', summary: 'Crew workflow',
  type: 'feature', scope: 'platform_core', severity: 'medium', priority: 'normal',
  status: 'approved', sourceBusinessId: 'jkiss', breakingChange: false,
  migrationRequired: false, environmentChangeRequired: false, secretRequired: false,
  featureFlagRequired: false, manualPortRequired: false, rollbackSupported: true,
  validation: {
    typecheck: 'passed', lint: 'passed', tests: 'passed', build: 'passed',
    securityReview: 'passed', accessibilityReview: 'passed', e2e: 'passed',
    smokeTest: 'passed', ownerVerification: 'passed',
  },
  createdAt: now - 1000, updatedAt: now - 500,
}
const draft: ReleasePackageDraft = {
  targetProduct: 'supercharged', proposedVersion: '1.3.0', channel: 'stable',
  classification: 'capability', breakingChange: false, migration: 'none',
  updateKeys: ['UPD-2001'],
}
const ready = (overrides: Partial<Parameters<typeof evaluateReleasePackageReadiness>[0]> = {}) =>
  evaluateReleasePackageReadiness({
    draft, business, updates: [update], existingPackages: [], now, ...overrides,
  })

test('valid package receives a normalized version and evidence snapshot', () => {
  const result = ready()
  assert.equal(result.ok, true)
  assert.equal(result.normalizedVersion, '1.3.0')
  assert.equal(result.snapshot?.previousVersion, '1.2.0')
  assert.equal(result.snapshot?.baselineSource, 'adopted')
})

test('unknown baseline fails closed', () => {
  const result = ready({ business: { ...business, currentVersion: undefined, baselineSource: 'unknown' } })
  assert.equal(result.ok, false)
  assert.equal(result.versionPolicy.reason, 'baseline_required')
})

test('a legacy version without verified provenance is not a baseline', () => {
  const result = ready({ business: { ...business, baselineSource: undefined } })
  assert.equal(result.ok, false)
  assert.match(result.blockers.join(' '), /no verified provenance/)
})

test('capability cannot use a patch bump', () => {
  const result = ready({ draft: { ...draft, proposedVersion: '1.2.1' } })
  assert.equal(result.ok, false)
  assert.equal(result.versionPolicy.reason, 'capability_requires_minor')
})

test('breaking release requires a major bump', () => {
  const result = ready({ draft: { ...draft, proposedVersion: '1.3.0', breakingChange: true } })
  assert.equal(result.ok, false)
  assert.equal(result.versionPolicy.reason, 'breaking_change_requires_major')
})

test('an active duplicate for the same target and channel is refused', () => {
  const duplicate: ReleasePackage = {
    recordVersion: 1, id: 'RPK-1000', ...draft, status: 'ready_for_approval',
    blockingReasons: [], createdBy: 'owner', createdAt: now - 10, updatedAt: now - 10,
  }
  const result = ready({ existingPackages: [duplicate] })
  assert.equal(result.ok, false)
  assert.equal(result.duplicatePolicy.reason, 'duplicate_version')
})

test('same version on another target or channel does not collide', () => {
  const other: ReleasePackage = {
    recordVersion: 1, id: 'RPK-1000', ...draft, targetProduct: 'jkiss',
    status: 'ready_for_approval', blockingReasons: [], createdBy: 'owner',
    createdAt: now - 10, updatedAt: now - 10,
  }
  assert.equal(ready({ existingPackages: [other] }).ok, true)
  assert.equal(ready({ existingPackages: [{ ...other, targetProduct: 'supercharged', channel: 'beta' }] }).ok, true)
})

test('missing, duplicate, or ineligible updates block readiness', () => {
  assert.equal(ready({ draft: { ...draft, updateKeys: [] } }).ok, false)
  assert.equal(ready({ draft: { ...draft, updateKeys: ['UPD-2001', 'UPD-2001'] } }).ok, false)
  assert.equal(ready({ updates: [] }).ok, false)
  const failed = { ...update, validation: { ...update.validation, tests: 'failed' as const } }
  assert.match(ready({ updates: [failed] }).blockers.join(' '), /tests not passed/)
})

test('routes enforce owner auth and readiness is persisted through the atomic store gate', () => {
  const createRoute = readFileSync('app/api/admin/platform/releases/route.ts', 'utf8')
  const readyRoute = readFileSync('app/api/admin/platform/releases/[id]/route.ts', 'utf8')
  const store = readFileSync('app/lib/platform/updates/store.ts', 'utf8')
  assert.match(createRoute, /requirePlatformOwner/)
  assert.match(readyRoute, /requirePlatformOwner/)
  assert.match(readyRoute, /evaluateReleasePackageReadiness/)
  assert.match(readyRoute, /saveReadyReleasePackage/)
  assert.match(store, /decodedBusiness\.updatedAt/)
  assert.match(store, /holder and holder ~= ARGV\[2\]/)
  assert.match(store, /proposedVersion\.split\('\+', 1\)/)
})
