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
import {
  evaluateApprovalGate, deriveApprovalState, releaseBindingFingerprint, approvalStateLabel,
  approvalPhrase, APPROVAL_TARGET, type ApprovalBinding, type ReleaseApproval,
} from '../../../../../../lib/platform/release/approval'
import { createApproval, getActiveApprovalFor, revokeApproval } from '../../../../../../lib/platform/release/approval-store'
import { recordPlatformAudit } from '../../../../../../lib/platform/updates/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST/GET/DELETE /api/admin/release/businesses/[id]/approval
// Increment 3B.3 — owner-only APPROVAL GATE. Records a single-use, short-lived, release-bound
// pre-publish approval. It NEVER publishes, merges, deploys, rolls back, dispatches a workflow,
// or mutates a business/job/deployment — it only reads the existing snapshot (to re-check
// eligibility server-side) and writes an approval record. No secrets, no raw provider errors.
type Ctx = { params: Promise<{ id: string }> }
const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

// Assemble the SAME read-only snapshot the eligibility/publish-review routes use, and derive
// the approval binding (business + candidate commit + preview deployment + production target).
async function assemble(id: string) {
  const [business, active, jobs, rec] = await Promise.all([
    getBusiness(id), activeJobForBusiness(id), listJobs(), getLatest(id),
  ])
  const job = active ?? jobs.filter((j) => j.businessId === id).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  const ps = rec?.platformSync
  const verified = !!job && (job.status === 'awaiting_owner_review' || job.status === 'completed')
  const previewReady = verified && !!job?.previewDeploymentId
  const now = Date.now()
  // Real current production deployment (read-only) — required so eligibility can clear the
  // production-deployment / rollback-target / audit-context checks (else it is always false).
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
      productionProjectId: business.productionProjectId, deployProject: business.deployProject,
      currentVersion: business.currentVersion,
    } : null,
    job: job ? {
      id: job.id, status: job.status, workBranch: job.workBranch, baseBranch: job.baseBranch,
      approvedCommit: job.approvedCommit, targetCommit: job.targetCommit,
      pullRequestNumber: job.pullRequestNumber, previewDeploymentId: job.previewDeploymentId,
      previewUrl: job.previewUrl, productionDeploymentId: job.productionDeploymentId,
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
    businessId: business?.id, releaseId: releaseId || undefined,
    sourceDeploymentId: sourceDeploymentId || undefined, targetEnvironment: APPROVAL_TARGET,
  }
  const slug = business?.slug || business?.id || id
  return { business, slug, testOnly: isTestOnlyBusiness(business), eligibility, previewReady, binding, releaseId, sourceDeploymentId, now }
}

// A sanitized, secret-free view of an approval for the client.
function view(a: ReleaseApproval | null, state: string) {
  if (!a) return { state, label: approvalStateLabel(state as never) }
  return {
    state, label: approvalStateLabel(state as never),
    id: a.id, businessId: a.businessId, releaseId: a.releaseId, sourceDeploymentId: a.sourceDeploymentId,
    targetEnvironment: a.targetEnvironment, approvedBy: a.approvedBy, approvedAt: a.approvedAt, expiresAt: a.expiresAt,
  }
}

// ── GET — owner-only current approval state (READ-ONLY) ───────────────────────
export const GET = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const gateEnabled = isEnabled('OPERION_APPROVAL_GATE_ENABLED')
  const s = await assemble(id)
  const fp = s.binding.businessId && s.releaseId && s.sourceDeploymentId
    ? releaseBindingFingerprint({ businessId: s.binding.businessId, releaseId: s.releaseId, sourceDeploymentId: s.sourceDeploymentId, targetEnvironment: APPROVAL_TARGET })
    : undefined
  const current = await getActiveApprovalFor(id)
  const state = deriveApprovalState(current, s.now, fp)
  return NextResponse.json({
    ok: true, gateEnabled,
    business: s.business ? { id: s.business.id, name: s.business.name, slug: s.slug, testOnly: s.testOnly } : null,
    eligible: s.eligibility.eligible,
    blockingCount: s.eligibility.reasons.length,
    previewReady: s.previewReady,
    requiredPhrase: s.business ? approvalPhrase(s.slug) : undefined,
    release: { releaseId: s.releaseId || undefined, sourceDeploymentId: s.sourceDeploymentId || undefined, targetEnvironment: APPROVAL_TARGET },
    approval: view(current, state),
  }, { headers: noStore })
})

