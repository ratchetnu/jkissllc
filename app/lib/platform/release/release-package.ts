// ── Operion release-package readiness (PURE) ────────────────────────────────
//
// Draft creation is intentionally permissive. This policy is the single door
// into ready_for_approval: no route or UI may reproduce these checks.

import type {
  PlatformBusiness, PlatformUpdate, ReleasePackage, ReleasePackagePolicySnapshot,
  UpdateCompatibility,
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

export const releasePackageApprovalPhrase = (record: Pick<ReleasePackage, 'id' | 'proposedVersion'>): string =>
  `APPROVE ${record.id} ${record.proposedVersion}`

const active = (status: ReleasePackage['status']): boolean =>
  status !== 'cancelled' && status !== 'superseded'

export function evaluateReleasePackageReadiness(input: {
  draft: ReleasePackageDraft
  business: PlatformBusiness | null
  updates: PlatformUpdate[]
  compatibilityByUpdate: Record<string, UpdateCompatibility | undefined>
  existingPackages: ReleasePackage[]
  now: number
}): ReleasePackageReadiness {
  const { draft, business, updates, compatibilityByUpdate, existingPackages, now } = input
  const blockers: string[] = []
  const parsed = parseSemanticVersion(draft.proposedVersion)
  const byKey = new Map(updates.map((u) => [u.key, u]))
  const selectedUpdates = draft.updateKeys.flatMap((key) => {
    const update = byKey.get(key)
    return update ? [update] : []
  })
  // A draft is not authoritative evidence about the updates it contains. Re-derive
  // risk at the readiness boundary so a record that changed after draft creation
  // cannot slip through under an outdated lower version.
  const effectiveBreakingChange = draft.breakingChange || selectedUpdates.some((update) => update.breakingChange)
  const selectedNeedsMigration = selectedUpdates.some((update) => update.migrationRequired)
  const effectiveMigration = selectedNeedsMigration && draft.migration === 'none'
    ? 'compatible'
    : draft.migration
  const versionPolicy = evaluateVersionBump({
    proposedVersion: draft.proposedVersion,
    previousVersion: business?.currentVersion,
    classification: draft.classification,
    breakingChange: effectiveBreakingChange,
    migration: effectiveMigration,
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

  for (const key of draft.updateKeys) {
    const update = byKey.get(key)
    if (!update) {
      blockers.push(`update ${key} does not exist`)
      continue
    }
    const eligibility = updateReleaseEligible(update)
    if (!eligibility.eligible) blockers.push(`update ${key} is not release-ready: ${eligibility.reasons.join(', ')}`)
    const compatibility = compatibilityByUpdate[key]
    if (!compatibility || compatibility.businessId !== draft.targetProduct) {
      blockers.push(`update ${key} has no assessed compatibility for ${draft.targetProduct}`)
    } else if (compatibility.status !== 'compatible' && compatibility.status !== 'compatible_with_changes') {
      blockers.push(`update ${key} is not transferable to ${draft.targetProduct}: ${compatibility.status}`)
    }
    if (compatibility?.manualPortRequired || compatibility?.codeReconciliationRequired) {
      blockers.push(`update ${key} requires a manual port or code reconciliation for ${draft.targetProduct}`)
    }
  }
  if (selectedNeedsMigration && draft.migration === 'none') {
    blockers.push('package contains a migration but declares no data change')
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
