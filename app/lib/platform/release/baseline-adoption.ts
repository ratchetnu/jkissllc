// ── Operion Release Center — evidence-based baseline adoption (PURE) ─────────
//
// This is intentionally a narrow legacy-adoption contract, not a general manifest system.
// `capabilityManifestHash` is supplied as immutable evidence for this adoption only; this
// increment creates no manifest record, release package, installation, job, or attempt.

import { parseSemanticVersion } from './semver-policy'
import type { BaselineSource, PlatformBusiness } from '../updates/types'

export type BaselineState = 'verified' | 'adopted' | 'unknown'
export type AdoptionVerdict = 'safe_to_adopt' | 'needs_review' | 'insufficient_evidence'
export type EvidenceState = 'verified' | 'not_applicable' | 'unknown' | 'conflict'

export type AdoptionEvidenceInput = {
  targetProduct: string
  proposedVersion: string
  deployedCommit: string
  capabilityManifestHash: string
  expectedCapabilities: string[]
  deployedCapabilities: string[]
  deployedCommitEvidence: { reference: string; verified: boolean }[]
  schemaMigration: { state: EvidenceState; references: string[] }
  relevantFlags: { name: string; expected: boolean; actual?: boolean; reference?: string }[]
  verificationEvidence: { kind: string; reference: string; passed: boolean; verifiedAt: number }[]
}

export type AdoptionRollbackSnapshot = {
  currentVersion?: string
  currentCommit?: string
  latestVerifiedVersion?: string
  latestVerifiedCommit?: string
  baselineSource: BaselineSource
}

export type BaselineAdoptionDryRun = {
  targetProduct: string
  proposedVersion: string
  deployedCommit: string
  capabilityManifestHash: string
  matchedCapabilities: string[]
  missingCapabilities: string[]
  deployedCommitEvidence: AdoptionEvidenceInput['deployedCommitEvidence']
  schemaMigration: AdoptionEvidenceInput['schemaMigration']
  relevantFlags: AdoptionEvidenceInput['relevantFlags']
  verificationEvidence: AdoptionEvidenceInput['verificationEvidence']
  missingEvidence: string[]
  conflicts: string[]
  recordsThatWouldChange: string[]
  rollbackSnapshot: AdoptionRollbackSnapshot
  verdict: AdoptionVerdict
  fingerprint: string
}

export type OwnerApproval = {
  approved: true
  approvedBy: string
  approvedAt: number
  dryRunFingerprint: string
}

export type BaselineAdoptionRecord = AdoptionEvidenceInput & {
  recordVersion: 1
  id: string
  baselineSource: 'adopted'
  adoptedBy: string
  adoptedAt: number
  ownerApproval: OwnerApproval
  rollbackSnapshot: AdoptionRollbackSnapshot
  verdict: 'safe_to_adopt'
}

const clean = (v: string) => v.trim()
const uniq = (xs: string[]) => [...new Set(xs.map(clean).filter(Boolean))].sort()

export function deriveBaselineState(input: Pick<PlatformBusiness, 'currentVersion' | 'baselineSource'>): BaselineState {
  if (!input.currentVersion?.trim()) return 'unknown'
  if (input.baselineSource === 'installed_by_release') return 'verified'
  if (input.baselineSource === 'adopted') return 'adopted'
  return 'unknown'
}

export function baselineStateLabel(state: BaselineState): string {
  if (state === 'verified') return 'Installed by release'
  if (state === 'adopted') return 'Evidence-adopted baseline'
  return 'Baseline provenance unknown'
}

/** Stable binding for explicit approval. It is a drift detector, not a secret. */
export function adoptionFingerprint(value: unknown): string {
  const canonical = JSON.stringify(value)
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `adopt_${(h >>> 0).toString(16)}`
}