// ── POST — create an approval (owner + gate flag + eligibility + phrase) ───────
export const POST = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  if (!isEnabled('OPERION_APPROVAL_GATE_ENABLED')) {
    return NextResponse.json({ ok: false, code: 'GATE_DISABLED', message: 'the approval gate is not enabled in this environment' }, { status: 403, headers: noStore })
  }
  const body = (await req.json().catch(() => ({}))) as { phrase?: string; releaseId?: string; sourceDeploymentId?: string; targetEnvironment?: string }
  const s = await assemble(id)

  const gate = evaluateApprovalGate({
    isOwner: true,
    gateEnabled: true,
    business: s.business ? { id: s.business.id, slug: s.slug } : null,
    testOnly: s.testOnly,
    eligibility: s.eligibility,
    previewReady: s.previewReady,
    binding: s.binding,
    claimed: { businessId: id, releaseId: body.releaseId, sourceDeploymentId: body.sourceDeploymentId, targetEnvironment: body.targetEnvironment },
    phraseInput: body.phrase ?? '',
  })

  if (!gate.allowed) {
    await recordPlatformAudit({
      actor: who.sub, actorType: 'owner', source: 'approval-route', action: 'approval.rejected',
      businessId: id, commit: s.releaseId || undefined,
      summary: `Approval rejected for ${id}: ${gate.code}`, meta: { code: gate.code },
    })
    // 409 for phrase/mismatch (client can correct), 403 for authorization-ish refusals.
    const status = gate.code === 'OWNER_REQUIRED' || gate.code === 'GATE_DISABLED' || gate.code === 'TEST_ONLY_BUSINESS' ? 403 : 409
    return NextResponse.json({ ok: false, code: gate.code, message: gate.message }, { status, headers: noStore })
  }

  const created = await createApproval({
    now: s.now, business: { id: s.business!.id, slug: s.slug }, binding: gate.binding,
    approvedBy: who.sub, phraseVerified: true, createdSource: 'approval-route',
  })
  if (!created.ok) {
    return NextResponse.json({ ok: false, code: created.code, message: created.message }, { status: 409, headers: noStore })
  }
  if (!created.reused) {
    await recordPlatformAudit({
      actor: who.sub, actorType: 'owner', source: 'approval-route', action: 'approval.created',
      businessId: id, commit: gate.binding.releaseId, deploymentId: gate.binding.sourceDeploymentId,
      summary: `Owner approved ${s.slug} for production (release ${gate.binding.releaseId.slice(0, 7)}) — intent only, not published`,
      meta: { approvalId: created.approval.id, expiresAt: created.approval.expiresAt, target: APPROVAL_TARGET },
    })
  }
  return NextResponse.json({ ok: true, reused: created.reused, approval: view(created.approval, 'active') }, { headers: noStore })
})

// ── DELETE — owner revokes an active approval (no execution) ───────────────────
export const DELETE = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  if (!isEnabled('OPERION_APPROVAL_GATE_ENABLED')) {
    return NextResponse.json({ ok: false, code: 'GATE_DISABLED' }, { status: 403, headers: noStore })
  }
  const current = await getActiveApprovalFor(id)
  if (!current) return NextResponse.json({ ok: true, revoked: false }, { headers: noStore })
  const revoked = await revokeApproval(current.id, Date.now())
  if (revoked && revoked.revokedAt) {
    await recordPlatformAudit({
      actor: who.sub, actorType: 'owner', source: 'approval-route', action: 'approval.revoked',
      businessId: id, commit: current.releaseId, summary: `Owner revoked approval ${current.id} for ${id}`,
      meta: { approvalId: current.id },
    })
  }
  return NextResponse.json({ ok: true, revoked: true }, { headers: noStore })
})
