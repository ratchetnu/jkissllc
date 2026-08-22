// ── Proposed next version for an update (PURE, ADVISORY, NEVER PERSISTED) ────
//
// A business-facing version is a promise ("Supercharged is on v1.4.0"). It may
// therefore only change when that promise is actually true — after an update has
// been published, deployed AND verified. That write lives in exactly one place,
// `deriveBusinessProvenance()` (automation/finalize.ts), and is pinned there by
// scripts/version-lifecycle.test.ts.
//
// This module is the OTHER half: what an owner is shown BEFORE any of that has
// happened. It answers "if you approved this, what would it become?" and it
// answers it without writing anything. Discovery files a record for every merge to
// main, so a version generated per discovered commit would march the number forward
// for changes nobody approved and none of which are live — which is precisely the
// thing a version is supposed to rule out.
//
// The bump policy itself is NOT reimplemented here. `requiredBumpFor()` in
// semver-policy.ts already decides what a change of a given shape may use, and
// `evaluateVersionBump()` enforces it at approval time. This module only maps an
// update record onto that policy's vocabulary and applies the arithmetic.

import type { PlatformUpdate, UpdateType } from '../updates/types'
import type { ReleaseChannel } from '../updates/types'
import {
  type ChangeClassification, type MigrationClassification, type SemanticVersion, type VersionBumpKind,
  formatSemanticVersion, parseSemanticVersion, requiredBumpFor,
} from './semver-policy'

/**
 * How an update's own classification maps onto the release policy's vocabulary.
 *
 * Deliberately conservative in the direction that is SAFE TO BE WRONG. Proposing
 * too small a bump is corrected at approval — `evaluateVersionBump()` refuses a
 * proposal below the required minimum. Proposing too large a bump is not corrected
 * by anything, and a major version an owner did not mean is not retractable once a
 * business has been told it.
 */
const CLASSIFICATION: Record<UpdateType, ChangeClassification> = {
  feature: 'capability',
  enhancement: 'capability',
  deprecation: 'capability',      // announcing a removal is not yet the removal
  configuration: 'workflow',
  migration: 'workflow',
  bug_fix: 'fix',
  security: 'fix',                // a security FIX is a patch; a breaking one is caught below
  emergency_hotfix: 'fix',
  performance: 'fix',
  accessibility: 'ui',
  design: 'ui',
  infrastructure: 'observability',
  documentation: 'documentation',
}

export type UpdateChangeShape = {
  classification: ChangeClassification
  breakingChange: boolean
  migration: MigrationClassification
}

/**
 * `migrationRequired` on a DISCOVERED record is a path-name heuristic, and a
 * truncated file list sets it too. It is evidence that a person must look, not proof
 * that the migration is incompatible — so it maps to `compatible`, which does not by
 * itself force a major. Only a declared breaking change does that.
 */
export function updateChangeShape(update: Pick<PlatformUpdate, 'type' | 'breakingChange' | 'migrationRequired'>): UpdateChangeShape {
  return {
    classification: CLASSIFICATION[update.type] ?? 'fix',
    breakingChange: update.breakingChange === true,
    migration: update.migrationRequired ? 'compatible' : 'none',
  }
}

/** Apply a bump. Prerelease and build metadata are dropped — a released version carries neither. */
export function applyBump(previous: SemanticVersion, kind: VersionBumpKind): SemanticVersion {
  switch (kind) {
    case 'major': return { major: previous.major + 1, minor: 0, patch: 0 }
    case 'minor': return { major: previous.major, minor: previous.minor + 1, patch: 0 }
    case 'patch': return { major: previous.major, minor: previous.minor, patch: previous.patch + 1 }
    // 'prerelease' and 'none' cannot advance a released version on their own.
    default: return { major: previous.major, minor: previous.minor, patch: previous.patch }
  }
}

export type VersionProposal =
  | { ok: true; from: string; proposed: string; bump: VersionBumpKind; detail: string }
  | { ok: false; reason: 'baseline_required' | 'invalid_current_version'; detail: string }

/**
 * What this update would make the business's version, if it were approved, published,
 * deployed and verified. ADVISORY — nothing here is stored, and `currentVersion` is
 * untouched until all four of those have actually happened.
 *
 * Returns `baseline_required` rather than inventing a first version when the business
 * has no known installed baseline. That mirrors `evaluateVersionBump()`, and it is the
 * same rule the rest of this system already follows: a product whose baseline was never
 * established does not have a "next" version, and guessing one would put a number on a
 * business that no evidence supports.
 */
export function proposeNextVersion(input: {
  currentVersion: string | undefined | null
  update: Pick<PlatformUpdate, 'type' | 'breakingChange' | 'migrationRequired'>
  channel?: ReleaseChannel
}): VersionProposal {
  const shape = updateChangeShape(input.update)
  const bump = requiredBumpFor(shape)

  if (input.currentVersion == null || String(input.currentVersion).trim() === '') {
    return {
      ok: false, reason: 'baseline_required',
      detail: 'This business has no established version baseline yet, so there is no next version to propose. Adopt a baseline first.',
    }
  }
  const previous = parseSemanticVersion(input.currentVersion)
  if (!previous.ok) {
    return {
      ok: false, reason: 'invalid_current_version',
      detail: `The recorded current version ("${input.currentVersion}") is not a valid semantic version, so a next version cannot be derived from it.`,
    }
  }

  const proposed = formatSemanticVersion(applyBump(previous.version, bump))
  const why = shape.breakingChange
    ? 'it declares a breaking change'
    : bump === 'minor' ? 'it adds or changes a capability'
    : 'it is a fix or a presentational change'
  return {
    ok: true,
    from: previous.normalized,
    proposed,
    bump,
    detail: `Proposed ${bump} bump because ${why}. Not applied — the version changes only after this update is published, deployed and verified.`,
  }
}

/** `1.4.0` → `v1.4.0`. The `v` is display-only; stored versions stay canonical. */
export function displayVersion(version: string | undefined | null): string {
  const parsed = parseSemanticVersion(version)
  return parsed.ok ? `v${parsed.normalized}` : '—'
}
