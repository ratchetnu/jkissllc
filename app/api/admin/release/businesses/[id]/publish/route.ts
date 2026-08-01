import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../../_lib/session'
import { isEnabled } from '../../../../../../lib/platform/flags'
import { getBusiness } from '../../../../../../lib/platform/updates/store'
import { getLatest } from '../../../../../../lib/platform/sync/store'
import { activeJobForBusiness, listJobs } from '../../../../../../lib/platform/automation/store'
import { evaluatePromotionEligibility } from '../../../../../../lib/platform/release/promotion-eligibility'
import { PROMOTION_ACTIVE } from '../../../../../../lib/platform/automation/promotion'
import { isTestOnlyBusiness } from '../../../../../../lib/platform/release/promotion-guards'
import { readCurrentProductionDeployment } from '../../../../../../lib/platform/release/production-deployment'
import { APPROVAL_TARGET, type ApprovalBinding } from '../../../../../../lib/platform/release/approval'
import { getActiveApprovalFor } from '../../../../../../lib/platform/release/approval-store'
import { evaluatePublishGate, publishPhrase, publishUxState, resolvePublishMode } from '../../../../../../lib/platform/release/publish'
import { executePublish } from '../../../../../../lib/platform/release/publish-executor'
import { getLatestPublishFor, getPublishByApproval, type ReleasePublish } from '../../../../../../lib/platform/release/publish-store'
import { approveProduction } from '../../../../../../lib/platform/automation/orchestrator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST/GET /api/admin/release/businesses/[id]/publish
// Increment 3B.4 — owner-only CONTROLLED PUBLISH. Consumes a 3B.3 approval and promotes the
// approved Preview into Production — EXACTLY ONCE, idempotently. It re-validates EVERYTHING
// server-side, consumes the release-bound approval, then hands the exact verified job to the
// single merge/deploy/verify automation state machine. It never promotes Preview directly.
type Ctx = { params: Promise<{ id: string }> }
const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

async function assemble(id: string) {
  const [business, active, jobs, rec] = await Promise.all([
    getBusiness(id), activeJobForBusiness(id), listJobs(), getLatest(id),
  ])
  const job = active ?? jobs.filter((j) => j.businessId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  const ps = rec?.platformSync
  const verified = !!job && (job.status === 'awaiting_owner_review' || job.status === 'completed')
  const previewReady = verified && !!job?.previewDeploymentId
  const now = Date.now()
  // Real current production deployment (read-only) — required for eligibility (see fix in
  // production-deployment.ts): without it, eligibility permanently fails and no publish can run.
  const prod = await readCurrentProductionDeployment(business)

  const eligibility = evaluatePromotionEligibility({
    now,
    env: { vercelEnv: process.env.VERCEL_ENV },
    flags: { promotionEnabled: isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED') },
    principal: { authenticated: true, isOwner: true },
    business: business ? {
      id: business.id, status: business.status, role: business.role, edition: business.edition,
      allowProductionPromotion: business.allowProductionPromotion,
      repoName: business.repoName, defaultBranch: business.defaultBranch, githubInstallationId: business.githubInstallationId,
      productionProjectId: business.productionProjectId, deployProject: business.deployProject, currentVersion: business.currentVersion,
    } : null,
    job: job ? {
      id: job.id, status: job.status, workBranch: job.workBranch, baseBranch: job.baseBranch,
      approvedCommit: job.approvedCommit, targetCommit: job.targetCommit, pullRequestNumber: job.pullRequestNumber,
      previewDeploymentId: job.previewDeploymentId, previewUrl: job.previewUrl, productionDeploymentId: job.productionDeploymentId,
    } : null,
    previewDeployment: job?.previewDeploymentId ? { id: job.previewDeploymentId, readyState: verified ? 'READY' : 'BUILDING', commit: job.targetCommit } : null,
    currentProduction: (ps || prod) ? { deploymentId: prod?.deploymentId, version: ps?.currentBaselineVersion, commit: prod?.commit ?? ps?.currentBaselineCommit } : null,
    candidateBranchHead: undefined,
    verification: job ? { passed: verified, at: job.updatedAt } : null,
    concurrency: {
      activeUpdateRun: !!active && active.status !== 'awaiting_owner_review',
      activePromotionRun: !!job && PROMOTION_ACTIVE.has(job.status),
      duplicateRequest: false, lockHeld: false, alreadyPublished: job?.status === 'completed',
    },
    candidateVersion: ps?.latestBaselineVersion,
  })

  const releaseId = job?.targetCommit || job?.approvedCommit || ''
  const sourceDeploymentId = job?.previewDeploymentId || ''
  const binding: Partial<ApprovalBinding> = {
    businessId: business?.id, releaseId: releaseId || undefined, sourceDeploymentId: sourceDeploymentId || undefined, targetEnvironment: APPROVAL_TARGET,
  }
  const slug = business?.slug || business?.id || id
  return { business, job, slug, testOnly: isTestOnlyBusiness(business), eligibility, previewReady, binding, releaseId, sourceDeploymentId, now }
}

function publishView(p: ReleasePublish | null) {
  if (!p) return { state: publishUxState(undefined) }
  return {
    state: publishUxState(p.status), id: p.id, status: p.status, mode: p.mode,
    releaseId: p.releaseId, sourceDeploymentId: p.sourceDeploymentId, promotedDeploymentId: p.promotedDeploymentId,
    failureReason: p.failureReason, startedAt: p.startedAt, completedAt: p.completedAt,
  }
}

// ── GET — owner-only publish status + readiness (READ-ONLY) ───────────────────
export const GET = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const s = await assemble(id)
  const approval = await getActiveApprovalFor(id)
  const gate = evaluatePublishGate({
    now: s.now, isOwner: true,
    approvalGateEnabled: isEnabled('OPERION_APPROVAL_GATE_ENABLED'),
    publishEnabled: isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED'),
    business: s.business ? { id: s.business.id, slug: s.slug } : null,
    testOnly: s.testOnly, eligibility: s.eligibility, previewReady: s.previewReady,
    approval, binding: s.binding, claimed: {}, phraseInput: s.business ? publishPhrase(s.slug) : '',
  })
  return NextResponse.json({
    ok: true,
    publishEnabled: isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED'),
    approvalGateEnabled: isEnabled('OPERION_APPROVAL_GATE_ENABLED'),
    mode: resolvePublishMode(process.env),
    ready: gate.allowed,                 // everything except the typed phrase is satisfied
    blocker: gate.allowed ? undefined : { code: gate.code, message: gate.message },
    requiredPhrase: s.business ? publishPhrase(s.slug) : undefined,
    business: s.business ? { id: s.business.id, name: s.business.name, slug: s.slug } : null,
    release: { releaseId: s.releaseId || undefined, sourceDeploymentId: s.sourceDeploymentId || undefined, targetEnvironment: APPROVAL_TARGET },
    approval: approval ? { approvedAt: approval.approvedAt, expiresAt: approval.expiresAt } : null,
    publish: publishView(await getLatestPublishFor(id)),
  }, { headers: noStore })
})

