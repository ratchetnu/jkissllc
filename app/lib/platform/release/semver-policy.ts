// ── Operion release — semantic version policy (PURE) ─────────────────────────
//
// Increment 1 of the versioning program. No I/O, no clock, no records, no write path.
// Nothing here is wired into a Production flow yet — see "Future integration points".
//
// WHY A SECOND PARSER EXISTS
// `updates/policy.ts` already has parseVersion/compareVersions, and they stay exactly as
// they are: they are deliberately LENIENT (they accept `v1`, `1.2`, leading zeros) and
// they IGNORE prerelease when ordering. Dozens of existing records rely on that leniency,
// so tightening them in place would reclassify historical data.
//
// This module is the STRICT layer used when a version is being *authored* — proposing a
// release version, validating a bump, rejecting duplicates. Reading old data stays
// lenient; writing a new version becomes strict. The two are intentionally separate, and
// `compareSemanticVersions` here is prerelease-aware where the legacy comparator is not.
//
// NOTHING here fabricates a version. An absent version is absent — never 0.0.0.

import type { ReleaseChannel } from './versions'

// ── Types ────────────────────────────────────────────────────────────────────

export type SemanticVersion = {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers, e.g. ['rc', '1']. Absent for a final release. */
  prerelease?: string[]
  /** Build metadata. Carried for display; ignored for precedence, per SemVer 2.0. */
  build?: string
}

export type VersionParseResult =
  | { ok: true; version: SemanticVersion; normalized: string }
  | { ok: false; reason: 'invalid_format' }

/** -1 = a is older, 0 = same precedence, 1 = a is newer. */
export type VersionComparison = -1 | 0 | 1

export type VersionBumpKind = 'major' | 'minor' | 'patch' | 'prerelease' | 'none'

/** What a release actually contains — decides the bump the policy will demand. */
export type ChangeClassification =
  | 'fix' | 'ui' | 'tests' | 'observability' | 'documentation'   // → patch
  | 'capability' | 'workflow'                                     // → minor
  | 'breaking'                                                    // → major

export type MigrationClassification = 'none' | 'compatible' | 'incompatible'

export type VersionPolicyReason =
  | 'valid'
  | 'invalid_format'
  | 'not_greater_than_previous'
  | 'duplicate_version'
  | 'breaking_change_requires_major'
  | 'incompatible_migration_requires_major'
  | 'capability_requires_minor'
  | 'baseline_required'
  | 'prerelease_not_supported'

export type VersionPolicyInput = {
  proposedVersion: string
  /** Absent when the target has no known installed baseline — NOT an invitation to guess. */
  previousVersion?: string | null
  classification: ChangeClassification
  breakingChange?: boolean
  migration?: MigrationClassification
  channel: ReleaseChannel
}

export type VersionPolicyResult = {
  ok: boolean
  reason: VersionPolicyReason
  /** The bump the proposal actually represents (absent when it could not be computed). */
  actualBump?: VersionBumpKind
  /** The smallest bump this change is allowed to use. */
  requiredBump?: VersionBumpKind
  detail: string
}

// ── Parsing ──────────────────────────────────────────────────────────────────

// Strict SemVer 2.0: all three components required, no leading zeros, optional
// `-prerelease` and `+build` with the permitted alphabet only.
const STRICT = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** Strict parse. Never coerces: `1.2`, `01.0.0`, `1.0.0-` and `''` are all rejected. */
export function parseSemanticVersion(input: string | undefined | null): VersionParseResult {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid_format' }
  const raw = input.trim()
  if (!raw) return { ok: false, reason: 'invalid_format' }
  const m = STRICT.exec(raw)
  if (!m) return { ok: false, reason: 'invalid_format' }
  const prerelease = m[4] ? m[4].split('.') : undefined
  // A numeric prerelease identifier may not carry a leading zero either.
  if (prerelease?.some(id => /^0\d+$/.test(id))) return { ok: false, reason: 'invalid_format' }
  const version: SemanticVersion = { major: +m[1], minor: +m[2], patch: +m[3], prerelease, build: m[5] }
  return { ok: true, version, normalized: formatSemanticVersion(version) }
}

