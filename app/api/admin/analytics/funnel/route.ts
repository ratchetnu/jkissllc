// Quote-flow funnel viewer API. Surfaces the funnel:* day counters (lib/analytics-events)
// that were previously WRITE-ONLY — the producers (app/api/quote/*) are unchanged; this
// adds the missing reader. Read-only, gated reports:view, tenant-scoped via the redis
// chokepoint.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { getFunnel } from '../../../../lib/analytics-events'
import { parseDays } from '../../../../lib/analytics/range'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'reports:view')
  if (who instanceof NextResponse) return who
  const days = parseDays(new URL(req.url).searchParams.get('days'), 30, 90)
  const funnel = await getFunnel(days)
  return NextResponse.json({ windowDays: days, ...funnel })
})
