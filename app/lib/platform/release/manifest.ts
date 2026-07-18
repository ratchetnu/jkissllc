// ── Release manifests (internal, PURE) ───────────────────────────────────────
//
// Each platform release carries a manifest describing what it introduces: migrations,
// config changes, required env, flags, module updates, breaking changes, verification
// checks, rollback notes. The system computes "what this Business needs to reach vX"
// from the manifest chain — it NEVER executes anything from a manifest. Manifests are
// curated, reviewed data (like release notes), so there is no arbitrary-command surface:
// every field is a label the UI renders or the orchestrator maps to an ALREADY code-
// defined, owner-gated step. Nothing here is product-facing vocabulary.

import { compareVersions } from '../updates/policy'
import { normalizeVersion, type ReleaseType } from './versions'

export type MigrationSpec = {
  id: string                 // stable, ordered id (e.g. '2026.07.01-scope-bk-keys')
  description: string
  reversible: boolean
}

export type ConfigChange = { key: string; description: string; required: boolean }

export type ReleaseManifest = {
  version: string            // 'v2.1.0'
  minimumVersion: string     // lowest version that may upgrade DIRECTLY to this one
  releaseType: ReleaseType
  editions: string[]         // which editions this applies to ('*' = all)
  databaseMigrations: MigrationSpec[]
  configurationChanges: ConfigChange[]
  requiredEnvironmentVariables: string[]   // NAMES only — never values
  optionalEnvironmentVariables: string[]
  featureFlags: string[]     // flags this release introduces/uses (names)
  moduleUpdates: { module: string; version: string }[]
  breakingChanges: string[]
  verificationChecks: string[]  // labels mapped to code-defined checks
  rollbackInstructions: string
}

export type ManifestValidation = { ok: boolean; errors: string[] }

const SEMVER = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Structural validation — rejects anything that isn't well-formed, non-executable data. */
export function validateManifest(m: Partial<ReleaseManifest> | null | undefined): ManifestValidation {
  const errors: string[] = []
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest is not an object'] }
  if (!m.version || !SEMVER.test(m.version)) errors.push('version must be semver')
  if (!m.minimumVersion || !SEMVER.test(m.minimumVersion)) errors.push('minimumVersion must be semver')
  if (m.version && m.minimumVersion && compareVersions(normalizeVersion(m.minimumVersion), normalizeVersion(m.version)) > 0) {
    errors.push('minimumVersion must be <= version')
  }
  if (!Array.isArray(m.editions) || m.editions.length === 0) errors.push('editions must be a non-empty array')
  const migs = m.databaseMigrations ?? []
  if (new Set(migs.map(x => x.id)).size !== migs.length) errors.push('duplicate migration ids')
  return { ok: errors.length === 0, errors }
}

/** True when this release applies to the given edition ('*' matches all). */
export function appliesToEdition(m: ReleaseManifest, edition: string | undefined): boolean {
  return m.editions.includes('*') || (!!edition && m.editions.includes(edition))
}

export type UpgradePath =
  | { ok: true; releases: ReleaseManifest[] }
  | { ok: false; error: string; gapAfter?: string }

/**
 * Ordered chain of releases from `from` to `target` for an edition. Never skips a
 * prerequisite: each step's `minimumVersion` must be satisfied by the version reached so
 * far; a gap is a hard error (the operator cannot skip a required release).
 */
export function upgradePath(
  from: string,
  target: string,
  manifests: ReleaseManifest[],
  edition?: string,
): UpgradePath {
  const nf = normalizeVersion(from)
  const nt = normalizeVersion(target)
  if (compareVersions(nf, nt) === 0) return { ok: true, releases: [] }
  if (compareVersions(nf, nt) > 0) return { ok: false, error: `installed ${from} is newer than target ${target}` }

  const candidates = manifests
    .filter(m => appliesToEdition(m, edition))
    .filter(m => compareVersions(normalizeVersion(m.version), nf) > 0 && compareVersions(normalizeVersion(m.version), nt) <= 0)
    .sort((a, b) => compareVersions(normalizeVersion(a.version), normalizeVersion(b.version)))

  if (!candidates.length || compareVersions(normalizeVersion(candidates[candidates.length - 1].version), nt) !== 0) {
    return { ok: false, error: `no release path to ${target} for edition ${edition ?? 'any'}` }
  }

  const releases: ReleaseManifest[] = []
  let at = nf
  for (const m of candidates) {
    if (compareVersions(normalizeVersion(m.minimumVersion), at) > 0) {
      return { ok: false, error: `${m.version} requires at least ${m.minimumVersion}; a prerequisite release is missing`, gapAfter: at }
    }
    releases.push(m)
    at = normalizeVersion(m.version)
  }
  return { ok: true, releases }
}

export type UpgradeRequirements = {
  migrations: MigrationSpec[]
  requiredEnv: string[]
  optionalEnv: string[]
  flags: string[]
  moduleUpdates: { module: string; version: string }[]
  breakingChanges: string[]
  verificationChecks: string[]
  hasBreakingChanges: boolean
  migrationCount: number
  irreversibleMigrations: number
}

/** Aggregate everything a Business must satisfy across a computed upgrade path. */
export function requirementsFor(path: ReleaseManifest[]): UpgradeRequirements {
  const migrations = path.flatMap(m => m.databaseMigrations)
  const breakingChanges = path.flatMap(m => m.breakingChanges)
  const uniq = (xs: string[]) => [...new Set(xs)]
  return {
    migrations,
    requiredEnv: uniq(path.flatMap(m => m.requiredEnvironmentVariables)),
    optionalEnv: uniq(path.flatMap(m => m.optionalEnvironmentVariables)),
    flags: uniq(path.flatMap(m => m.featureFlags)),
    moduleUpdates: path.flatMap(m => m.moduleUpdates),
    breakingChanges,
    verificationChecks: uniq(path.flatMap(m => m.verificationChecks)),
    hasBreakingChanges: breakingChanges.length > 0,
    migrationCount: migrations.length,
    irreversibleMigrations: migrations.filter(m => !m.reversible).length,
  }
}

/** Coarse risk from the requirements — feeds a single quiet "risk" hint, details-only. */
export function estimateRisk(req: UpgradeRequirements): 'low' | 'medium' | 'high' {
  if (req.hasBreakingChanges || req.irreversibleMigrations > 0) return 'high'
  if (req.migrationCount > 0 || req.requiredEnv.length > 0) return 'medium'
  return 'low'
}
