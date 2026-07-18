// Operion release model — pure tests: version math, manifest + upgrade-path planning,
// and the Status/one-action resolver. No I/O.
import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyReleaseType, isBehind, isSameVersion, normalizeVersion } from '../app/lib/platform/release/versions'
import {
  validateManifest, appliesToEdition, upgradePath, requirementsFor, estimateRisk, type ReleaseManifest,
} from '../app/lib/platform/release/manifest'
import { resolveReleaseState, STATUS_LABEL, ACTION_LABEL, type ReleaseSignals } from '../app/lib/platform/release/state'

// ── versions ──────────────────────────────────────────────────────────────────
test('versions: normalize, compare, classify', () => {
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3')
  assert.equal(isSameVersion('v1.2.3', '1.2.3'), true)
  assert.equal(isBehind('1.8.2', '2.1.0'), true)
  assert.equal(isBehind('2.1.0', '2.1.0'), false)
  assert.equal(classifyReleaseType('1.8.2', '2.0.0'), 'major')
  assert.equal(classifyReleaseType('1.8.2', '1.9.0'), 'minor')
  assert.equal(classifyReleaseType('1.8.2', '1.8.3'), 'patch')
})

// ── manifests ───────────────────────────────────────────────────────────────
const M = (v: string, min: string, over: Partial<ReleaseManifest> = {}): ReleaseManifest => ({
  version: v, minimumVersion: min, releaseType: 'minor', editions: ['*'],
  databaseMigrations: [], configurationChanges: [], requiredEnvironmentVariables: [],
  optionalEnvironmentVariables: [], featureFlags: [], moduleUpdates: [], breakingChanges: [],
  verificationChecks: [], rollbackInstructions: 'Instant rollback to previous deployment.', ...over,
})

test('manifest: validation catches malformed data', () => {
  assert.equal(validateManifest(M('v2.1.0', 'v1.8.0')).ok, true)
  assert.equal(validateManifest({ version: 'nope' }).ok, false)
  assert.equal(validateManifest(M('v1.0.0', 'v2.0.0')).ok, false) // min > version
  assert.deepEqual(
    validateManifest(M('v2.0.0', 'v1.9.0', { databaseMigrations: [{ id: 'x', description: '', reversible: true }, { id: 'x', description: '', reversible: true }] })).errors,
    ['duplicate migration ids'],
  )
})

test('manifest: upgrade path is complete and never skips a prerequisite', () => {
  const manifests = [
    M('v1.9.0', 'v1.8.0'),
    M('v2.0.0', 'v1.9.0', { releaseType: 'major', breakingChanges: ['auth cookie renamed'] }),
    M('v2.1.0', 'v2.0.0'),
  ]
  const path = upgradePath('v1.8.2', 'v2.1.0', manifests)
  assert.equal(path.ok, true)
  if (path.ok) assert.deepEqual(path.releases.map(r => r.version), ['v1.9.0', 'v2.0.0', 'v2.1.0'])
})

test('manifest: a missing prerequisite is a hard error (no skipping)', () => {
  const manifests = [M('v1.9.0', 'v1.8.0'), M('v2.1.0', 'v2.0.0')] // 2.0.0 missing
  const path = upgradePath('v1.8.2', 'v2.1.0', manifests)
  assert.equal(path.ok, false)
  if (!path.ok) assert.match(path.error, /prerequisite/)
})

test('manifest: identity path, no-path, and newer-than-target', () => {
  const manifests = [M('v1.9.0', 'v1.8.0')]
  assert.deepEqual(upgradePath('v1.9.0', 'v1.9.0', manifests), { ok: true, releases: [] })
  assert.equal(upgradePath('v1.8.0', 'v3.0.0', manifests).ok, false)
  assert.equal(upgradePath('v2.0.0', 'v1.9.0', manifests).ok, false)
})