export function evaluateBaselineAdoption(
  business: Pick<PlatformBusiness, 'id' | 'currentVersion' | 'currentCommit' | 'latestVerifiedVersion' | 'latestVerifiedCommit' | 'baselineSource'>,
  evidence: AdoptionEvidenceInput,
): BaselineAdoptionDryRun {
  const expected = uniq(evidence.expectedCapabilities)
  const deployed = new Set(uniq(evidence.deployedCapabilities))
  const matchedCapabilities = expected.filter(x => deployed.has(x))
  const missingCapabilities = expected.filter(x => !deployed.has(x))
  const missingEvidence: string[] = []
  const conflicts: string[] = []
  const parsed = parseSemanticVersion(evidence.proposedVersion)

  if (business.id !== clean(evidence.targetProduct)) conflicts.push('target product does not match the current record')
  if (!parsed.ok) missingEvidence.push('proposedVersion must be strict semantic version')
  if (!/^[a-f0-9]{64}$/i.test(clean(evidence.capabilityManifestHash))) missingEvidence.push('capability manifest SHA-256 hash')
  if (!/^[a-f0-9]{7,64}$/i.test(clean(evidence.deployedCommit))) missingEvidence.push('valid deployed commit')
  if (!evidence.deployedCommitEvidence.some(x => x.verified && clean(x.reference))) missingEvidence.push('verified deployed-commit evidence')
  if (business.currentCommit && clean(business.currentCommit) !== clean(evidence.deployedCommit)) conflicts.push('deployed commit conflicts with the recorded current commit')
  if (!expected.length) missingEvidence.push('expected capability inventory')
  if (missingCapabilities.length) conflicts.push(`${missingCapabilities.length} expected capability/capabilities are not matched`)
  if (evidence.schemaMigration.state === 'unknown') missingEvidence.push('schema/migration evidence')
  if (evidence.schemaMigration.state === 'conflict') conflicts.push('schema/migration evidence conflicts')
  if (!['verified', 'not_applicable'].includes(evidence.schemaMigration.state) || !evidence.schemaMigration.references.length) {
    if (!missingEvidence.includes('schema/migration evidence')) missingEvidence.push('schema/migration evidence')
  }
  for (const flag of evidence.relevantFlags) {
    if (flag.actual == null || !flag.reference?.trim()) missingEvidence.push(`flag evidence: ${flag.name}`)
    else if (flag.actual !== flag.expected) conflicts.push(`flag state conflicts: ${flag.name}`)
  }
  if (!evidence.verificationEvidence.some(x => x.passed && x.reference.trim() && x.verifiedAt > 0)) missingEvidence.push('successful verification evidence')

  const rollbackSnapshot: AdoptionRollbackSnapshot = {
    currentVersion: business.currentVersion,
    currentCommit: business.currentCommit,
    latestVerifiedVersion: business.latestVerifiedVersion,
    latestVerifiedCommit: business.latestVerifiedCommit,
    baselineSource: business.baselineSource ?? 'unknown',
  }
  const verdict: AdoptionVerdict = missingEvidence.length
    ? 'insufficient_evidence'
    : conflicts.length ? 'needs_review' : 'safe_to_adopt'
  const core = {
    targetProduct: clean(evidence.targetProduct),
    proposedVersion: parsed.ok ? parsed.normalized : clean(evidence.proposedVersion),
    deployedCommit: clean(evidence.deployedCommit),
    capabilityManifestHash: clean(evidence.capabilityManifestHash).toLowerCase(),
    matchedCapabilities,
    missingCapabilities,
    deployedCommitEvidence: evidence.deployedCommitEvidence,
    schemaMigration: evidence.schemaMigration,
    relevantFlags: evidence.relevantFlags,
    verificationEvidence: evidence.verificationEvidence,
    missingEvidence: uniq(missingEvidence),
    conflicts: uniq(conflicts),
    recordsThatWouldChange: [`platform:business:${business.id}`, `platform:baseline-adoption:${business.id}:<id>`],
    rollbackSnapshot,
    verdict,
  }
  return { ...core, fingerprint: adoptionFingerprint(core) }
}

export type AdoptionWriteDecision =
  | { allowed: true; record: BaselineAdoptionRecord; business: PlatformBusiness }
  | { allowed: false; code: 'OWNER_APPROVAL_REQUIRED' | 'DRY_RUN_CHANGED' | 'EVIDENCE_NOT_SAFE'; message: string }

/** The shared server/UI write policy. A truthy UI checkbox alone is never sufficient:
 * approval must be owner-attributed, post-date the dry run, and bind its exact fingerprint. */
export function authorizeBaselineAdoption(input: {
  business: PlatformBusiness
  evidence: AdoptionEvidenceInput
  dryRun: BaselineAdoptionDryRun
  ownerApproval?: OwnerApproval
  actor: string
  now: number
  recordId: string
}): AdoptionWriteDecision {
  const live = evaluateBaselineAdoption(input.business, input.evidence)
  if (live.verdict !== 'safe_to_adopt') return { allowed: false, code: 'EVIDENCE_NOT_SAFE', message: `dry run verdict is ${live.verdict}` }
  const approval = input.ownerApproval
  if (!approval?.approved || approval.approvedBy !== input.actor || approval.approvedAt > input.now) {
    return { allowed: false, code: 'OWNER_APPROVAL_REQUIRED', message: 'explicit current-owner approval is required after the dry run' }
  }
  if (approval.approvedAt <= 0 || approval.dryRunFingerprint !== live.fingerprint || input.dryRun.fingerprint !== live.fingerprint) {
    return { allowed: false, code: 'DRY_RUN_CHANGED', message: 'evidence or the current baseline changed after the dry run' }
  }
  const parsed = parseSemanticVersion(input.evidence.proposedVersion)
  if (!parsed.ok) return { allowed: false, code: 'EVIDENCE_NOT_SAFE', message: 'proposed version is invalid' }
  const adoptedAt = input.now
  const record: BaselineAdoptionRecord = {
    ...input.evidence,
    proposedVersion: parsed.normalized,
    recordVersion: 1,
    id: input.recordId,
    baselineSource: 'adopted',
    adoptedBy: input.actor,
    adoptedAt,
    ownerApproval: approval,
    rollbackSnapshot: live.rollbackSnapshot,
    verdict: 'safe_to_adopt',
  }
  return {
    allowed: true,
    record,
    business: {
      ...input.business,
      currentVersion: parsed.normalized,
      currentCommit: clean(input.evidence.deployedCommit),
      latestVerifiedVersion: parsed.normalized,
      latestVerifiedCommit: clean(input.evidence.deployedCommit),
      baselineSource: 'adopted',
      lastVerificationAt: adoptedAt,
      updatedAt: adoptedAt,
    },
  }
}
