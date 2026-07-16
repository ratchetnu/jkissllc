import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../_lib/session'
import { listBusinesses, listUpdates, listDeployments } from '../../../lib/platform/updates/store'
import { computeUpdateKpis, computeAttention } from '../../../lib/platform/updates/policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/platform — the owner dashboard payload. Platform-owner only.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const [businesses, updates, deployments] = await Promise.all([listBusinesses(), listUpdates(), listDeployments()])
  const now = Date.now()
  return NextResponse.json({
    businesses,
    updates,
    deployments,
    kpis: computeUpdateKpis(updates, now),
    attention: computeAttention(updates, deployments, now),
    at: now,
  })
})
