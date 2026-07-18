import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../../_lib/session'
import { isEnabled } from '../../../../../../lib/platform/flags'
import { getBusiness, getUpdate } from '../../../../../../lib/platform/updates/store'
import { getLatest } from '../../../../../../lib/platform/sync/store'
import { activeJobForBusiness, listJobs } from '../../../../../../lib/platform/automation/store'
import { evaluatePromotionEligibility } from '../../../../../../lib/platform/release/promotion-eligibility'
import { PROMOTION_ACTIVE } from '../../../../../../lib/platform/automation/promotion'
import { isTestOnlyBusiness } from '../../../../../../lib/platform/release/promotion-guards'
import { buildPublishReview } from '../../../../../../lib/platform/release/build-publish-review'
import { enrichPublishReview } from '../../../../../../lib/platform/release/publish-review-enrichment'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/release/businesses/[id]/publish-review
// Increment 3B.2D — owner-only, READ-ONLY. Assembles the Publish Review payload from
// internal KV (business + newest job + latest reconciliation + update) and the pure
// eligibility engine, then ENRICHES it with VERIFIED provider READS: the current READY
// Vercel production deployment and a GitHub compare (current prod ↔ candidate commit).
// Enrichment is read-only, time-bounded, and independently fail-soft — a provider being
// unavailable degrades that section to "Unavailable" with a sanitized warning, never a
// failure. It NEVER mutates a Business, creates a promotion run/lock, transitions state,
// dispatches a workflow, or calls any provider WRITE. No secrets, no raw env, no raw
// provider error bodies. Returns review data even when ineligible (so blockers show).
type Ctx = { params: Promise<{ id: string }> }
const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

export const GET = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params

  const [business, active, jobs, rec] = await Promise.all([
    getBusiness(id), activeJobForBusiness(id), listJobs(), getLatest(id),
  ])
  const job = active ?? jobs.filter((j) => j.businessId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  const update = job?.updateId ? await getUpdate(job.updateId) : null
  const ps = rec?.platformSync
  const now = Date.now()
  const verified = !!job && (job.status === 'awaiting_owner_review' || job.status === 'completed')
  const candidateVersion = ps?.latestBaselineVersion
  const testOnly = isTestOnlyBusiness(business)

  const eligibility = evaluatePromotionEligibility({
    now,
    env: { vercelEnv: process.env.VERCEL_ENV },
    flags: { promotionEnabled: isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED') },
    principal: { authenticated: true, isOwner: true },
    business: business ? {
      id: business.id, status: business.status, role: business.role, edition: business.edition,
      allowProductionPromotion: business.allowProductionPromotion, repoName: business.repoName,
      defaultBranch: business.defaultBranch, githubInstallationId: business.githubInstallationId,
      productionProjectId: business.productionProjectId, deployProject: business.deployProject, currentVersion: business.currentVersion,
    } : null,
    job: job ? {
      id: job.id, status: job.status, workBranch: job.workBranch, baseBranch: job.baseBranch,
      approvedCommit: job.approvedCommit, targetCommit: job.targetCommit, pullRequestNumber: job.pullRequestNumber,
      previewDeploymentId: job.previewDeploymentId, previewUrl: job.previewUrl, productionDeploymentId: job.productionDeploymentId,
    } : null,
    previewDeployment: job?.previewDeploymentId ? { id: job.previewDeploymentId, readyState: verified ? 'READY' : 'BUILDING', commit: job.targetCommit } : null,
    currentProduction: ps ? { deploymentId: undefined, version: ps.currentBaselineVersion, commit: ps.currentBaselineCommit } : null,
    candidateBranchHead: undefined,
    verification: job ? { passed: verified, at: job.updatedAt } : null,
    concurrency: {
      activeUpdateRun: !!active && active.status !== 'awaiting_owner_review',
      activePromotionRun: !!job && PROMOTION_ACTIVE.has(job.status),
      duplicateRequest: false, lockHeld: false, alreadyPublished: job?.status === 'completed',
    },
    candidateVersion,
  })

  // ── Read-only provider enrichment (fail-soft, time-bounded, no writes) ────────
  const candidateCommit = job?.targetCommit || job?.approvedCommit
  const enrichment = await enrichPublishReview({
    now,
    business: business ? {
      id: business.id, repoName: business.repoName, repositoryOwner: business.repositoryOwner,
      repositoryNameOnly: business.repositoryNameOnly, githubInstallationId: business.githubInstallationId,
      productionProjectId: business.productionProjectId, deployProject: business.deployProject,
    } : null,
    baseCommit: ps?.currentBaselineCommit,
    headCommit: candidateCommit,
  })
  const prod = enrichment.production
  // Verified Vercel production deployment when available; else the local reconciliation
  // baseline (id still unavailable → rollback stays "not ready", exactly as before).
  const currentProduction = prod
    ? { deploymentId: prod.deploymentId, url: prod.url, deployedAt: prod.createdAt ?? prod.readyAt, deployedCommit: prod.commitSha ?? ps?.currentBaselineCommit, version: ps?.currentBaselineVersion, readyState: prod.state }
    : ps ? { deploymentId: undefined, deployedCommit: ps.currentBaselineCommit, version: ps.currentBaselineVersion } : null

  const result = buildPublishReview({
    now,
    ownerSub: who.sub,
    business: business ? {
      id: business.id, name: business.name, status: business.status, edition: business.edition, role: business.role,
      repoName: business.repoName, productionUrl: business.productionUrl, currentVersion: business.currentVersion,
      latestVerifiedVersion: business.latestVerifiedVersion, latestVerifiedCommit: business.latestVerifiedCommit,
    } : null,
    releaseStatusLabel: verified ? 'Ready to publish' : undefined,
    testOnly,
    job: job ? {
      id: job.id, status: job.status, workBranch: job.workBranch, targetCommit: job.targetCommit, approvedCommit: job.approvedCommit,
      pullRequestNumber: job.pullRequestNumber, pullRequestUrl: job.pullRequestUrl,
      previewDeploymentId: job.previewDeploymentId, previewUrl: job.previewUrl, updatedAt: job.updatedAt,
    } : null,
    currentProduction,
    changeCompare: enrichment.compare,
    candidate: { version: candidateVersion, commit: candidateCommit, branch: job?.workBranch },
    update: update ? {
      key: update.key, title: update.title, summary: update.summary, technicalImpact: update.technicalImpact,
      migrationRequired: update.migrationRequired, environmentChangeRequired: update.environmentChangeRequired,
      secretRequired: update.secretRequired, breakingChange: update.breakingChange, rollbackSupported: update.rollbackSupported,
      validation: update.validation as unknown as Record<string, string>, approvedAt: update.approvedAt,
    } : null,
    eligibility,
  })

  if (!result.ok) {
    return NextResponse.json({ ok: false, refusal: result.refusal }, { status: 404, headers: noStore })
  }
  // Merge builder + enrichment warnings (both already sanitized), de-duplicated.
  const warnings = [...new Set([...result.warnings, ...enrichment.warnings])]
  return NextResponse.json(
    { ok: true, eligible: result.review!.eligibility.eligible, review: result.review, warnings },
    { headers: noStore },
  )
})
