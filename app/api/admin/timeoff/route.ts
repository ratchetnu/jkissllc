import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { listAll, decideRequest } from '../../../lib/timeoff'
import { roleLabel } from '../../../lib/rbac'

// Admin/manager time-off review queue (Part 8). Listing needs timeoff:view;
// approving/denying needs timeoff:approve — both held by admin + manager.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'timeoff:view')
  if (who instanceof NextResponse) return who
  return NextResponse.json({ ok: true, requests: await listAll() })
})

export const PATCH = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'timeoff:approve')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({}))
  const id = String(body?.id ?? '')
  const action = body?.action
  if (!id || (action !== 'approve' && action !== 'deny')) {
    return NextResponse.json({ ok: false, error: 'action must be approve or deny.' }, { status: 400 })
  }
  const by = who.sub === 'owner' ? 'Owner' : `${roleLabel[who.role]} (${who.sub})`
  const request = await decideRequest(id, action === 'approve', by, typeof body?.note === 'string' ? body.note : undefined)
  if (!request) return NextResponse.json({ ok: false, error: 'Request not found.' }, { status: 404 })
  return NextResponse.json({ ok: true, request })
})
