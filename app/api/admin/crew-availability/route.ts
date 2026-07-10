import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../_lib/session'
import { getWeek, listWeeks, isAvailableOn, normalizeWeekStart } from '../../../lib/crew-availability'

// Admin/manager read of crew availability (Part 7: consulted while scheduling).
// availability:view is held by admin + manager. Read-only — crew own their own
// availability; staff never edit it here.
//
//  ?staffId=&weekStart=  → that crew member's week
//  ?staffId=&date=       → { available: true|false|null } for a specific date
//  ?staffId=             → recent submitted/draft weeks
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'availability:view')
  if (who instanceof NextResponse) return who

  const q = new URL(req.url).searchParams
  const staffId = q.get('staffId')
  if (!staffId) return NextResponse.json({ ok: false, error: 'staffId required' }, { status: 400 })

  const date = q.get('date')
  if (date) {
    return NextResponse.json({ ok: true, available: await isAvailableOn(staffId, date) })
  }

  const weekStart = q.get('weekStart')
  if (weekStart) {
    return NextResponse.json({ ok: true, week: await getWeek(staffId, normalizeWeekStart(weekStart)) })
  }

  return NextResponse.json({ ok: true, weeks: await listWeeks(staffId) })
}
