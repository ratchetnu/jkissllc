// Operion release — semantic version policy (Increment 1). Pure: no store, no records,
// no write path. These pin the rules a release version must satisfy BEFORE any package,
// baseline, or installation record exists.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  parseSemanticVersion, isValidSemanticVersion, formatSemanticVersion,
  compareSemanticVersions, compareVersionStrings, bumpKind, channelSupportsPrerelease,
  requiredBumpFor, evaluateVersionBump, findDuplicateVersion, displayReleaseVersion,
} from '../app/lib/platform/release/semver-policy'
import { parseVersion, compareVersions } from '../app/lib/platform/updates/policy'
import { deriveVersionState } from '../app/lib/platform/release/versions'

const v = (s: string) => {
  const r = parseSemanticVersion(s)
  if (!r.ok) throw new Error(`fixture ${s} should parse`)
  return r.version
}

// ── Parsing ──────────────────────────────────────────────────────────────────

test('valid semantic versions parse and normalize', () => {
  assert.equal(parseSemanticVersion('0.2.0').ok, true)
  assert.equal(parseSemanticVersion('v1.2.3').ok, true)
  assert.equal(formatSemanticVersion(v('v1.2.3')), '1.2.3', 'the leading v is normalized away')
  assert.equal(formatSemanticVersion(v('1.0.0-rc.1')), '1.0.0-rc.1')
  assert.equal(formatSemanticVersion(v('1.0.0+build.5')), '1.0.0+build.5')
  assert.equal(parseSemanticVersion('0.0.0').ok, true, '0.0.0 is a legal version — it is just never fabricated')
  // Surrounding whitespace on an otherwise-valid version is trimmed, not rejected — a
  // pasted value should normalize. Whitespace-ONLY is still invalid (covered below).
  assert.equal(parseSemanticVersion(' 1.2.3 ').ok, true)
  assert.equal(formatSemanticVersion(v(' 1.2.3 ')), '1.2.3')
})

