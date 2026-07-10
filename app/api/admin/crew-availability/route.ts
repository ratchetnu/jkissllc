import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../_lib/session'
import { getWeek, listWeeks, isAvailableOn, normalizeWeekStart } from '../../../lib/crew-availability'
import { listStaff } from '../../../lib/staff'

// Admin/manager read of crew availability (Part 7: consulted while scheduling).
// availability:view is held by admin + manager. Read-only — crew own their own
// availability; staff never edit it here.
//
//  ?staffId=&weekStart=  → that crew member's week
//  ?staffId=&date=       → { available: true|false|null } for a specific date
//  ?date= (no staffId)   → { availability: { [staffId]: true|false|null } } for all
//                          active crew on that date (the scheduling warning source)
//  ?staffId=             → recent submitted/draft weeks
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'availability:view')
  if (who instanceof NextResponse) return who

  const q = new URL(req.url).searchParams
  const staffId = q.get('staffId')
  const date = q.get('date')

  // Bulk: everyone's availability for one date (route builder warning).
  if (!staffId && date) {
    const staff = (await listStaff()).filter(s => s.active)
    const entries = await Promise.all(staff.map(async s => [s.id, await isAvailableOn(s.id, date)] as const))
    return NextResponse.json({ ok: true, availability: Object.fromEntries(entries) })
  }

  if (!staffId) return NextResponse.json({ ok: false, error: 'staffId required' }, { status: 400 })

  if (date) {
    return NextResponse.json({ ok: true, available: await isAvailableOn(staffId, date) })
  }

  const weekStart = q.get('weekStart')
  if (weekStart) {
    return NextResponse.json({ ok: true, week: await getWeek(staffId, normalizeWeekStart(weekStart)) })
  }

  return NextResponse.json({ ok: true, weeks: await listWeeks(staffId) })
}
