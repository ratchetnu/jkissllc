import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../lib/platform/tenancy/with-tenant-route'
import { getAvailability, unitsForLoad } from '../../lib/availability'

export const dynamic = 'force-dynamic'

// GET /api/availability?loadSize=full|units=3 — open dates for a job of this size
// (bigger jobs need more open room) + the deposit amount.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const sp = new URL(req.url).searchParams
  const units = sp.get('units')
    ? Math.max(1, parseInt(sp.get('units')!, 10) || 1)
    : unitsForLoad(sp.get('loadSize') ?? undefined)
  try {
    const { dates, depositCents, capacity } = await getAvailability(60, units)
    return NextResponse.json({ ok: true, dates, depositCents, capacity, units })
  } catch {
    return NextResponse.json({ ok: true, dates: [], depositCents: 5000 })
  }
})
