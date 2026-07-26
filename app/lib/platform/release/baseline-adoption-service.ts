// ── Baseline adoption write boundary (server-only) ──────────────────────────
// The dry run is read-only. This service is the only adoption write path and requires
// both a fresh signed dry-run receipt and an explicit owner confirmation phrase.

import type {
  BaselineAdoptionRecord,
  BaselineAdoptionDryRun,
  PlatformBusiness,
} from '../updates/types'
import {
  baselineConfirmationPhrase,
  dryRunBaselineAdoption,
  normalizeBaselineAdoptionInput,
  verifyBaselineApprovalToken,
  type LiveProductionEvidence,
} from './baseline-adoption'
import {
  nextBaselineAdoptionId,
  saveBaselineAdoption,
} from '../updates/store'
import { recordPlatformAudit } from '../updates/audit'

export type BaselineAdoptionDependencies = {
  nextId: typeof nextBaselineAdoptionId
  save: typeof saveBaselineAdoption
  audit: typeof recordPlatformAudit
}

const DEFAULT_DEPS: BaselineAdoptionDependencies = {
  nextId: nextBaselineAdoptionId,
  save: saveBaselineAdoption,
  audit: recordPlatformAudit,
}

export type AdoptBaselineResult =
  | { ok: true; business: PlatformBusiness; adoption: BaselineAdoptionRecord }
  | { ok: false; reason: string; dryRun?: BaselineAdoptionDryRun }

export async function adoptBaseline(input: {
  business: PlatformBusiness
  evidence: unknown
  approvalToken: string
  confirmationPhrase: string
  actor: string
  now: number
  approvalSecret: string
  /** Re-read server-side at write time; the receipt is bound to it, so Production moving
   *  between the dry run and the adopt invalidates the approval instead of being ignored. */
  liveProduction?: LiveProductionEvidence | null
  deps?: BaselineAdoptionDependencies
}): Promise<AdoptBaselineResult> {
  const dryRun = dryRunBaselineAdoption({
    business: input.business,
    evidence: input.evidence,
    now: input.now,
    liveProduction: input.liveProduction,
  })
  if (dryRun.verdict !== 'safe_to_adopt' || !dryRun.proposedVersion) {
    return { ok: false, reason: 'baseline evidence is no longer safe to adopt', dryRun }
  }
  const phrase = baselineConfirmationPhrase(input.business.id)
  if (input.confirmationPhrase !== phrase) {
    return { ok: false, reason: `confirmation phrase must be exactly "${phrase}"` }
  }
  if (!verifyBaselineApprovalToken(input.approvalToken, input.approvalSecret, {
    targetProduct: input.business.id,
    evidenceHash: dryRun.evidenceHash,
    businessUpdatedAt: input.business.updatedAt,
  }, input.now)) {
    return { ok: false, reason: 'dry-run approval receipt is missing, expired, or does not match this evidence' }
  }

  const evidence = normalizeBaselineAdoptionInput(input.evidence, input.business.id)
  const deps = input.deps ?? DEFAULT_DEPS
  const id = await deps.nextId()
  const adoption: BaselineAdoptionRecord = {
    recordVersion: 1,
    id,
    ...evidence,
    proposedVersion: dryRun.proposedVersion,
    capabilityManifestHash: dryRun.capabilityManifestHash!,
    baselineSource: 'adopted',
    adoptedBy: input.actor,
    adoptedAt: input.now,
    ownerApproval: {
      approvedBy: input.actor,
      approvedAt: input.now,
      evidenceHash: dryRun.evidenceHash,
      confirmationPhrase: phrase,
    },
    rollbackSnapshot: dryRun.rollbackSnapshot,
    commitVerification: dryRun.commitVerification,
  }
  const provenCommit = dryRun.commitVerification.source === 'live_production'
    ? adoption.deployedCommit
    : undefined
  const business: PlatformBusiness = {
    ...input.business,
    currentVersion: dryRun.proposedVersion,
    baselineSource: 'adopted',
    baselineAdoptionId: id,
    // Only advance the stored commit on provider-proven evidence. Without it the record keeps
    // whatever it had, rather than being advanced on the strength of an unverified claim.
    ...(provenCommit ? { currentCommit: provenCommit, latestVerifiedCommit: provenCommit } : {}),
    updatedAt: input.now,
  }

  // Atomic record + business write. Audit is append-only and fail-soft by design.
  const saved = await deps.save(adoption, business, input.business.updatedAt)
  if (!saved) return { ok: false, reason: 'business evidence changed after the dry run; run the check again' }
  await deps.audit({
    actor: input.actor,
    actorType: 'owner',
    source: 'baseline-adoption',
    action: 'baseline.adopted',
    businessId: business.id,
    releaseVersion: adoption.proposedVersion,
    commit: adoption.deployedCommit,
    newStatus: 'adopted',
    summary: `${business.name} baseline ${adoption.proposedVersion} adopted from verified production evidence`,
    meta: {
      adoptionId: adoption.id,
      evidenceHash: adoption.ownerApproval.evidenceHash,
      capabilityManifestHash: adoption.capabilityManifestHash,
      commitVerifiedBy: adoption.commitVerification.source,
      liveDeploymentId: adoption.commitVerification.liveDeploymentId,
    },
  })
  return { ok: true, business, adoption }
}
