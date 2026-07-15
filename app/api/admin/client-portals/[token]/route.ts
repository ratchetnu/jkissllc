import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { deleteClientPortal } from '../../../../lib/client-portal'

export const DELETE = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const who = await requirePermission(req, 'businesses:manage')
  if (who instanceof NextResponse) return who
  const { token } = await params
  await deleteClientPortal(token)
  return NextResponse.json({ ok: true })
})
