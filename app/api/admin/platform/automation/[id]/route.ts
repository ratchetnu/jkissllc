import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner, getPrincipal } from '../../../_lib/session'
import { getJob, getTransferEvidence } from '../../../../../lib/platform/automation/store'
import { getBusiness } from '../../../../../lib/platform/updates/store'
import { approveProduction, transitionJob, retryPreview, finalizePreview } from '../../../../../lib/platform/automation/orchestrator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET — one automation job. Platform-owner only.
//
// Also returns the job's transfer evidence (§4 #7) when it exists: the pinned target
// base commit and the paths that were transferred, excluded, drift-checked,
// closure-checked and symbol-checked — or, for a refused build, the reason. Read-only
// and additive; `evidence` is simply absent for jobs that predate the record or whose
// retention window has closed, and no caller may assume it is present.
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await params
  const job = await getJob(id)
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  // Fail-soft on read too — a missing or unreadable audit record must never turn the
  // job view itself into an error.
  const evidence = await getTransferEvidence(id).catch(() => null)
  return NextResponse.json(evidence ? { job, evidence } : { job })
})

// POST — owner actions. Production promotion ALWAYS requires the platform owner here.
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await params
  const job = await getJob(id)
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const action: string = body.action ?? ''
  const actor = (await getPrincipal(req))?.sub || 'owner'

  switch (action) {
    case 'approve-production': {
      const business = await getBusiness(job.businessId)
      if (!business) return NextResponse.json({ error: 'business missing' }, { status: 400 })
      const r = await approveProduction({ jobId: id, business, actor })
      // Clear, owner-facing message when promotion is gated off (this is by design for now).
      const error = r.ok ? undefined : /promotion disabled/.test(r.reason ?? '')
        ? 'Production promotion isn’t enabled yet. The Preview is verified and approved for review — deploying it to production is a separate, deliberate step that turns on in the production-promotion sprint.'
        : (r.reason ?? 'Approve failed')
      return NextResponse.json(r.ok ? r : { ...r, error }, { status: r.ok ? 200 : 400 })
    }
    case 'request-changes': return NextResponse.json(await transitionJob(id, 'failed', actor, `changes requested: ${typeof body.reason === 'string' ? body.reason.slice(0, 500) : ''}`))
    case 'cancel': return NextResponse.json(await transitionJob(id, 'cancelled', actor, typeof body.reason === 'string' ? body.reason : 'cancelled by owner'))
    case 'retry': { const r = await retryPreview({ jobId: id }); return NextResponse.json(r, { status: r.ok ? 200 : 400 }) }
    case 'complete-preview': {
      const r = await finalizePreview({ jobId: id })
      return NextResponse.json(r.ok ? r : { ...r, error: r.needsAttention ?? r.reason ?? 'Could not finalize preview' }, { status: r.ok ? 200 : 400 })
    }
    case 'request-rollback': return NextResponse.json(await transitionJob(id, 'rollback_required', actor, typeof body.reason === 'string' ? body.reason : 'rollback requested'))
    default: return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }
})
