import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireStaffSession } from '../_lib/session'
import { listBookings } from '../../../lib/bookings'
import { isBookNow, summarizeBookNow } from '../../../lib/book-now-queue'
import { isEnabled } from '../../../lib/platform/flags'

// Book Now operations queue feed. Returns ONLY online customer submissions
// (source:'online') plus the per-stage counts that drive the overview counters and
// the nav unread badge. Session-gated exactly like /api/admin/bookings; crew never
// reach an admin session (they are redirected to the crew portal), so this is
// owner/admin/manager only. Test + archived records are included in the payload and
// filtered client-side by explicit toggles (so the counts of "real" work stay honest).
export const GET = withTenantRoute(async (req: NextRequest) => {
  // Staff-only (admin + manager). requireStaffSession rejects crew principals.
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  try {
    const all = await listBookings(500)
    const items = all.filter(isBookNow)
    // Counts exclude sandbox test + archived so the badge reflects real open work.
    const counts = summarizeBookNow(items.filter(b => !b.isTest && !b.archived))
    // Which optional Book Now surfaces exist on this deployment. Carried on a
    // response the detail page ALREADY fetches so the crew/equipment panel can
    // decide whether it exists without probing an endpoint that 404s when the
    // flag is off. Flag state only — no configuration, no secrets.
    const flags = { bookingAssignment: isEnabled('BOOKING_ASSIGNMENT_ENABLED') }
    return NextResponse.json({ items, counts, flags })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/book-now GET]', err)
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
})
