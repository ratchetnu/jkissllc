// GPS compliance — read-only verification results + rollup across routes (and bookings
// behind BOOKING_ASSIGNMENT_ENABLED). Gated on routes:view (admin+manager); tenant-scoped
// via the redis chokepoint. Verification is DERIVED on read from stored raw captures — no
// punch is mutated. Bounded query. (When time:view lands it can supersede routes:view.)
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { listRoutes } from '../../../lib/routes'
import { listBookings, effectiveServiceDate, type Booking } from '../../../lib/bookings'
import { isEnabled } from '../../../lib/platform/flags'
import { selectGpsRecords, gpsRollup, type GpsWorkItem, type GpsFilter } from '../../../lib/timeclock/gps-compliance'
import type { VerifyStatus } from '../../../lib/timeclock/geofence'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUSES = new Set<VerifyStatus>(['verified_on_site', 'outside_geofence', 'low_accuracy', 'location_unavailable', 'expected_unavailable', 'stale', 'invalid_coordinates'])

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'routes:view')
  if (who instanceof NextResponse) return who
  try {
    const url = new URL(req.url)
    const statusParam = url.searchParams.get('status')
    const typeParam = url.searchParams.get('type')
    const filter: GpsFilter = {
      staffId: url.searchParams.get('staffId') || undefined,
      status: statusParam && STATUSES.has(statusParam as VerifyStatus) ? (statusParam as VerifyStatus) : undefined,
      type: typeParam === 'route' || typeParam === 'booking' ? typeParam : undefined,
      start: url.searchParams.get('start') || undefined,
      end: url.searchParams.get('end') || undefined,
    }
    const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '500', 10) || 500))
    const now = Date.now()
    const bookingLaneEnabled = isEnabled('BOOKING_ASSIGNMENT_ENABLED')
    const [routes, bookings] = await Promise.all([
      listRoutes(1000),
      bookingLaneEnabled ? listBookings(1000) : Promise.resolve<Booking[]>([]),
    ])

    const items: GpsWorkItem[] = [
      ...routes.map((r) => ({ type: 'route' as const, token: r.token, number: r.routeNumber, date: r.routeDate, expectedLat: r.reportLat, expectedLng: r.reportLng, assignees: r.assignees })),
      // Bookings have no stored destination coords today → verify derives expected_unavailable.
      ...bookings.map((b) => ({ type: 'booking' as const, token: b.token, number: b.bookingNumber, date: effectiveServiceDate(b), expectedLat: undefined, expectedLng: undefined, assignees: b.assignees })),
    ]
    const records = selectGpsRecords(items, filter, now).slice(0, limit)
    return NextResponse.json({ ok: true, records, rollup: gpsRollup(records), bookingLaneEnabled, limit, generatedAt: now })
  } catch (err) {
    if (err instanceof Error && err.message === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[gps-compliance]', err)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
})
