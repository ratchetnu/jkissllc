// PUBLIC client portal API — the token IS the credential (no admin session).
// Returns only the scrubbed client schedule; never routes' internal fields.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { getClientPortal, getClientRoutes } from '../../../lib/client-portal'

export const GET = withTenantRoute(async (_req: NextRequest, { params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const portal = await getClientPortal(token)
  if (!portal) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const routes = await getClientRoutes(portal.businessName)
  return NextResponse.json({ businessName: portal.label || portal.businessName, routes })
})
