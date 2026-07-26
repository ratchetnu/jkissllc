import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../../lib/platform/tenancy/with-tenant-route'
import { getPrincipal, requirePlatformOwner } from '../../../../_lib/session'
import {
  getBusiness,
  listBaselineAdoptionsForBusiness,
} from '../../../../../../lib/platform/updates/store'
import {
  baselineConfirmationPhrase,
  baselineSourceOf,
  dryRunBaselineAdoption,
} from '../../../../../../lib/platform/release/baseline-adoption'
import { adoptBaseline } from '../../../../../../lib/platform/release/baseline-adoption-service'
import { readCurrentProductionDeployment } from '../../../../../../lib/platform/release/production-deployment'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

function approvalSecret(): string {
  return process.env.ADMIN_SESSION_SECRET ?? ''
}

// Read-only baseline state. It never calls a deployment provider and never changes data.
export const GET = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const business = await getBusiness(id)
  if (!business) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const [latestAdoption] = await listBaselineAdoptionsForBusiness(id, 1)
  return NextResponse.json({
    ok: true,
    baseline: {
      targetProduct: business.id,
      businessName: business.name,
      currentVersion: business.currentVersion ?? null,
      deployedCommit: business.currentCommit ?? business.latestVerifiedCommit ?? null,
      source: baselineSourceOf(business),
      adoptionId: business.baselineAdoptionId ?? null,
      confirmationPhrase: baselineConfirmationPhrase(id),
    },
    latestAdoption: latestAdoption ?? null,
  })
})

// `dry_run` is read-only. `adopt` is the sole write path and requires the signed receipt
// returned by a safe dry run plus the exact owner confirmation phrase.
export const POST = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const business = await getBusiness(id)
  if (!business) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const action = body?.action
  const evidence = body?.evidence
  const secret = approvalSecret()
  if (secret.length < 16) {
    return NextResponse.json({ error: 'Baseline adoption is unavailable because owner approval signing is not configured.' }, { status: 503 })
  }

  // Read-only provider lookup. Authoritative over the stored commit, which only advances on
  // Operion job finalization and is therefore stale for anything deployed outside the pipeline.
  const liveProduction = await readCurrentProductionDeployment(business).catch(() => null)

  if (action === 'dry_run') {
    const dryRun = dryRunBaselineAdoption({
      business,
      evidence,
      now: Date.now(),
      approvalSecret: secret,
      liveProduction,
    })
    return NextResponse.json({ ok: dryRun.verdict === 'safe_to_adopt', dryRun })
  }
  if (action !== 'adopt') return NextResponse.json({ error: 'unknown action' }, { status: 400 })

  const actor = (await getPrincipal(req))?.sub
  if (!actor) return NextResponse.json({ error: 'owner identity unavailable' }, { status: 401 })
  const result = await adoptBaseline({
    business,
    evidence,
    approvalToken: typeof body.approvalToken === 'string' ? body.approvalToken : '',
    confirmationPhrase: typeof body.confirmationPhrase === 'string' ? body.confirmationPhrase : '',
    actor,
    now: Date.now(),
    approvalSecret: secret,
    liveProduction,
  })
  if (!result.ok) return NextResponse.json({ ok: false, error: result.reason, dryRun: result.dryRun }, { status: 409 })
  return NextResponse.json({ ok: true, baseline: {
    targetProduct: result.business.id,
    currentVersion: result.business.currentVersion,
    source: result.business.baselineSource,
    adoptionId: result.adoption.id,
  } })
})
