import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireAdmin } from '../_lib/session'
import { getReleaseSnapshot } from '../../../lib/release/manifest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/release — the read-only Release Center snapshot. Admin-only.
//
// READ-ONLY BY CONTRACT: there is deliberately no POST/PUT/PATCH/DELETE handler here.
// The snapshot is assembled from non-secret Vercel build vars + curated static content
// + resolved feature-flag booleans. It returns no secret and no raw env value.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireAdmin(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json(getReleaseSnapshot())
})
