// ── Operion release — the multi-dimensional version model (PURE) ─────────────
//
// A tenant's "version" is not one number. We track the dimensions SEPARATELY so the
// release system can reason about exactly what a tenant is missing. This module is the
// typed vocabulary + small helpers; it holds no state and does no I/O. Semver math is
// REUSED from platform/updates/policy.ts (parseVersion/compareVersions) — not duplicated.

import { compareVersions, parseVersion } from '../updates/policy'

export type ReleaseChannel = 'internal' | 'alpha' | 'beta' | 'stable' | 'lts'

/** The six release shapes. Drives risk + whether a preview/migration step is needed. */
export type ReleaseType = 'major' | 'minor' | 'patch' | 'hotfix' | 'migration-only' | 'configuration-only'

/**
 * Everything we record about where a tenant currently sits. Every field except
 * `platformVersion` and `channel` is optional so partial/legacy tenants degrade to
 * "unverified" rather than erroring. This is a READ projection — assembled from the
 * existing sync + updates registries, never a new store.
 */
export type TenantVersionState = {
  platformVersion?: string        // semver app release the tenant is on (e.g. 'v1.8.2')
  editionVersion?: string         // industry-pack / edition version
  schemaVersion?: string          // data (Redis keyspace) schema/migration baseline
  configVersion?: string          // configuration schema version
  moduleVersions?: Record<string, string> // per-module/feature versions
  aiConfigVersion?: string        // AI prompt/model configuration version
  deploymentCommit?: string       // the git SHA actually live in production
  lastMigrationId?: string        // last applied migration identifier
  channel: ReleaseChannel
  lastVerifiedAt?: number         // last time a deployment was VERIFIED (not just deployed)
}

/** Normalize a version string for display/compare ('v1.2.3' and '1.2.3' compare equal). */
export function normalizeVersion(v: string | undefined | null): string {
  const s = (v ?? '').trim()
  return s.startsWith('v') ? s.slice(1) : s
}

/** Classify the bump between two semver versions. Falls back to 'minor' when unknown. */
export function classifyReleaseType(from: string | undefined, to: string | undefined): ReleaseType {
  const a = parseVersion(normalizeVersion(from))
  const b = parseVersion(normalizeVersion(to))
  if (!a || !b) return 'minor'
  if (b.major > a.major) return 'major'
  if (b.major === a.major && b.minor > a.minor) return 'minor'
  return 'patch'
}

/** True when `installed` is strictly older than `latest` (both semver). */
// ── Canonical version state ──────────────────────────────────────────────────
// ONE derivation of "where does this product stand?", so a card, a badge, and an
// activity line cannot disagree.
//
// The rule that matters: **a system cannot truthfully claim it is behind when its own
// installed baseline is unknown.** The Release Center used to do exactly that — it
// trusted a platform-sync `updateAvailable` flag while `currentBaselineVersion` was
// empty, so Supercharged read "Current version —" beside "A newer version (0.1.0) is
// available." Unknown now fails CLOSED to `version_unknown`; only a KNOWN installed
// version that is genuinely older yields `update_available`.
export type VersionStateKind =
  | 'current'           // installed known, and level with latest
  | 'update_available'  // installed known, and genuinely behind latest
  | 'version_unknown'   // set up, but no installed baseline has ever been observed
  | 'not_installed'     // never set up on this product
  | 'incompatible'      // known, but not eligible to move

export type VersionState = {
  kind: VersionStateKind
  installed?: string
  latest?: string
  /** True ONLY for `update_available`. Never inferred from an unknown baseline. */
  updateAvailable: boolean
}

export function deriveVersionState(input: {
  installed?: string | null
  latest?: string | null
  initialized?: boolean
  incompatible?: boolean
}): VersionState {
  const installed = input.installed?.trim() || undefined
  const latest = input.latest?.trim() || undefined
  const at = (kind: VersionStateKind): VersionState => ({ kind, installed, latest, updateAvailable: kind === 'update_available' })

  if (input.incompatible) return at('incompatible')
  if (input.initialized === false) return at('not_installed')
  // The fix: no installed baseline ⇒ we do not know, and we do not guess.
  if (!installed) return at('version_unknown')
  if (!latest) return at('current')
  return at(isBehind(installed, latest) ? 'update_available' : 'current')
}

export function isBehind(installed: string | undefined, latest: string | undefined): boolean {
  if (!installed || !latest) return false
  return compareVersions(normalizeVersion(installed), normalizeVersion(latest)) < 0
}

/** True when the two versions are the same release. */
export function isSameVersion(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return compareVersions(normalizeVersion(a), normalizeVersion(b)) === 0
}