test('manifest: edition filtering + requirements aggregation + risk', () => {
  const junk = M('v2.0.0', 'v1.9.0', { editions: ['junk-removal'], requiredEnvironmentVariables: ['STRIPE_SECRET_KEY'] })
  const all = M('v2.1.0', 'v2.0.0', { databaseMigrations: [{ id: 'm1', description: '', reversible: false }], breakingChanges: ['x'] })
  assert.equal(appliesToEdition(junk, 'moving'), false)
  assert.equal(appliesToEdition(all, 'moving'), true)
  const req = requirementsFor([junk, all])
  assert.deepEqual(req.requiredEnv, ['STRIPE_SECRET_KEY'])
  assert.equal(req.migrationCount, 1)
  assert.equal(req.irreversibleMigrations, 1)
  assert.equal(req.hasBreakingChanges, true)
  assert.equal(estimateRisk(req), 'high')
  assert.equal(estimateRisk(requirementsFor([M('v1.1.0', 'v1.0.0')])), 'low')
})

// ── resolver: one Status + one primary action ──────────────────────────────────
const base: ReleaseSignals = {
  initialized: true, installedVersion: 'v2.1.0', latestVersion: 'v2.1.0', health: 'healthy',
  updateAvailable: false, job: 'none', previewVerified: false, verificationFailed: false,
  blocking: [], driftReasons: [],
}
const S = (o: Partial<ReleaseSignals>) => resolveReleaseState({ ...base, ...o })

test('resolver: uninitialized → Set Up', () => {
  const r = S({ initialized: false })
  assert.equal(r.status, 'not_initialized'); assert.equal(r.action, 'set_up')
})

test('resolver: up to date → quiet Check', () => {
  const r = S({})
  assert.equal(r.status, 'up_to_date'); assert.equal(r.action, 'check'); assert.equal(r.tone, 'ok')
})

test('resolver: update available → the one Update action', () => {
  const r = S({ updateAvailable: true, installedVersion: 'v1.8.2', latestVersion: 'v2.1.0' })
  assert.equal(r.status, 'update_available'); assert.equal(r.action, 'update')
  assert.equal(r.installedVersion, 'v1.8.2'); assert.equal(r.latestVersion, 'v2.1.0')
})

test('resolver: in-flight → View Progress; failed → Retry', () => {
  assert.equal(S({ job: 'preview_deploying' }).action, 'view_progress')
  assert.equal(S({ job: 'verifying' }).status, 'updating')
  assert.equal(S({ job: 'failed' }).action, 'retry')
  assert.equal(S({ verificationFailed: true }).status, 'verification_failed')
})

test('resolver: preview verified / awaiting approval → Publish to Production', () => {
  assert.equal(S({ previewVerified: true }).status, 'ready_to_publish')
  assert.equal(S({ job: 'awaiting_approval' }).action, 'publish')
})

test('resolver: every drift category collapses to a single "Action required" + Resolve', () => {
  const r = S({ driftReasons: ['Configuration differs', 'A data migration is pending', 'Deployed commit differs'] })
  assert.equal(r.status, 'action_required'); assert.equal(r.action, 'resolve')
  // The specifics survive ONLY in the details panel, not the summary label.
  assert.equal(r.statusLabel, 'Action required')
  assert.equal(r.details.driftReasons.length, 3)
})

test('resolver: hard blocker + unhealthy → Resolve; update takes precedence over pure drift', () => {
  assert.equal(S({ blocking: ['GITHUB_APP_ID missing'] }).action, 'resolve')
  assert.equal(S({ health: 'down' }).status, 'action_required')
  assert.equal(S({ updateAvailable: true, driftReasons: ['config'] }).action, 'update')
})

test('resolver: external vocabulary stays tiny (labels are human, no jargon)', () => {
  const labels = [...Object.values(STATUS_LABEL), ...Object.values(ACTION_LABEL)].join(' ')
  assert.doesNotMatch(labels, /SHA|manifest|orchestrat|migration|drift|reconcil|commit/i)
})
