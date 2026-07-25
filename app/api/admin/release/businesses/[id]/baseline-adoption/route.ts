import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../../_lib/session'
import { getBusiness } from '../../../../../../lib/platform/updates/store'
import { persistApprovedAdoption } from '../../../../../../lib/platform/release/baseline-adoption-store'
import { adoptBaseline, dryRunBaselineAdoption } from '../../../../../../lib/platform/release/baseline-adoption-service'
import { recordPlatformAudit } from '../../../../../../lib/platform/updates/audit'
import type { AdoptionEvidenceInput } from '../../../../../../lib/platform/release/baseline-adoption'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Ctx = { params: Promise<{ id: string }> }
const headers = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

function evidenceFrom(body: unknown, id: string): AdoptionEvidenceInput {
  const b = (body && typeof body === 'object' ? body : {}) as Partial<AdoptionEvidenceInput>
  const commitEvidence = Array.isArray(b.deployedCommitEvidence) ? b.deployedCommitEvidence.flatMap(x =>
    x && typeof x === 'object'
      ? [{ reference: typeof x.reference === 'string' ? x.reference : '', verified: x.verified === true }]
      : [],
  ) : []
  const migration = b.schemaMigration && typeof b.schemaMigration === 'object' ? b.schemaMigration : undefined
  const migrationState = migration?.state
  const flags = Array.isArray(b.relevantFlags) ? b.relevantFlags.flatMap(x =>
    x && typeof x === 'object'
      ? [{
          name: typeof x.name === 'string' ? x.name : '',
          expected: x.expected === true,
          actual: typeof x.actual === 'boolean' ? x.actual : undefined,
          reference: typeof x.reference === 'string' ? x.reference : undefined,
        }]
      : [],
  ) : []
  const verification = Array.isArray(b.verificationEvidence) ? b.verificationEvidence.flatMap(x =>
    x && typeof x === 'object'
      ? [{
          kind: typeof x.kind === 'string' ? x.kind : '',
          reference: typeof x.reference === 'string' ? x.reference : '',
          passed: x.passed === true,
          verifiedAt: typeof x.verifiedAt === 'number' && Number.isFinite(x.verifiedAt) ? x.verifiedAt : 0,
        }]
      : [],
  ) : []
  return {
    targetProduct: id,
    proposedVersion: typeof b.proposedVersion === 'string' ? b.proposedVersion : '',
    deployedCommit: typeof b.deployedCommit === 'string' ? b.deployedCommit : '',
    capabilityManifestHash: typeof b.capabilityManifestHash === 'string' ? b.capabilityManifestHash : '',
    expectedCapabilities: Array.isArray(b.expectedCapabilities) ? b.expectedCapabilities.filter((x): x is string => typeof x === 'string') : [],
    deployedCapabilities: Array.isArray(b.deployedCapabilities) ? b.deployedCapabilities.filter((x): x is string => typeof x === 'string') : [],
    deployedCommitEvidence: commitEvidence,
    schemaMigration: {
      state: migrationState === 'verified' || migrationState === 'not_applicable' || migrationState === 'conflict' ? migrationState : 'unknown',
      references: Array.isArray(migration?.references) ? migration.references.filter((x): x is string => typeof x === 'string') : [],
    },
    relevantFlags: flags,
    verificationEvidence: verification,
  }
}

// POST is strictly read-only: it computes and returns the evidence report and writes no key.
export const POST = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const evidence = evidenceFrom(await req.json().catch(() => ({})), id)
  const result = await dryRunBaselineAdoption({ getBusiness }, evidence)
  if (!result.ok) return NextResponse.json(result, { status: 404, headers })
  return NextResponse.json(result, { headers })
})

// PUT is the sole adoption write boundary. The owner must explicitly approve the exact
// fingerprint returned by a prior POST; the server recomputes it against live state.
export const PUT = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as {
    evidence?: unknown
    dryRunFingerprint?: string
    ownerApproved?: boolean
  }
  const evidence = evidenceFrom(body.evidence, id)
  const result = await adoptBaseline({
    deps: { getBusiness, persist: persistApprovedAdoption },
    evidence,
    dryRunFingerprint: body.dryRunFingerprint,
    ownerApproved: body.ownerApproved === true,
    actor: who.sub,
    now: Date.now(),
  })
  if (!result.ok) {
    await recordPlatformAudit({
      actor: who.sub, actorType: 'owner', source: 'baseline-adoption-route',
      action: 'baseline_adoption.rejected', businessId: id,
      summary: `Baseline adoption rejected for ${id}: ${result.code}`,
      meta: { code: result.code },
    })
    const status = result.code === 'BUSINESS_NOT_FOUND' ? 404 : result.code === 'OWNER_APPROVAL_REQUIRED' ? 403 : 409
    return NextResponse.json(result, { status, headers })
  }
  await recordPlatformAudit({
    actor: who.sub, actorType: 'owner', source: 'baseline-adoption-route',
    action: 'baseline_adoption.completed', businessId: id,
    commit: result.record.deployedCommit, releaseVersion: result.record.proposedVersion,
    summary: `Owner adopted ${result.record.proposedVersion} as the evidenced baseline for ${id}`,
    meta: { adoptionId: result.record.id, manifestHash: result.record.capabilityManifestHash },
  })
  return NextResponse.json({ ok: true, adoption: result.record, business: result.business }, { headers })
})
