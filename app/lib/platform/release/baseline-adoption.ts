// ── Evidence-based baseline adoption (PURE) ─────────────────────────────────
// Products that predate semantic release tracking may adopt a starting version only
// when their currently deployed state is independently evidenced. This module performs
// no I/O and never infers a version from a commit, tag, or repository history.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type {
  BaselineAdoptionDryRun,
  BaselineAdoptionInput,
  BaselineCapabilityEvidence,
  BaselineFlagEvidence,
  BaselineRollbackSnapshot,
  BaselineSchemaEvidence,
  BaselineVerificationEvidence,
  PlatformBusiness,
  BaselineCommitVerification,
} from '../updates/types'
import { channelSupportsPrerelease, parseSemanticVersion } from './semver-policy'

const HASH = /^(?:sha256:)?([a-f0-9]{64})$/i
const COMMIT = /^[a-f0-9]{7,64}$/i
/** Live production evidence read from the deployment provider (server-side only). */
export type LiveProductionEvidence = {
  deploymentId?: string
  commit?: string
  deployedAt?: number
}

/** Git abbreviations vary (7..40 chars), so compare on the shorter shared prefix.
 *  Both sides are already constrained to >=7 hex chars by COMMIT. */
export const sameCommit = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b) return false
  const x = a.toLowerCase(), y = b.toLowerCase()
  return x.startsWith(y) || y.startsWith(x)
}

const MAX_CAPABILITIES = 100
const MAX_FLAGS = 100
const MAX_EVIDENCE = 30
const TOKEN_TTL_MS = 15 * 60_000

type ApprovalClaims = {
  v: 1
  targetProduct: string
  evidenceHash: string
  businessUpdatedAt: number
  expiresAt: number
}

const clean = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function fromB64url(value: string): string | null {
  try { return Buffer.from(value, 'base64url').toString('utf8') } catch { return null }
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(`operion-baseline-adoption:v1:${value}`).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b)
  return aa.length === bb.length && timingSafeEqual(aa, bb)
}

export function baselineSourceOf(business: Pick<PlatformBusiness, 'baselineSource'>): 'installed_by_release' | 'adopted' | 'unknown' {
  return business.baselineSource === 'installed_by_release' || business.baselineSource === 'adopted'
    ? business.baselineSource
    : 'unknown'
}

export function baselineConfirmationPhrase(targetProduct: string, attestedFacts: string[] = []): string {
  // A baseline resting partly on the owner's word is a different commitment from one
  // resting entirely on readings, so it is confirmed with a different sentence. The
  // owner cannot type this one without noticing what they are agreeing to.
  return attestedFacts.length
    ? `ADOPT ${targetProduct.toUpperCase()} BASELINE WITH UNVERIFIED FACTS`
    : `ADOPT ${targetProduct.toUpperCase()} BASELINE`
}

export function rollbackSnapshotFor(business: PlatformBusiness): BaselineRollbackSnapshot {
  return {
    currentVersion: business.currentVersion,
    baselineSource: baselineSourceOf(business),
    baselineAdoptionId: business.baselineAdoptionId,
    currentCommit: business.currentCommit,
    latestVerifiedVersion: business.latestVerifiedVersion,
    latestVerifiedCommit: business.latestVerifiedCommit,
    businessUpdatedAt: business.updatedAt,
  }
}

function normalizeCapabilities(raw: unknown): BaselineCapabilityEvidence[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, BaselineCapabilityEvidence>()
  for (const value of raw.slice(0, MAX_CAPABILITIES)) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    const id = clean(row.id, 80)
    const evidence = clean(row.evidence, 500)
    if (id && evidence) byId.set(id, { id, evidence })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function normalizeSchema(raw: unknown): BaselineSchemaEvidence {
  const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const state = row.state === 'verified' || row.state === 'not_applicable' ? row.state : 'unknown'
  return {
    state,
    schemaVersion: clean(row.schemaVersion, 100) || undefined,
    lastMigrationId: clean(row.lastMigrationId, 160) || undefined,
    evidence: clean(row.evidence, 1000) || undefined,
  }
}

function normalizeFlags(raw: unknown): BaselineFlagEvidence {
  const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const input = row.flags && typeof row.flags === 'object' && !Array.isArray(row.flags)
    ? row.flags as Record<string, unknown>
    : {}
  const flags: Record<string, boolean> = {}
  for (const key of Object.keys(input).sort().slice(0, MAX_FLAGS)) {
    if (typeof input[key] === 'boolean' && key.trim()) flags[key.trim().slice(0, 120)] = input[key] as boolean
  }
  return { assessed: row.assessed === true, flags }
}

function normalizeVerification(raw: unknown): BaselineVerificationEvidence[] {
  if (!Array.isArray(raw)) return []
  const allowed = new Set(['production_deployment', 'health_check', 'smoke_test', 'owner_attestation'])
  const out: BaselineVerificationEvidence[] = []
  for (const value of raw.slice(0, MAX_EVIDENCE)) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    const kind = clean(row.kind, 40)
    const reference = clean(row.reference, 500)
    if (!allowed.has(kind) || !reference) continue
    out.push({
      kind: kind as BaselineVerificationEvidence['kind'],
      reference,
      verifiedAt: typeof row.verifiedAt === 'number' && Number.isFinite(row.verifiedAt) ? row.verifiedAt : undefined,
    })
  }
  return out
}