export function isValidSemanticVersion(input: string | undefined | null): boolean {
  return parseSemanticVersion(input).ok
}

/** Canonical form — no leading `v`, build metadata preserved. */
export function formatSemanticVersion(v: SemanticVersion): string {
  const core = `${v.major}.${v.minor}.${v.patch}`
  const pre = v.prerelease?.length ? `-${v.prerelease.join('.')}` : ''
  const build = v.build ? `+${v.build}` : ''
  return `${core}${pre}${build}`
}

// ── Comparison ───────────────────────────────────────────────────────────────

function comparePrerelease(a: string[] | undefined, b: string[] | undefined): VersionComparison {
  // A version WITH a prerelease has lower precedence than the same version without.
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i]
    if (x === undefined) return -1   // fewer identifiers = lower precedence
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) { const d = +x - +y; if (d !== 0) return d < 0 ? -1 : 1; continue }
    if (xn !== yn) return xn ? -1 : 1 // numeric identifiers rank below alphanumeric
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Prerelease-aware precedence. Build metadata is ignored, per SemVer 2.0. */
export function compareSemanticVersions(a: SemanticVersion, b: SemanticVersion): VersionComparison {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

/** String form. Returns null when EITHER side is unparseable — an unknown version has no
 *  ordering relationship, and pretending otherwise is how "unknown" became "behind". */
export function compareVersionStrings(a: string | undefined | null, b: string | undefined | null): VersionComparison | null {
  const pa = parseSemanticVersion(a), pb = parseSemanticVersion(b)
  if (!pa.ok || !pb.ok) return null
  return compareSemanticVersions(pa.version, pb.version)
}

/** Which component moved. `none` when the cores match (prerelease-only moves report `prerelease`). */
export function bumpKind(previous: SemanticVersion, next: SemanticVersion): VersionBumpKind {
  if (next.major !== previous.major) return 'major'
  if (next.minor !== previous.minor) return 'minor'
  if (next.patch !== previous.patch) return 'patch'
  if (comparePrerelease(previous.prerelease, next.prerelease) !== 0) return 'prerelease'
  return 'none'
}

// ── Channels ─────────────────────────────────────────────────────────────────

// Prerelease identifiers are accepted only on the pre-GA channels that already exist in
// `ReleaseChannel`. `stable` and `lts` are the channels a product actually runs on, and a
// prerelease has no business being an installed baseline there.
const PRERELEASE_CHANNELS: ReadonlySet<ReleaseChannel> = new Set<ReleaseChannel>(['internal', 'alpha', 'beta'])
export function channelSupportsPrerelease(channel: ReleaseChannel): boolean {
  return PRERELEASE_CHANNELS.has(channel)
}

// ── Bump policy ──────────────────────────────────────────────────────────────

/** The smallest bump a change of this shape may use. */
export function requiredBumpFor(input: Pick<VersionPolicyInput, 'classification' | 'breakingChange' | 'migration'>): VersionBumpKind {
  if (input.breakingChange || input.classification === 'breaking' || input.migration === 'incompatible') return 'major'
  if (input.classification === 'capability' || input.classification === 'workflow') return 'minor'
  return 'patch'
}

const RANK: Record<VersionBumpKind, number> = { none: 0, prerelease: 1, patch: 2, minor: 3, major: 4 }

/**
 * Validate a proposed release version against its predecessor and its content.
 *
 * Deliberately returns `baseline_required` rather than approving a first version when the
 * previous version is unknown: a product whose installed baseline has never been
 * established cannot have a "next" version derived for it. Baseline adoption comes first.
 */
export function evaluateVersionBump(input: VersionPolicyInput): VersionPolicyResult {
  const proposed = parseSemanticVersion(input.proposedVersion)
  if (!proposed.ok) {
    return { ok: false, reason: 'invalid_format', detail: `"${input.proposedVersion}" is not a valid semantic version` }
  }
  if (proposed.version.prerelease?.length && !channelSupportsPrerelease(input.channel)) {
    return { ok: false, reason: 'prerelease_not_supported', detail: `the ${input.channel} channel does not accept prerelease versions` }
  }

  const required = requiredBumpFor(input)

  // Unknown baseline ⇒ no ordering exists to validate against. Never infer a first version.
  const previous = parseSemanticVersion(input.previousVersion)
  if (!previous.ok) {
    return {
      ok: false, reason: 'baseline_required', requiredBump: required,
      detail: 'no known previous version for this target — adopt or verify a baseline before proposing a release version',
    }
  }

  if (compareSemanticVersions(proposed.version, previous.version) !== 1) {
    return {
      ok: false, reason: 'not_greater_than_previous', requiredBump: required,
      detail: `${proposed.normalized} must be greater than ${previous.normalized}`,
    }
  }

  const actual = bumpKind(previous.version, proposed.version)
  if (RANK[actual] < RANK[required]) {
    const reason: VersionPolicyReason =
      input.migration === 'incompatible' ? 'incompatible_migration_requires_major'
      : required === 'major' ? 'breaking_change_requires_major'
      : 'capability_requires_minor'
    return {
      ok: false, reason, actualBump: actual, requiredBump: required,
      detail: `a ${actual} bump is not sufficient — this change requires ${required}`,
    }
  }

  return { ok: true, reason: 'valid', actualBump: actual, requiredBump: required, detail: `${previous.normalized} → ${proposed.normalized} (${actual})` }
}

// ── Duplicate policy ─────────────────────────────────────────────────────────

export type ExistingRelease = {
  targetProduct: string
  channel: ReleaseChannel
  /** Absent for legacy records — those are "unspecified", never 0.0.0. */
  releaseVersion?: string | null
  /** Only ACTIVE releases collide; superseded/cancelled ones do not. */
  active: boolean
}

/**
 * A version may repeat freely across DIFFERENT products or DIFFERENT channels — the same
 * release genuinely lands on many targets. It may not repeat within one product+channel
 * while an existing release is still active.
 *
 * Legacy records carrying no version are skipped entirely: an absent version is not a
 * value, so it can neither collide nor be treated as 0.0.0.
 */
export function findDuplicateVersion(input: {
  proposedVersion: string
  targetProduct: string
  channel: ReleaseChannel
  existing: ExistingRelease[]
}): VersionPolicyResult {
  const proposed = parseSemanticVersion(input.proposedVersion)
  if (!proposed.ok) return { ok: false, reason: 'invalid_format', detail: `"${input.proposedVersion}" is not a valid semantic version` }

  const clash = input.existing.find(e =>
    e.active &&
    e.targetProduct === input.targetProduct &&
    e.channel === input.channel &&
    compareVersionStrings(e.releaseVersion, proposed.normalized) === 0,
  )
  return clash
    ? { ok: false, reason: 'duplicate_version', detail: `${proposed.normalized} is already active for ${input.targetProduct} on ${input.channel}` }
    : { ok: true, reason: 'valid', detail: `${proposed.normalized} is free for ${input.targetProduct} on ${input.channel}` }
}

// ── Legacy display ───────────────────────────────────────────────────────────

/** Absent/blank version ⇒ "Version unspecified". NEVER 0.0.0, and never a guess.
 *  Display of an *installed* baseline stays with `deriveVersionState()` (PR #84); this is
 *  for a RELEASE RECORD's own version field. */
export function displayReleaseVersion(v: string | undefined | null): string {
  const raw = (v ?? '').trim()
  if (!raw) return 'Version unspecified'
  const parsed = parseSemanticVersion(raw)
  return parsed.ok ? parsed.normalized : raw
}

// ── Future integration points (documented, deliberately NOT wired) ───────────
//
// This increment adds no Production write path. When the later increments land:
//
//  1. `deriveBusinessProvenance()` (automation/finalize.ts) is the narrowest existing
//     boundary where a releaseVersion becomes an INSTALLED version. It should call
//     `parseSemanticVersion()` and refuse to adopt an unparseable one, instead of
//     accepting any string as today.
//  2. Release-package creation (Increment 3) should call `evaluateVersionBump()` and
//     `findDuplicateVersion()` before a draft may be marked Ready.
//  3. Baseline adoption (Increment 2) supplies the `previousVersion` that
//     `baseline_required` currently demands — which is why adoption precedes packaging.
//
// None of the above is implemented here, and no caller of this module exists yet.
