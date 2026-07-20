import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../../_lib/session'
import { isEnabled } from '../../../../../../lib/platform/flags'
import { getBusiness } from '../../../../../../lib/platform/updates/store'
import { isTestOnlyBusiness } from '../../../../../../lib/platform/release/promotion-guards'
import { getPreviewProvider } from '../../../../../../lib/platform/automation/vercel-provider'
import { readRollbackTarget } from '../../../../../../lib/platform/release/production-deployment'
import { evaluateRollbackGate, rollbackPhrase, rollbackUxState, resolveRollbackMode } from '../../../../../../lib/platform/release/rollback'
import { executeRollback, type RollbackPromoteFn } from '../../../../../../lib/platform/release/rollback-executor'
import { getLatestRollbackFor, getRollbackByTarget } from '../../../../../../lib/platform/release/rollback-store'
import { getLatestPublishFor } from '../../../../../../lib/platform/release/publish-store'
import type { ReleaseRollback } from '../../../../../../lib/platform/release/release-history'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST/GET /api/admin/release/businesses/[id]/rollback
// Increment 3B.6 — owner-only CONTROLLED ROLLBACK. Restores the prior known-good production
// deployment — EXACTLY ONCE, idempotently — after owner authorization + a typed confirmation.
// A REAL Vercel rollback runs ONLY in a Production runtime with OPERION_PRODUCTION_PROMOTION_ENABLED
// on; everywhere else it is SIMULATED (no Vercel call). No merges, no secrets, no raw errors.
type Ctx = { params: Promise<{ id: string }> }
const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

async function assemble(id: string) {
  const business = await getBusiness(id)
  const now = Date.now()
  const target = await readRollbackTarget(business)
  const latest = await getLatestRollbackFor(id)
  const concurrentRollback = latest?.status === 'rolling_back'
  const slug = business?.slug || business?.id || id
  const project = business?.productionProjectId || business?.deployProject || ''
  return { business, slug, project, testOnly: isTestOnlyBusiness(business), target, concurrentRollback, now }
}

function rollbackView(r: ReleaseRollback | null) {
  if (!r) return { state: rollbackUxState(undefined) }
  return {
    state: rollbackUxState(r.status), id: r.id, status: r.status, mode: r.mode,
    targetDeploymentId: r.targetDeploymentId, fromDeploymentId: r.fromDeploymentId, targetCommit: r.targetCommit,
    failureReason: r.failureReason, startedAt: r.startedAt, completedAt: r.completedAt,
  }
}

// ── GET — owner-only rollback status + readiness (READ-ONLY) ──────────────────
export const GET = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const s = await assemble(id)
  const gate = evaluateRollbackGate({
    isOwner: true,
    gateEnabled: isEnabled('OPERION_APPROVAL_GATE_ENABLED'),
    rollbackEnabled: isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED'),
    business: s.business ? { id: s.business.id, slug: s.slug } : null,
    testOnly: s.testOnly, targetDeploymentId: s.target.targetDeploymentId, currentDeploymentId: s.target.currentDeploymentId,
    concurrentRollback: s.concurrentRollback, claimedTargetDeploymentId: undefined,
    phraseInput: s.business ? rollbackPhrase(s.slug) : '',
  })
  return NextResponse.json({
    ok: true,
    rollbackEnabled: isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED'),
    approvalGateEnabled: isEnabled('OPERION_APPROVAL_GATE_ENABLED'),
    mode: resolveRollbackMode(process.env),
    ready: gate.allowed,
    blocker: gate.allowed ? undefined : { code: gate.code, message: gate.message },
    requiredPhrase: s.business ? rollbackPhrase(s.slug) : undefined,
    business: s.business ? { id: s.business.id, name: s.business.name, slug: s.slug } : null,
    target: { targetDeploymentId: s.target.targetDeploymentId, currentDeploymentId: s.target.currentDeploymentId, targetCommit: s.target.targetCommit, targetUrl: s.target.targetUrl },
    rollback: rollbackView(await getLatestRollbackFor(id)),
  }, { headers: noStore })
})

// ── POST — execute the rollback (revalidate, then restore once) ───────────────
export const POST = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const body = (await req.json().catch(() => ({}))) as { phrase?: string; targetDeploymentId?: string }
  const s = await assemble(id)

  const gate = evaluateRollbackGate({
    isOwner: true,
    gateEnabled: isEnabled('OPERION_APPROVAL_GATE_ENABLED'),
    rollbackEnabled: isEnabled('OPERION_PRODUCTION_PROMOTION_ENABLED'),
    business: s.business ? { id: s.business.id, slug: s.slug } : null,
    testOnly: s.testOnly, targetDeploymentId: s.target.targetDeploymentId, currentDeploymentId: s.target.currentDeploymentId,
    concurrentRollback: s.concurrentRollback, claimedTargetDeploymentId: body.targetDeploymentId,
    phraseInput: body.phrase ?? '',
  })

  if (!gate.allowed) {
    // Idempotent repeat: if this target already drove a rollback, return that result.
    if (gate.code === 'CONCURRENT_ROLLBACK' && s.target.targetDeploymentId) {
      const prior = await getRollbackByTarget(id, s.target.targetDeploymentId)
      if (prior?.status === 'completed') return NextResponse.json({ ok: true, idempotent: true, rollback: rollbackView(prior) }, { headers: noStore })
    }
    const status = ['OWNER_REQUIRED', 'GATE_DISABLED', 'ROLLBACK_DISABLED', 'TEST_ONLY_BUSINESS'].includes(gate.code) ? 403 : 409
    return NextResponse.json({ ok: false, code: gate.code, message: gate.message }, { status, headers: noStore })
  }

  const mode = resolveRollbackMode(process.env)
  const vercel = getPreviewProvider(process.env)
  const promote: RollbackPromoteFn = mode === 'live'
    ? async (project, dep) => { const r = await vercel.rollbackProduction(project, dep); return r.ok ? { ok: true } : { ok: false, error: r.error, category: r.category } }
    : async () => ({ ok: true })   // simulated — no Vercel call

  const latestPublish = await getLatestPublishFor(id)
  const reversedPublish = latestPublish?.status === 'completed' &&
    (latestPublish.promotedDeploymentId ?? latestPublish.sourceDeploymentId) === gate.fromDeploymentId
    ? latestPublish
    : undefined

  const result = await executeRollback({
    now: s.now, actor: who.sub, business: { id: s.business!.id, slug: s.slug, project: s.project },
    targetDeploymentId: gate.targetDeploymentId, targetCommit: s.target.targetCommit, fromDeploymentId: gate.fromDeploymentId,
    rolledBackPublishId: reversedPublish?.id,
    mode, promote,
  })

  if (!result.ok) {
    const status = result.code === 'IN_PROGRESS' ? 409 : 502
    return NextResponse.json({ ok: false, code: result.code, message: result.message, rollback: result.rollback ? rollbackView(result.rollback) : undefined }, { status, headers: noStore })
  }
  return NextResponse.json({ ok: true, idempotent: result.idempotent, mode, rollback: rollbackView(result.rollback) }, { headers: noStore })
})