export function normalizeBaselineAdoptionInput(raw: unknown, targetProduct: string): BaselineAdoptionInput {
  const row = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const hashMatch = HASH.exec(clean(row.capabilityManifestHash, 80))
  return {
    targetProduct,
    proposedVersion: clean(row.proposedVersion, 80),
    deployedCommit: clean(row.deployedCommit, 80),
    capabilityManifestHash: hashMatch ? `sha256:${hashMatch[1].toLowerCase()}` : clean(row.capabilityManifestHash, 80),
    capabilities: normalizeCapabilities(row.capabilities),
    schemaMigrationState: normalizeSchema(row.schemaMigrationState),
    relevantFlagState: normalizeFlags(row.relevantFlagState),
    verificationEvidence: normalizeVerification(row.verificationEvidence),
  }
}

export function baselineEvidenceHash(
  input: BaselineAdoptionInput,
  rollback: BaselineRollbackSnapshot,
  liveProduction?: { commit: string; deploymentId: string },
): string {
  // `health_check.verifiedAt` is the time the read happened, so the required write-time
  // re-check necessarily produces a different value even when every underlying fact is
  // unchanged. Bind the receipt to the evidence identity and result-bearing fields, not
  // to that observation clock. The adopt path still requires the fresh collection to be
  // safe before it verifies this receipt.
  const receiptInput = {
    ...input,
    verificationEvidence: input.verificationEvidence.map(({ kind, reference }) => ({ kind, reference })),
  }
  // Bind both the artifact and its concrete deployment. A redeploy may change environment,
  // build output, or configuration without changing the Git commit, so commit-only binding
  // would allow a receipt minted for one Production state to be spent against another.
  // Omitted when live provider evidence is not required, preserving the legacy hash shape.
  const payload = liveProduction
    ? { input: receiptInput, rollback, liveProduction }
    : { input: receiptInput, rollback }
  return createHash('sha256').update(stable(payload)).digest('hex')
}

export function createBaselineApprovalToken(claims: ApprovalClaims, secret: string): string {
  if (secret.length < 16) throw new Error('baseline adoption approval secret is not configured')
  const payload = b64url(stable(claims))
  return `${payload}.${sign(payload, secret)}`
}

export function verifyBaselineApprovalToken(token: string, secret: string, expected: Omit<ApprovalClaims, 'v' | 'expiresAt'>, now: number): boolean {
  if (secret.length < 16) return false
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload, secret))) return false
  const decoded = fromB64url(payload)
  if (!decoded) return false
  try {
    const claims = JSON.parse(decoded) as ApprovalClaims
    return claims.v === 1
      && claims.targetProduct === expected.targetProduct
      && claims.evidenceHash === expected.evidenceHash
      && claims.businessUpdatedAt === expected.businessUpdatedAt
      && Number.isFinite(claims.expiresAt)
      && claims.expiresAt >= now
  } catch { return false }
}

