import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requireStaffSession, isPlatformOwner } from '../../_lib/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/platform/whoami — lets the admin shell decide whether to show the
// owner-only Platform nav item. Returns {owner:false} (not 403) for non-owner staff so
// the shell can simply hide the link. The real gate is requirePlatformOwner on every
// platform data route.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json({ owner: isPlatformOwner(who) })
})
