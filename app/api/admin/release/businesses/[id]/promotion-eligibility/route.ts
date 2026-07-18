import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../../_lib/session'
import { isEnabled } from '../../../../../../lib/platform/flags'
import { getBusiness } from '../../../../../../lib/platform/updates/store'
import { getLatest } from '../../../../../../lib/platform/sync/store'
import { activeJobForBusiness, listJobs } from '../../../../../../lib/platform/automation/store'
import { evaluatePromotionEligibility } from '../../../../../../lib/platform/release/promotion-eligibility'
import { promotionExecutionRefusal } from '../../../../../../lib/platform/release/promotion-guards'
import { PROMOTION_ACTIVE } from '../../../../../../lib/platform/automation/promotion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/release/businesses/[id]/promotion-eligibility
// Increment 3B.1 — owner-only, PREVIEW/PROD diagnostic. READ-ONLY: it assembles a
// snapshot from internal KV (business + newest automation job + latest reconciliation)
// and runs the PURE eligibility evaluator. It NEVER calls GitHub/Vercel, never creates a
// promotion run, never acquires a lock, never mutates a business, and never executes a
// promotion (execution is unconditionally refused in 3B.1). Never returns secrets.
type Ctx = { params: Promise<{ id: string }> }

export const GET = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params

  const [business, active, jobs, rec] = await Promise.all([
    getBusiness(id), activeJobForBusiness(id), listJobs(), getLatest(id),
  ])
  const job = active ?? jobs.filter((j) => j.businessId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  const ps = rec?.platformSync

  const verified = !!job && (job.status === 'awaiting_owner_review' || job.status === 'completed')
  const eligibility = evaluatePromotionEligibility({
    now: Date.now(),
    env: { vercelEnv: process.env.VERCEL_ENV },
    flags: { promotionEnabled: isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED') },
    principal: { authenticated: true, isOwner: true },
    business: business ? {
      id: business.id, status: business.status, role: business.role, edition: business.edition,
      allowProductionPromotion: business.allowProductionPromotion,
      repoName: business.repoName, defaultBranch: business.defaultBranch, githubInstallationId: business.githubInstallationId,
      productionProjectId: business.productionProjectId, deployProject: business.deployProject,
      currentVersion: business.currentVersion,
    } : null,
    job: job ? {
      id: job.id, status: job.status, workBranch: job.workBranch, baseBranch: job.baseBranch,
      approvedCommit: job.approvedCommit, targetCommit: job.targetCommit,
      pullRequestNumber: job.pullRequestNumber, previewDeploymentId: job.previewDeploymentId,
      previewUrl: job.previewUrl, productionDeploymentId: job.productionDeploymentId,
    } : null,
    // Internal-only: preview readiness is inferred from the job status (no live Vercel call in 3B.1).
    previewDeployment: job?.previewDeploymentId ? { id: job.previewDeploymentId, readyState: verified ? 'READY' : 'BUILDING', commit: job.targetCommit } : null,
    // Current production is derived from the reconciliation baseline; the real Vercel deployment id
    // is captured at execution time (3B.3), so it is intentionally unknown here.
    currentProduction: ps ? { deploymentId: undefined, version: ps.currentBaselineVersion, commit: ps.currentBaselineCommit } : null,
    candidateBranchHead: undefined,
    verification: job ? { passed: verified, at: job.updatedAt } : null,
    concurrency: {
      // The candidate sits at awaiting_owner_review (an "active" status) — it must not block
      // its own promotion; only a DIFFERENT active preview run counts as a blocking run.
      activeUpdateRun: !!active && active.status !== 'awaiting_owner_review',
      activePromotionRun: !!job && PROMOTION_ACTIVE.has(job.status),
      duplicateRequest: false,
      lockHeld: false,
      alreadyPublished: job?.status === 'completed',
    },
    candidateVersion: ps?.latestBaselineVersion,
  })

  return NextResponse.json({ ok: true, eligibility, execution: promotionExecutionRefusal() })
})
