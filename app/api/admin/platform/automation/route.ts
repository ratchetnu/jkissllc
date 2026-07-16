import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner, getPrincipal } from '../../_lib/session'
import { getUpdate, getBusiness, getCompatMap } from '../../../../lib/platform/updates/store'
import { listJobs } from '../../../../lib/platform/automation/store'
import { preparePreview, evaluatePreviewReadiness } from '../../../../lib/platform/automation/orchestrator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET — list automation jobs. Platform-owner only.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json({ jobs: await listJobs() })
})

// POST — Prepare Preview for an update × target. Owner only. Validates preflight and
// creates a job; dispatch happens only when automation is fully enabled + provisioned.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const updateKey = typeof body.updateKey === 'string' ? body.updateKey : ''
  const businessId = typeof body.businessId === 'string' ? body.businessId : ''
  const [update, business] = await Promise.all([getUpdate(updateKey), getBusiness(businessId)])
  if (!update || !business) return NextResponse.json({ error: 'unknown update or business' }, { status: 400 })
  const compat = (await getCompatMap(updateKey))[businessId]
  const approvals = body.approvals && typeof body.approvals === 'object' ? { migration: body.approvals.migration === true, environment: body.approvals.environment === true } : undefined

  // Read-only readiness (no job created) — the UI calls this to render gates + gate the button.
  if (body.evaluateOnly === true) {
    const preflight = await evaluatePreviewReadiness({ update, business, compat, approvals })
    return NextResponse.json({ ok: preflight.ok, preflight, evaluateOnly: true, alreadyDeployed: compat?.status === 'already_present' })
  }

  const actor = (await getPrincipal(req))?.sub || 'owner'
  const result = await preparePreview({ update, business, compat, actor, strategy: body.strategy, approvals })
  // A blocked preflight is a VALID outcome to render (the client shows which gates failed) —
  // not an HTTP error. Return 200 so the gates + reason reach the UI. `error` is included so
  // any generic client still has a human message instead of a bare "Request failed".
  return NextResponse.json(result.ok ? result : { ...result, error: result.reason === 'preflight_failed' ? 'Preflight blocked — resolve the failed gates below.' : (result.reason ?? 'Preview not prepared') })
})
