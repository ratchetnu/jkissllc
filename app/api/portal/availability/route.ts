import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { getOrInitWeek, saveWeek, normalizeWeekStart } from '../../../lib/crew-availability'
import { centralToday, mondayOf, addDaysStr } from '../../../lib/dates'

// Crew submit their OWN weekly availability. Scoped to the token's staffId — the
// weekStart comes from the request but the staffId never does.
//
// GET  ?weekStart=YYYY-MM-DD  → that week (defaults to the current week), plus a
//      short list of the upcoming week-starts the UI offers.
// POST { weekStart, days, submit }  → save draft or submit.

function upcomingWeekStarts(count = 5): string[] {
  const thisMonday = mondayOf(centralToday())
  return Array.from({ length: count }, (_, i) => addDaysStr(thisMonday, i * 7))
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const qWeek = new URL(req.url).searchParams.get('weekStart')
  const weekStart = qWeek ? normalizeWeekStart(qWeek) : mondayOf(centralToday())
  const week = await getOrInitWeek(who.staffId, weekStart)
  return NextResponse.json({ ok: true, week, weekOptions: upcomingWeekStarts() })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({}))
  const weekStart = normalizeWeekStart(String(body?.weekStart ?? ''))

  // Availability is forward-looking: don't let a crew member rewrite a week that
  // has already passed (its Sunday is before today).
  if (addDaysStr(weekStart, 6) < centralToday()) {
    return NextResponse.json({ ok: false, error: 'That week has already passed.' }, { status: 400 })
  }

  const week = await saveWeek(who.staffId, weekStart, body?.days, !!body?.submit)
  return NextResponse.json({ ok: true, week })
})
