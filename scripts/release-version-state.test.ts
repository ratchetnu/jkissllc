// Release Center version accuracy — a product may not be called "behind" when its own
// installed baseline is unknown.
//
// Regression origin: the Supercharged card read "Current version —" beside "A newer version
// (0.1.0) is available", and the activity list filled with five identical "Update available"
// rows, one per 15-minute reconcile pass. Both came from trusting a platform-sync
// updateAvailable flag while currentBaselineVersion was empty.
import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveVersionState, isBehind } from '../app/lib/platform/release/versions'
import { resolveReleaseState, STATUS_LABEL, statusTone } from '../app/lib/platform/release/state'
import { dedupeConsecutive } from '../app/lib/platform/release/projection'
import { deriveBusinessProvenance } from '../app/lib/platform/automation/finalize'
import type { ReleaseSignals } from '../app/lib/platform/release/state'

const signals = (over: Partial<ReleaseSignals> = {}): ReleaseSignals => ({
  initialized: true, health: 'healthy', updateAvailable: false, job: 'none',
  previewVerified: false, verificationFailed: false, blocking: [], driftReasons: [], ...over,
})

// ── The rule ─────────────────────────────────────────────────────────────────

test('SUPERCHARGED REGRESSION: unknown installed version can never become update_available', () => {
  // Exactly the production shape: no installed baseline, a known latest, sync shouting "behind".
  const v = deriveVersionState({ installed: undefined, latest: '0.1.0', initialized: true })
  assert.equal(v.kind, 'version_unknown')
  assert.equal(v.updateAvailable, false, 'must not claim behind without a baseline')
  // Whitespace is not a baseline either.
  assert.equal(deriveVersionState({ installed: '   ', latest: '0.1.0', initialized: true }).kind, 'version_unknown')
})

test('unknown renders distinct copy and neutral styling — never the update-available badge', () => {
  const s = resolveReleaseState(signals({ versionKnown: false, installedVersion: undefined, latestVersion: '0.1.0' }))
  assert.equal(s.status, 'version_unknown')
  assert.equal(s.statusLabel, 'Version unknown')
  assert.notEqual(s.statusLabel, STATUS_LABEL.update_available)
  // Must not borrow the attention tone that made the false claim look authoritative.
  assert.equal(statusTone('version_unknown'), 'neutral')
  assert.notEqual(statusTone('version_unknown'), statusTone('update_available'))
  // No installed version is fabricated.
  assert.equal(s.installedVersion, '—')
  // The action is a check, never an update.
  assert.equal(s.action, 'check')
})

test('known-older shows update available; known-level shows current', () => {
  const behind = deriveVersionState({ installed: '0.0.9', latest: '0.1.0', initialized: true })
  assert.equal(behind.kind, 'update_available')
  assert.equal(behind.updateAvailable, true)
  const level = deriveVersionState({ installed: '0.1.0', latest: '0.1.0', initialized: true })
  assert.equal(level.kind, 'current')
  assert.equal(level.updateAvailable, false)
  // …and the resolver still reaches the real update state for a known-behind product.
  assert.equal(resolveReleaseState(signals({ updateAvailable: true, versionKnown: true })).status, 'update_available')
})

test('not-installed and incompatible are distinct from unknown, and none claim an update', () => {
  assert.equal(deriveVersionState({ installed: undefined, latest: '0.1.0', initialized: false }).kind, 'not_installed')
  assert.equal(deriveVersionState({ installed: '0.0.9', latest: '0.1.0', incompatible: true }).kind, 'incompatible')
  for (const k of ['not_installed', 'incompatible', 'version_unknown'] as const) {
    const v = k === 'not_installed' ? deriveVersionState({ initialized: false })
      : k === 'incompatible' ? deriveVersionState({ installed: '0.0.9', latest: '0.1.0', incompatible: true })
      : deriveVersionState({ latest: '0.1.0', initialized: true })
    assert.equal(v.updateAvailable, false, `${k} must not claim an update`)
  }
})

test('isBehind is unchanged — the fix is in the state derivation, not the comparison', () => {
  assert.equal(isBehind('0.0.9', '0.1.0'), true)
  assert.equal(isBehind('0.1.0', '0.1.0'), false)
  assert.equal(isBehind(undefined, '0.1.0'), false)
})

// ── Activity noise ───────────────────────────────────────────────────────────

test('an unchanged state does not repeat — five identical passes collapse to one row', () => {
  const rows = [
    { at: 5, label: 'Version unknown' }, { at: 4, label: 'Version unknown' },
    { at: 3, label: 'Version unknown' }, { at: 2, label: 'Version unknown' },
    { at: 1, label: 'Version unknown' },
  ]
  const out = dedupeConsecutive(rows)
  assert.equal(out.length, 1)
  assert.equal(out[0].at, 5, 'keeps the newest of the run')
})

test('genuine changes are still shown — dedupe collapses runs, not history', () => {
  const out = dedupeConsecutive([
    { at: 5, label: 'Update available' }, { at: 4, label: 'Up to date' },
    { at: 3, label: 'Up to date' }, { at: 2, label: 'Check didn’t complete' },
  ])
  assert.deepEqual(out.map(r => r.label), ['Update available', 'Up to date', 'Check didn’t complete'])
})

// ── Display accuracy is independent of update eligibility ────────────────────

test('display state does not gate the Update action — a real eligible update still updates', () => {
  // versionKnown:false only downgrades the DISPLAY; a genuine updateAvailable still wins,
  // so an eligible update is never hidden by an unknown baseline.
  const s = resolveReleaseState(signals({ updateAvailable: true, versionKnown: false }))
  assert.equal(s.status, 'update_available')
  assert.equal(s.action, 'update')
})

// ── How a version legitimately becomes known ─────────────────────────────────

test('a verified deployment WITH a release version writes both version fields', () => {
  const p = deriveBusinessProvenance({
    facts: { commit: 'abc1234', verifiedAt: 1000 } as never,
    releaseVersion: '0.1.0',
  })
  assert.equal(p.currentVersion, '0.1.0')
  assert.equal(p.latestVerifiedVersion, '0.1.0')
  assert.equal(p.baselineSource, 'installed_by_release')
  assert.equal(p.currentCommit, 'abc1234')
})

test('no release version ⇒ no version is invented, even on a verified deployment', () => {
  // This is why Supercharged is unknown: its commit provenance can advance while the
  // version stays absent. The fix must NOT backfill a version from a commit.
  const p = deriveBusinessProvenance({ facts: { commit: 'abc1234', verifiedAt: 1000 } as never })
  assert.equal(p.currentVersion, undefined)
  assert.equal(p.latestVerifiedVersion, undefined)
  assert.equal(p.currentCommit, 'abc1234', 'commit provenance still advances')
  // …and an unknown version keeps the honest display state.
  assert.equal(deriveVersionState({ installed: p.currentVersion, latest: '0.1.0', initialized: true }).kind, 'version_unknown')
})

test('omitting versionKnown preserves existing behaviour (backward compatible)', () => {
  assert.equal(resolveReleaseState(signals({})).status, 'up_to_date')
  assert.equal(resolveReleaseState(signals({ updateAvailable: true })).status, 'update_available')
})
