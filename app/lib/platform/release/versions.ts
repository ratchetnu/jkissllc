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
export function isBehind(installed: string | undefined, latest: string | undefined): boolean {
  if (!installed || !latest) return false
  return compareVersions(normalizeVersion(installed), normalizeVersion(latest)) < 0
}

/** True when the two versions are the same release. */
export function isSameVersion(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return compareVersions(normalizeVersion(a), normalizeVersion(b)) === 0
}
