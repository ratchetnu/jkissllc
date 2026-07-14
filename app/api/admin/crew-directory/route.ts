import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { buildCrewCards, filterBySegment, segmentCounts } from '../../../lib/reminder-segments'
import { listBusinesses } from '../../../lib/businesses'
import type { SegmentId } from '../../../lib/reminder-templates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The Crew directory that lives inside the Communication Center (request Part 1).
// Returns rich per-crew cards with today's operational status + live segment counts,
// so the UI can search, filter, multi-select, and target sends without extra calls.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'crew:view')
  if (who instanceof NextResponse) return who

  const seg = (new URL(req.url).searchParams.get('segment') || 'all') as SegmentId
  const [cards, businesses] = await Promise.all([buildCrewCards(), listBusinesses(500)])
  const counts = segmentCounts(cards)
  const filtered = seg === 'all' ? cards : filterBySegment(cards, seg)

  return NextResponse.json({
    crew: filtered,
    counts,
    total: cards.length,
    businesses: businesses.map(b => ({ key: b.key, name: b.name })),
  })
})
