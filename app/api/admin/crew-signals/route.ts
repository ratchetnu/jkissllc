import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../_lib/session'
import { listStaff } from '../../../lib/staff'
import { listClaims } from '../../../lib/claims'
import { countSubmittedUpcoming } from '../../../lib/crew-availability'
import { centralToday, mondayOf } from '../../../lib/dates'

// Per-crew extra signals that feed the Crew Score's availability + incident factors
// (the two that read "not measured" without this). Admin/manager only
// (crew:score:view). Computed server-side where the availability and claims data
// live, so the client passes them straight into buildCrewScore().
//
// A "waived" claim isn't counted as an incident (it was forgiven); everything else
// they're assigned to is.
const AVAIL_WINDOW = 4

export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'crew:score:view')
  if (who instanceof NextResponse) return who

  const staff = (await listStaff()).filter(s => s.active)
  const fromWeek = mondayOf(centralToday())

  // Incidents: count claims (not waived) each crew member is assigned to.
  const claims = await listClaims()
  const incidents: Record<string, number> = {}
  for (const c of claims) {
    if (c.status === 'waived') continue
    for (const a of c.assignments ?? []) {
      incidents[a.staffId] = (incidents[a.staffId] ?? 0) + 1
    }
  }

  const signals: Record<string, { availabilityWeeksSubmitted: number; availabilityWeeksExpected: number; incidents: number }> = {}
  await Promise.all(staff.map(async s => {
    signals[s.id] = {
      availabilityWeeksSubmitted: await countSubmittedUpcoming(s.id, fromWeek, AVAIL_WINDOW),
      availabilityWeeksExpected: AVAIL_WINDOW,
      incidents: incidents[s.id] ?? 0,
    }
  }))

  return NextResponse.json({ ok: true, signals })
}
