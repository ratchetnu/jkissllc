import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireSession, getPrincipal } from '../_lib/session'
import { listBookings } from '../../../lib/bookings'
import { isBookNow, summarizeBookNow } from '../../../lib/book-now-queue'

// Book Now operations queue feed. Returns ONLY online customer submissions
// (source:'online') plus the per-stage counts that drive the overview counters and
// the nav unread badge. Session-gated exactly like /api/admin/bookings; crew never
// reach an admin session (they are redirected to the crew portal), so this is
// owner/admin/manager only. Test + archived records are included in the payload and
// filtered client-side by explicit toggles (so the counts of "real" work stay honest).
export const GET = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  // Belt-and-suspenders: never serve intake data to a crew principal.
  const who = await getPrincipal(req)
  if (who?.role === 'crew') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  try {
    const all = await listBookings(500)
    const items = all.filter(isBookNow)
    // Counts exclude sandbox test + archived so the badge reflects real open work.
    const counts = summarizeBookNow(items.filter(b => !b.isTest && !b.archived))
    return NextResponse.json({ items, counts })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/book-now GET]', err)
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
})
