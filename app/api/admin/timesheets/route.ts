// Admin timesheet — read-only hours worked across both lanes (routes + bookings).
// Gated on `time:view` (admin + manager). Booking punches only appear when
// BOOKING_ASSIGNMENT_ENABLED is on; otherwise this is routes-only, unchanged.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { listRoutes } from '../../../lib/routes'
import { listBookings, type Booking } from '../../../lib/bookings'
import { isEnabled } from '../../../lib/platform/flags'
import { selectTimeEntries, rollupByStaff, periodTotalMinutes, type TimeFilter } from '../../../lib/timesheets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'time:view')
  if (who instanceof NextResponse) return who

  const url = new URL(req.url)
  const staffId = url.searchParams.get('staffId') || undefined
  const start = url.searchParams.get('start') || undefined
  const end = url.searchParams.get('end') || undefined
  const typeParam = url.searchParams.get('type')
  const type = typeParam === 'route' || typeParam === 'booking' ? typeParam : undefined
  const filter: TimeFilter = { staffId, start, end, type }

  const bookingLaneEnabled = isEnabled('BOOKING_ASSIGNMENT_ENABLED')
  const [routes, bookings] = await Promise.all([
    listRoutes(1000),
    bookingLaneEnabled ? listBookings(1000) : Promise.resolve<Booking[]>([]),
  ])
  const entries = selectTimeEntries(routes, bookings, filter)

  return NextResponse.json({
    entries,
    byStaff: rollupByStaff(entries),
    periodTotalMinutes: periodTotalMinutes(entries),
    bookingLaneEnabled,
    filter: { staffId: staffId ?? null, start: start ?? null, end: end ?? null, type: type ?? null },
  })
})