test('invalid input is REJECTED, never coerced', () => {
  for (const bad of ['', '   ', '1', '1.2', 'v1', 'abc', '1.2.3.4', '01.0.0', '1.02.0', '1.0.0-', '1.0.0-01', '-1.0.0', '1 .0.0', null, undefined, 42 as unknown as string]) {
    const r = parseSemanticVersion(bad as string)
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not parse`)
    assert.equal(r.ok === false && r.reason, 'invalid_format')
  }
  // Note the contrast with the LENIENT legacy parser, which is intentionally unchanged.
  assert.notEqual(parseVersion('1.2'), null, 'legacy parser still accepts partial versions')
  assert.equal(isValidSemanticVersion('1.2'), false, 'strict layer does not')
})

// ── Ordering ─────────────────────────────────────────────────────────────────

test('ordering is deterministic across major/minor/patch', () => {
  assert.equal(compareSemanticVersions(v('1.0.0'), v('2.0.0')), -1)
  assert.equal(compareSemanticVersions(v('1.2.0'), v('1.1.9')), 1)
  assert.equal(compareSemanticVersions(v('1.1.1'), v('1.1.1')), 0)
  assert.equal(compareVersionStrings('0.2.0', '0.2.1'), -1)
})

test('prerelease precedence follows SemVer 2.0 (and the legacy comparator does NOT)', () => {
  assert.equal(compareSemanticVersions(v('1.0.0-rc.1'), v('1.0.0')), -1, 'a prerelease is older than its release')
  assert.equal(compareSemanticVersions(v('1.0.0-alpha'), v('1.0.0-beta')), -1)
  assert.equal(compareSemanticVersions(v('1.0.0-alpha.1'), v('1.0.0-alpha.2')), -1)
  assert.equal(compareSemanticVersions(v('1.0.0-alpha'), v('1.0.0-alpha.1')), -1, 'fewer identifiers rank lower')
  assert.equal(compareSemanticVersions(v('1.0.0-1'), v('1.0.0-alpha')), -1, 'numeric ranks below alphanumeric')
  assert.equal(compareSemanticVersions(v('1.0.0+a'), v('1.0.0+b')), 0, 'build metadata is ignored')
  // The legacy comparator ignores prerelease entirely — preserved on purpose.
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), 0)
})

test('an unknown version has NO ordering relationship', () => {
  assert.equal(compareVersionStrings(undefined, '1.0.0'), null)
  assert.equal(compareVersionStrings('', '1.0.0'), null)
  assert.equal(compareVersionStrings('garbage', '1.0.0'), null)
})

test('bumpKind identifies the component that moved', () => {
  assert.equal(bumpKind(v('1.2.3'), v('2.0.0')), 'major')
  assert.equal(bumpKind(v('1.2.3'), v('1.3.0')), 'minor')
  assert.equal(bumpKind(v('1.2.3'), v('1.2.4')), 'patch')
  assert.equal(bumpKind(v('1.0.0-rc.1'), v('1.0.0-rc.2')), 'prerelease')
  assert.equal(bumpKind(v('1.2.3'), v('1.2.3')), 'none')
})

// ── Bump policy ──────────────────────────────────────────────────────────────

test('classification decides the smallest legal bump', () => {
  for (const c of ['fix', 'ui', 'tests', 'observability', 'documentation'] as const) {
    assert.equal(requiredBumpFor({ classification: c }), 'patch')
  }
  assert.equal(requiredBumpFor({ classification: 'capability' }), 'minor')
  assert.equal(requiredBumpFor({ classification: 'workflow' }), 'minor')
  assert.equal(requiredBumpFor({ classification: 'breaking' }), 'major')
  assert.equal(requiredBumpFor({ classification: 'fix', breakingChange: true }), 'major')
  assert.equal(requiredBumpFor({ classification: 'fix', migration: 'incompatible' }), 'major')
  assert.equal(requiredBumpFor({ classification: 'fix', migration: 'compatible' }), 'patch')
})

test('a PATCH may not carry a breaking change', () => {
  const r = evaluateVersionBump({ proposedVersion: '0.2.1', previousVersion: '0.2.0', classification: 'fix', breakingChange: true, channel: 'stable' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'breaking_change_requires_major')
  assert.equal(r.actualBump, 'patch')
  assert.equal(r.requiredBump, 'major')
})

test('a PATCH may not carry an incompatible migration', () => {
  const r = evaluateVersionBump({ proposedVersion: '0.2.1', previousVersion: '0.2.0', classification: 'fix', migration: 'incompatible', channel: 'stable' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'incompatible_migration_requires_major')
})

test('a new capability may not ship as a PATCH', () => {
  const r = evaluateVersionBump({ proposedVersion: '0.2.1', previousVersion: '0.2.0', classification: 'capability', channel: 'stable' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'capability_requires_minor')
  // …and the same content as a MINOR is fine.
  assert.equal(evaluateVersionBump({ proposedVersion: '0.3.0', previousVersion: '0.2.0', classification: 'capability', channel: 'stable' }).ok, true)
})

test('valid bumps pass, and a larger-than-required bump is allowed', () => {
  assert.equal(evaluateVersionBump({ proposedVersion: '0.2.1', previousVersion: '0.2.0', classification: 'fix', channel: 'stable' }).ok, true)
  assert.equal(evaluateVersionBump({ proposedVersion: '1.0.0', previousVersion: '0.2.0', classification: 'fix', channel: 'stable' }).ok, true, 'over-bumping is permitted')
})

test('the proposal must be strictly greater than the previous version', () => {
  for (const p of ['0.2.0', '0.1.9']) {
    const r = evaluateVersionBump({ proposedVersion: p, previousVersion: '0.2.0', classification: 'fix', channel: 'stable' })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'not_greater_than_previous')
  }
})

test('an UNKNOWN baseline returns baseline_required — never an inferred first version', () => {
  // This is the Production case today: every product has an unknown installed baseline.
  for (const prev of [undefined, null, '', '   ', 'not-a-version']) {
    const r = evaluateVersionBump({ proposedVersion: '0.2.0', previousVersion: prev as string, classification: 'capability', channel: 'stable' })
    assert.equal(r.ok, false, `previous=${JSON.stringify(prev)}`)
    assert.equal(r.reason, 'baseline_required')
    assert.match(r.detail, /adopt or verify a baseline/i)
  }
})

test('prerelease versions are confined to pre-GA channels', () => {
  assert.equal(channelSupportsPrerelease('alpha'), true)
  assert.equal(channelSupportsPrerelease('beta'), true)
  assert.equal(channelSupportsPrerelease('internal'), true)
  assert.equal(channelSupportsPrerelease('stable'), false)
  assert.equal(channelSupportsPrerelease('lts'), false)
  const bad = evaluateVersionBump({ proposedVersion: '0.3.0-rc.1', previousVersion: '0.2.0', classification: 'capability', channel: 'stable' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'prerelease_not_supported')
  assert.equal(evaluateVersionBump({ proposedVersion: '0.3.0-rc.1', previousVersion: '0.2.0', classification: 'capability', channel: 'beta' }).ok, true)
})

test('an invalid proposed version is rejected before anything else is considered', () => {
  const r = evaluateVersionBump({ proposedVersion: '0.2', previousVersion: '0.1.0', classification: 'fix', channel: 'stable' })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'invalid_format')
})

// ── Duplicate policy ─────────────────────────────────────────────────────────

const existing = [
  { targetProduct: 'supercharged', channel: 'stable' as const, releaseVersion: '0.2.0', active: true },
  { targetProduct: 'supercharged', channel: 'stable' as const, releaseVersion: '0.1.0', active: false },
  { targetProduct: 'supercharged', channel: 'stable' as const, releaseVersion: null, active: true },
]

test('a version may not repeat within one product+channel while active', () => {
  const r = findDuplicateVersion({ proposedVersion: '0.2.0', targetProduct: 'supercharged', channel: 'stable', existing })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'duplicate_version')
})

test('the same version IS allowed on a different product or a different channel', () => {
  assert.equal(findDuplicateVersion({ proposedVersion: '0.2.0', targetProduct: 'jkiss', channel: 'stable', existing }).ok, true)
  assert.equal(findDuplicateVersion({ proposedVersion: '0.2.0', targetProduct: 'supercharged', channel: 'beta', existing }).ok, true)
})

test('a superseded/inactive release does not block reuse, and legacy versionless rows never collide', () => {
  assert.equal(findDuplicateVersion({ proposedVersion: '0.1.0', targetProduct: 'supercharged', channel: 'stable', existing }).ok, true)
  // The versionless active row must not be treated as 0.0.0 and must not collide.
  assert.equal(findDuplicateVersion({ proposedVersion: '0.0.0', targetProduct: 'supercharged', channel: 'stable', existing }).ok, true)
})

// ── Legacy compatibility ─────────────────────────────────────────────────────

test('legacy records with no version read as "Version unspecified" — never 0.0.0', () => {
  for (const empty of [undefined, null, '', '  ']) {
    assert.equal(displayReleaseVersion(empty as string), 'Version unspecified')
    assert.notEqual(displayReleaseVersion(empty as string), '0.0.0')
  }
  assert.equal(displayReleaseVersion('v0.2.0'), '0.2.0')
  assert.equal(displayReleaseVersion('legacy-tag'), 'legacy-tag', 'an unparseable legacy value is shown as-is, not erased')
})

test('PR #84 installed-version behaviour is UNCHANGED by this increment', () => {
  // This module governs a RELEASE record's own version. Installed-baseline display still
  // belongs to deriveVersionState, and it must still refuse to infer.
  assert.equal(deriveVersionState({ installed: undefined, latest: '0.1.0', initialized: true }).kind, 'version_unknown')
  assert.equal(deriveVersionState({ installed: undefined, latest: '0.1.0', initialized: true }).updateAvailable, false)
  assert.equal(deriveVersionState({ installed: '0.0.9', latest: '0.1.0', initialized: true }).kind, 'update_available')
  assert.equal(deriveVersionState({ installed: '0.1.0', latest: '0.1.0', initialized: true }).kind, 'current')
})

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? typescriptFiles(path) : entry.isFile() && path.endsWith('.ts') ? [path] : []
  })
}

test('strict version authorship is confined to finalization, adoption, and release-package policy', () => {
  const hits = typescriptFiles('app')
    .filter((path) => /evaluateVersionBump\(|parseSemanticVersion\(/.test(readFileSync(path, 'utf8')))
    .sort()
  assert.deepEqual(hits, [
    'app/lib/platform/automation/finalize.ts',
    'app/lib/platform/release/baseline-adoption.ts',
    'app/lib/platform/release/release-package.ts',
    'app/lib/platform/release/semver-policy.ts',
    // ADVISORY, and admitted here deliberately: version-proposal.ts computes what an
    // update WOULD become so an owner can see it before deciding. It parses versions
    // and applies bump arithmetic, so it belongs to this family — but it authors
    // nothing durable. That it can never persist a version is pinned separately, by
    // "only the two evidence-based writers may PERSIST a version" in
    // scripts/version-lifecycle.test.ts. Both guards have to agree before a version
    // can move.
    'app/lib/platform/release/version-proposal.ts',
  ])
})