export function dryRunBaselineAdoption(input: {
  business: PlatformBusiness
  evidence: unknown
  now: number
  approvalSecret?: string
  /** Read server-side from the deployment provider; never client-supplied. */
  liveProduction?: LiveProductionEvidence | null
}): BaselineAdoptionDryRun {
  const evidence = normalizeBaselineAdoptionInput(input.evidence, input.business.id)
  const rollbackSnapshot = rollbackSnapshotFor(input.business)
  const missingEvidence: string[] = []
  const conflicts: string[] = []

  const proposed = parseSemanticVersion(evidence.proposedVersion)
  if (!evidence.proposedVersion) missingEvidence.push('proposed version')
  else if (!proposed.ok) conflicts.push('proposed version is not strict semantic versioning (for example 1.0.0)')
  else if (proposed.version.prerelease?.length && (
    input.business.releaseChannel === 'custom'
    || !channelSupportsPrerelease(input.business.releaseChannel)
  )) {
    conflicts.push(`the ${input.business.releaseChannel} channel does not accept a prerelease baseline`)
  }

  const liveCommit = input.liveProduction?.commit?.trim().toLowerCase()
  const liveDeploymentId = input.liveProduction?.deploymentId?.trim()
  // Derive this from the trusted business record rather than a caller-supplied switch. Any
  // mapped provider is authoritative, and an outage must not reopen record-only adoption.
  const liveProductionRequired = Boolean(
    input.business.productionProjectId || input.business.deployProject,
  )
  const liveUsable = !!liveCommit && COMMIT.test(liveCommit) && !!liveDeploymentId
  const commitVerification: BaselineCommitVerification = liveUsable
    ? { source: 'live_production', liveCommit, liveDeploymentId }
    : liveProductionRequired
      ? { source: 'live_production_unavailable' }
      : { source: 'recorded_baseline' }

  if (!evidence.deployedCommit) missingEvidence.push('deployed commit')
  else if (!COMMIT.test(evidence.deployedCommit)) conflicts.push('deployed commit is not a valid commit identifier')
  else if (liveUsable) {
    // The provider is authoritative. The stored commit only advances when an Operion job
    // finalizes, so it is stale for anything deployed outside the pipeline and must never be
    // the thing we prove against when live evidence is readable.
    if (!sameCommit(evidence.deployedCommit, liveCommit)) {
      const recorded = [input.business.currentCommit, input.business.latestVerifiedCommit].filter(Boolean)
      conflicts.push(recorded.some((c) => sameCommit(evidence.deployedCommit, c))
        ? `the recorded production commit is behind live Production, which is serving ${liveCommit!.slice(0, 12)}`
        : `deployed commit does not match live Production, which is serving ${liveCommit!.slice(0, 12)}`)
    }
  } else if (liveProductionRequired) {
    missingEvidence.push('live production deployment and commit from provider')
  } else {
    const known = [input.business.currentCommit, input.business.latestVerifiedCommit].filter(Boolean)
    if (!known.length) missingEvidence.push('a recorded production commit to compare')
    else if (!known.some((c) => sameCommit(evidence.deployedCommit, c))) conflicts.push('deployed commit does not match the recorded production commit')
  }

  if (!HASH.test(evidence.capabilityManifestHash)) missingEvidence.push('capability manifest SHA-256')
  if (!evidence.capabilities.length) missingEvidence.push('matched capabilities')
  if (evidence.schemaMigrationState.state === 'unknown') missingEvidence.push('schema and migration state')
  if (!evidence.relevantFlagState.assessed) missingEvidence.push('relevant feature-flag assessment')

  const kinds = new Set(evidence.verificationEvidence.map((item) => item.kind))
  if (!kinds.has('production_deployment')) missingEvidence.push('production deployment evidence')
  if (!kinds.has('health_check')) missingEvidence.push('production health-check evidence')

  if (baselineSourceOf(input.business) === 'installed_by_release') {
    conflicts.push('this baseline is already verified through an Operion release')
  }
  if (input.business.currentVersion && baselineSourceOf(input.business) !== 'unknown') {
    conflicts.push('this business already has a provenance-backed baseline')
  }

  const verdict = missingEvidence.length
    ? 'insufficient_evidence'
    : conflicts.length ? 'needs_review' : 'safe_to_adopt'
  const normalizedVersion = proposed.ok ? proposed.normalized : undefined
  const normalizedEvidence = { ...evidence, proposedVersion: normalizedVersion ?? evidence.proposedVersion }
  const evidenceHash = baselineEvidenceHash(
    normalizedEvidence,
    rollbackSnapshot,
    liveUsable ? { commit: liveCommit, deploymentId: liveDeploymentId } : undefined,
  )
  const approvalToken = verdict === 'safe_to_adopt' && input.approvalSecret
    ? createBaselineApprovalToken({
        v: 1,
        targetProduct: input.business.id,
        evidenceHash,
        businessUpdatedAt: input.business.updatedAt,
        expiresAt: input.now + TOKEN_TTL_MS,
      }, input.approvalSecret)
    : undefined

  return {
    targetProduct: input.business.id,
    proposedVersion: normalizedVersion,
    deployedCommit: evidence.deployedCommit || undefined,
    capabilityManifestHash: HASH.test(evidence.capabilityManifestHash) ? evidence.capabilityManifestHash : undefined,
    matchedCapabilities: evidence.capabilities,
    schemaMigrationState: evidence.schemaMigrationState,
    relevantFlagState: evidence.relevantFlagState,
    verificationEvidence: evidence.verificationEvidence,
    missingEvidence,
    conflicts,
    recordsThatWouldChange: [
      `platform:business:${input.business.id} (currentVersion, baselineSource, baselineAdoptionId${liveUsable ? ', currentCommit, latestVerifiedCommit' : ''})`,
      `platform:baseline-adoption:<new record>`,
      'platform:audit:<new event>',
    ],
    rollbackSnapshot,
    baselineSource: 'adopted',
    commitVerification,
    verdict,
    evidenceHash,
    approvalToken,
  }
}
