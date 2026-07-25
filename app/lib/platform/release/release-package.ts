// ── Operion release-package readiness (PURE) ────────────────────────────────
//
// Draft creation is intentionally permissive. This policy is the single door
// into ready_for_approval: no route or UI may reproduce these checks.

import type {
  PlatformBusiness, PlatformUpdate, ReleasePackage, ReleasePackagePolicySnapshot,
} from '../updates/types'
import { updateReleaseEligible } from '../updates/policy'
import {
  evaluateVersionBump, findDuplicateVersion, parseSemanticVersion,
  type ChangeClassification, type MigrationClassification, type VersionPolicyResult,
} from './semver-policy'
import type { ReleaseChannel } from './versions'

export type ReleasePackageDraft = {
  targetProduct: string
  proposedVersion: string
  channel: ReleaseChannel
  classification: ChangeClassification
  breakingChange: boolean
  migration: MigrationClassification
  updateKeys: string[]
}

export type ReleasePackageReadiness = {
  ok: boolean
  normalizedVersion?: string
  blockers: string[]
  versionPolicy: VersionPolicyResult
  duplicatePolicy: VersionPolicyResult
  snapshot?: ReleasePackagePolicySnapshot
}

const active = (status: ReleasePackage['status']): boolean =>
  status !== 'cancelled' && status !== 'superseded'

export function evaluateReleasePackageReadiness(input: {
  draft: ReleasePackageDraft
  business: PlatformBusiness | null
  updates: PlatformUpdate[]
  existingPackages: ReleasePackage[]
  now: number
}): ReleasePackageReadiness {
  const { draft, business, updates, existingPackages, now } = input
  const blockers: string[] = []
  const parsed = parseSemanticVersion(draft.proposedVersion)
  const versionPolicy = evaluateVersionBump({
    proposedVersion: draft.proposedVersion,
    previousVersion: business?.currentVersion,
    classification: draft.classification,
    breakingChange: draft.breakingChange,
    migration: draft.migration,
    channel: draft.channel,
  })
  const duplicatePolicy = findDuplicateVersion({
    proposedVersion: draft.proposedVersion,
    targetProduct: draft.targetProduct,
    channel: draft.channel,
    existing: existingPackages.map((p) => ({
      targetProduct: p.targetProduct,
      channel: p.channel,
      releaseVersion: p.proposedVersion,
      active: active(p.status),
    })),
  })

  if (!business || business.id !== draft.targetProduct) blockers.push('target product does not exist')
  if (business?.baselineSource !== 'adopted' && business?.baselineSource !== 'installed_by_release') {
    blockers.push('installed version has no verified provenance')
  }
  if (!draft.updateKeys.length) blockers.push('at least one update is required')
  if (new Set(draft.updateKeys).size !== draft.updateKeys.length) blockers.push('update list contains duplicates')

  const byKey = new Map(updates.map((u) => [u.key, u]))
  for (const key of draft.updateKeys) {
    const update = byKey.get(key)
    if (!update) {
      blockers.push(`update ${key} does not exist`)
      continue
    }
    const eligibility = updateReleaseEligible(update)
    if (!eligibility.eligible) blockers.push(`update ${key} is not release-ready: ${eligibility.reasons.join(', ')}`)
  }
  if (!versionPolicy.ok) blockers.push(versionPolicy.detail)
  if (!duplicatePolicy.ok) blockers.push(duplicatePolicy.detail)

  const ok = blockers.length === 0 && !!business && parsed.ok
  return {
    ok,
    normalizedVersion: parsed.ok ? parsed.normalized : undefined,
    blockers,
    versionPolicy,
    duplicatePolicy,
    snapshot: ok ? {
      previousVersion: business.currentVersion!,
      baselineSource: business.baselineSource ?? 'unknown',
      businessUpdatedAt: business.updatedAt,
      versionReason: versionPolicy.detail,
      duplicateReason: duplicatePolicy.detail,
      evaluatedAt: now,
    } : undefined,
  }
}
