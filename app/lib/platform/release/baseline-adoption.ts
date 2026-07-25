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
} from '../updates/types'
import { channelSupportsPrerelease, parseSemanticVersion } from './semver-policy'

const HASH = /^(?:sha256:)?([a-f0-9]{64})$/i
const COMMIT = /^[a-f0-9]{7,64}$/i
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

export function baselineConfirmationPhrase(targetProduct: string): string {
  return `ADOPT ${targetProduct.toUpperCase()} BASELINE`
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

export function baselineEvidenceHash(input: BaselineAdoptionInput, rollback: BaselineRollbackSnapshot): string {
  return createHash('sha256').update(stable({ input, rollback })).digest('hex')
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

  if (!evidence.deployedCommit) missingEvidence.push('deployed commit')
  else if (!COMMIT.test(evidence.deployedCommit)) conflicts.push('deployed commit is not a valid commit identifier')
  else {
    const known = [input.business.currentCommit, input.business.latestVerifiedCommit].filter(Boolean)
    if (!known.length) missingEvidence.push('a recorded production commit to compare')
    else if (!known.includes(evidence.deployedCommit)) conflicts.push('deployed commit does not match the recorded production commit')
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
  const evidenceHash = baselineEvidenceHash(normalizedEvidence, rollbackSnapshot)
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
      `platform:business:${input.business.id} (currentVersion, baselineSource, baselineAdoptionId)`,
      `platform:baseline-adoption:<new record>`,
      'platform:audit:<new event>',
    ],
    rollbackSnapshot,
    baselineSource: 'adopted',
    verdict,
    evidenceHash,
    approvalToken,
  }
}
