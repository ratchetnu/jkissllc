import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner, getPrincipal } from '../../../../_lib/session'
import { isEnabled } from '../../../../../../lib/platform/flags'
import { getBusiness, listUpdates, getCompatMap } from '../../../../../../lib/platform/updates/store'
import { updateReleaseEligible } from '../../../../../../lib/platform/updates/policy'
import { activeJobForBusiness, listJobs } from '../../../../../../lib/platform/automation/store'
import { preparePreview, retryPreview } from '../../../../../../lib/platform/automation/orchestrator'
import { pickTargetUpdate } from '../../../../../../lib/platform/release/update-target'
import { mapJobToProgress } from '../../../../../../lib/platform/release/progress'
import type { UpdateCompatibility } from '../../../../../../lib/platform/updates/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The Update action for one Business — a THIN, owner-gated adapter over the EXISTING
// preview orchestrator. It never promotes to production (there is no approve/merge path
// here). Idempotency + business locking + migration/env preflight gates all live in the
// orchestrator it delegates to; this route adds only owner+flag gating, target selection,
// and human progress mapping. Preview-only.

type Ctx = { params: Promise<{ id: string }> }

async function newestJobFor(businessId: string) {
  const active = await activeJobForBusiness(businessId)
  if (active) return active
  const jobs = (await listJobs()).filter(j => j.businessId === businessId)
  return jobs.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
}

// GET — the drawer polls this. Reads the EXISTING automation job and maps it to the calm
// five-step progress. No status is computed or stored here.
export const GET = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const updatesEnabled = isEnabled('OPERION_AUTOMATION_ENABLED')
  const job = await newestJobFor(id)
  if (!job) return NextResponse.json({ ok: true, hasJob: false, updatesEnabled, progress: mapJobToProgress(null, { hasJob: false }) })
  return NextResponse.json({
    ok: true, hasJob: true, updatesEnabled,
    progress: mapJobToProgress(job.status, { failureSummary: job.failureSummary, hasJob: true }),
    previewUrl: job.previewUrl ?? null,
  })
})

// POST — start the update (Preview only) or retry a failed one. Owner + flag gated.
export const POST = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('OPERION_AUTOMATION_ENABLED')) {
    return NextResponse.json({ ok: false, reason: 'updates_disabled' }, { status: 403 })
  }
  const { id } = await ctx.params
  const business = await getBusiness(id)
  if (!business) return NextResponse.json({ ok: false, reason: 'unknown_business' }, { status: 404 })
  const body = await req.json().catch(() => ({}))

  // Retry — safe, reuses the orchestrator's retry (never touches production).
  if (body.action === 'retry') {
    const job = await newestJobFor(id)
    if (!job) return NextResponse.json({ ok: false, reason: 'no_job' }, { status: 400 })
    const r = await retryPreview({ jobId: job.id })
    return NextResponse.json({ ok: r.ok, jobId: job.id, reason: r.ok ? undefined : r.reason }, { status: r.ok ? 200 : 400 })
  }

  // Start — one job per business. The orchestrator also dedupes/locks; this is a fast guard.
  const existing = await activeJobForBusiness(id)
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, reason: 'already_running' })

  const eligible = (await listUpdates()).filter(u => updateReleaseEligible(u).eligible)
  const compatByKey = new Map<string, UpdateCompatibility | undefined>()
  await Promise.all(eligible.map(async u => { compatByKey.set(u.key, (await getCompatMap(u.key))[id]) }))
  const target = pickTargetUpdate(eligible, k => compatByKey.get(k))
  if (!target) return NextResponse.json({ ok: false, reason: 'nothing_to_update' })

  const actor = (await getPrincipal(req))?.sub || 'owner'
  // No approvals passed → any required migration/env is gated by the orchestrator's preflight
  // (it will NOT auto-run migrations; a blocked preflight surfaces as "needs attention").
  const result = await preparePreview({ update: target, business, compat: compatByKey.get(target.key), actor })
  if (!result.ok || !result.job) {
    return NextResponse.json({ ok: false, blocked: result.preflight ? !result.preflight.ok : false, reason: result.reason })
  }
  return NextResponse.json({ ok: true, jobId: result.job.id })
})
