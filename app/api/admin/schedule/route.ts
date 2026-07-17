import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireStaffSession } from '../_lib/session'
import { can } from '../../../lib/rbac'
import { listBookings } from '../../../lib/bookings'
import { listRoutes } from '../../../lib/routes'
import { mergeSchedule, scheduleCounts, type ScheduleItem } from '../../../lib/schedule/unified'
import { detectConflicts, summarizeConflicts } from '../../../lib/schedule/conflicts'

// ─────────────────────────────────────────────────────────────────────────────
// Unified Operations schedule feed. Reads BOTH stores — customer Bookings (bk:*)
// and contract/recurring Routes (rt:*) — projects them into one ScheduleItem list
// (see lib/schedule/unified), and returns it with deterministic conflicts so the
// owner sees every source of work in one place. The client slices Today / Day /
// Week / Pending / Unscheduled from this payload (no per-view round trips).
//
// Staff-only (admin + manager); crew never reach an admin session. This path makes
// ZERO AI calls — it is pure Redis reads + pure projection. Sandbox/test + archived
// bookings are excluded so the schedule reflects real work.
// ─────────────────────────────────────────────────────────────────────────────
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who

  try {
    const [bookings, routes] = await Promise.all([listBookings(500), listRoutes(1000)])

    // Exclude sandbox test + archived bookings from the operational schedule.
    const realBookings = bookings.filter(b => !b.isTest && !b.archived)

    const items = mergeSchedule({ bookings: realBookings, routes })
    const counts = scheduleCounts(items)
    const conflicts = detectConflicts(items)

    // Money visibility: contract/quote value is admin-tier (RouteFinancials is never
    // projected to non-privileged surfaces). Managers run the schedule without money.
    const canSeeValue = can(who.role, 'profitability:view')
    const projected: ScheduleItem[] = canSeeValue
      ? items
      : items.map(it => ({ ...it, valueCents: undefined }))

    return NextResponse.json({
      items: projected,
      counts,
      conflicts,
      conflictSummary: summarizeConflicts(conflicts),
      canSeeValue,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'schedule failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/schedule GET]', err)
    return NextResponse.json({ error: 'schedule failed' }, { status: 500 })
  }
})
