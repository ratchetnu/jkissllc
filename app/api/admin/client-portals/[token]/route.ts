import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requireSession } from '../../_lib/session'
import { deleteClientPortal } from '../../../../lib/client-portal'

export const DELETE = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { token } = await params
  await deleteClientPortal(token)
  return NextResponse.json({ ok: true })
})
