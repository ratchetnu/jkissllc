import type { PlatformBusiness } from '../updates/types'
import {
  authorizeBaselineAdoption,
  evaluateBaselineAdoption,
  type AdoptionEvidenceInput,
  type BaselineAdoptionDryRun,
  type BaselineAdoptionRecord,
} from './baseline-adoption'

export type AdoptionServiceDeps = {
  getBusiness(id: string): Promise<PlatformBusiness | null>
  persist(input: {
    expectedBusiness: PlatformBusiness
    nextBusiness: PlatformBusiness
    record: BaselineAdoptionRecord
  }): Promise<'written' | 'business_changed'>
}

export async function dryRunBaselineAdoption(
  deps: Pick<AdoptionServiceDeps, 'getBusiness'>,
  evidence: AdoptionEvidenceInput,
): Promise<{ ok: true; dryRun: BaselineAdoptionDryRun } | { ok: false; code: 'BUSINESS_NOT_FOUND' }> {
  const business = await deps.getBusiness(evidence.targetProduct)
  if (!business) return { ok: false, code: 'BUSINESS_NOT_FOUND' }
  return { ok: true, dryRun: evaluateBaselineAdoption(business, evidence) }
}

export async function adoptBaseline(input: {
  deps: AdoptionServiceDeps
  evidence: AdoptionEvidenceInput
  dryRunFingerprint?: string
  ownerApproved: boolean
  actor: string
  now: number
}): Promise<
  | { ok: true; record: BaselineAdoptionRecord; business: PlatformBusiness }
  | { ok: false; code: 'BUSINESS_NOT_FOUND' | 'OWNER_APPROVAL_REQUIRED' | 'DRY_RUN_CHANGED' | 'EVIDENCE_NOT_SAFE' | 'BUSINESS_CHANGED'; message: string }
> {
  const business = await input.deps.getBusiness(input.evidence.targetProduct)
  if (!business) return { ok: false, code: 'BUSINESS_NOT_FOUND', message: 'business not found' }
  const dryRun = evaluateBaselineAdoption(business, input.evidence)
  const recordId = `BADOPT-${input.now}-${dryRun.fingerprint.slice(6)}`
  const decision = authorizeBaselineAdoption({
    business,
    evidence: input.evidence,
    dryRun,
    ownerApproval: input.ownerApproved && input.dryRunFingerprint ? {
      approved: true,
      approvedBy: input.actor,
      approvedAt: input.now,
      dryRunFingerprint: input.dryRunFingerprint,
    } : undefined,
    actor: input.actor,
    now: input.now,
    recordId,
  })
  if (!decision.allowed) return { ok: false, code: decision.code, message: decision.message }
  const persisted = await input.deps.persist({
    expectedBusiness: business,
    nextBusiness: decision.business,
    record: decision.record,
  })
  if (persisted !== 'written') {
    return { ok: false, code: 'BUSINESS_CHANGED', message: 'the business baseline changed; run the dry run again' }
  }
  return { ok: true, record: decision.record, business: decision.business }
}