// ── POST — execute the publish (revalidate EVERYTHING, then promote once) ─────
export const POST = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { phrase?: string; releaseId?: string; sourceDeploymentId?: string }
  const s = await assemble(id)
  const approval = await getActiveApprovalFor(id)

  const gate = evaluatePublishGate({
    now: s.now, isOwner: true,
    approvalGateEnabled: isEnabled('OPERION_APPROVAL_GATE_ENABLED'),
    publishEnabled: isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED'),
    business: s.business ? { id: s.business.id, slug: s.slug } : null,
    testOnly: s.testOnly, eligibility: s.eligibility, previewReady: s.previewReady,
    approval, binding: s.binding,
    claimed: { releaseId: body.releaseId, sourceDeploymentId: body.sourceDeploymentId },
    phraseInput: body.phrase ?? '',
  })

  if (!gate.allowed) {
    // Idempotent repeat: if this approval already drove a publish, return that result.
    if (gate.code === 'APPROVAL_CONSUMED' && approval) {
      const prior = await getPublishByApproval(approval.id)
      if (prior) return NextResponse.json({ ok: true, idempotent: true, publish: publishView(prior) }, { headers: noStore })
    }
    const status = ['OWNER_REQUIRED', 'APPROVAL_GATE_DISABLED', 'PUBLISH_DISABLED', 'TEST_ONLY_BUSINESS'].includes(gate.code) ? 403 : 409
    return NextResponse.json({ ok: false, code: gate.code, message: gate.message }, { status, headers: noStore })
  }

  // LIVE hands off to the one authoritative automation executor. Preview/development remains
  // an honest simulation and never mutates the job or calls a provider.
  const mode = resolvePublishMode(process.env)
  if (!s.job || !s.business) return NextResponse.json({ ok: false, code: 'PUBLISH_CONTEXT_MISSING', message: 'the verified automation job is no longer available' }, { status: 409, headers: noStore })

  const result = await executePublish({
    now: s.now, actor: who.sub, business: { id: s.business.id, slug: s.slug }, jobId: s.job.id,
    approval: gate.approval, binding: gate.binding, mode,
    beginPromotion: mode === 'live'
      ? async () => {
          const started = await approveProduction({ jobId: s.job!.id, business: s.business!, actor: who.sub })
          return started.ok ? { ok: true as const } : { ok: false as const, error: started.reason ?? 'promotion start failed' }
        }
      : async () => ({ ok: true as const }),
  })

  if (!result.ok) {
    const status = result.code === 'IN_PROGRESS' ? 409 : result.code === 'APPROVAL_NOT_CONSUMABLE' ? 409 : 502
    return NextResponse.json({ ok: false, code: result.code, message: result.message, publish: result.publish ? publishView(result.publish) : undefined }, { status, headers: noStore })
  }
  return NextResponse.json({ ok: true, idempotent: result.idempotent, mode, publish: publishView(result.publish) }, { headers: noStore })
})
