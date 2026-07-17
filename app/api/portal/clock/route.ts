import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { pushEvent, pushAuditFor } from '../../../lib/routes'
import { mutateByConfirmToken, RouteBusyError } from '../../../lib/route-mutex'
import { alertOwnerClockLocationOff } from '../../../lib/route-notify'
import {
  listClockableForStaff,
  pickActiveClockable,
  applyPunch,
  crewUsesTimeclock,
  type ClockAction,
  type PunchResult,
} from '../../../lib/crew-timeclock'
import { centralToday } from '../../../lib/dates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Session-authenticated crew timeclock. Unlike the public route-link endpoint, the
// caller is identified by their signed session (requireCrew → staffId) and every
// action is scoped to their own assignments. The clock/GPS fields already live on
// the route's Assignee; we mutate them under the route lock and never touch the
// route schema. Gated on the crew member's own `usesTimeclock` toggle.

// GET — today's clockable assignments + whether the timeclock is enabled for me.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const [enabled, routes] = await Promise.all([
    crewUsesTimeclock(who.staffId),
    listClockableForStaff(who.staffId),
  ])
  return NextResponse.json({ enabled, today: centralToday(), routes })
})

// POST — punch in/out. Body: { action: 'clock_in'|'clock_out', token?, lat?, lng?,
// accuracy?, locationDenied? }. `token` names a specific assignment; when omitted we
// act on today's single active one. Ownership is re-verified under the lock.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  if (!(await crewUsesTimeclock(who.staffId))) {
    return NextResponse.json(
      { error: 'The timeclock is turned off for you. Contact dispatch if this is a mistake.' },
      { status: 403 },
    )
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const action: ClockAction | null =
    body.action === 'clock_out' ? 'clock_out' : body.action === 'clock_in' ? 'clock_in' : null
  if (!action) return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })

  // Resolve the target assignment from the caller's OWN clockable routes — never
  // from a bare token off the wire. If a token is supplied it must match one of them.
  const clockable = await listClockableForStaff(who.staffId)
  const wantToken = typeof body.token === 'string' ? body.token : ''
  const target = wantToken
    ? clockable.find((c) => c.assigneeToken === wantToken)
    : pickActiveClockable(clockable)
  if (!target) {
    return NextResponse.json(
      { error: wantToken ? 'That route isn’t available to clock into.' : 'You have no confirmed route to clock into today.' },
      { status: 409 },
    )
  }

  const gps = { lat: body.lat, lng: body.lng, accuracy: body.accuracy, locationDenied: body.locationDenied }
  let outcome: PunchResult | undefined
  let ownershipOk = true
  let crewName = ''

  let res
  try {
    res = await mutateByConfirmToken(target.assigneeToken, (route, assignee) => {
      // Defense in depth: the token must still map to THIS crew member under the lock.
      if (assignee.staffId !== who.staffId) {
        ownershipOk = false
        return false
      }
      crewName = assignee.name
      const r = applyPunch(assignee, action, gps, Date.now())
      outcome = r
      if (!r.ok || !r.changed) return false // no save on error / idempotent no-op
      pushEvent(route, action)
      pushAuditFor(route, { sub: who.sub, role: who.role }, 'contractor',
        `${assignee.name} ${action === 'clock_in' ? 'clocked in' : 'clocked out'} from the portal${r.denied ? ' (location off)' : ''}`)
      return true
    })
  } catch (e) {
    if (e instanceof RouteBusyError) {
      return NextResponse.json({ error: 'The route is being updated — please try again.' }, { status: 503 })
    }
    throw e
  }

  if (res === null || !ownershipOk) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (!outcome) return NextResponse.json({ error: 'Could not clock — please try again.' }, { status: 500 })
  if (!outcome.ok) {
    if (outcome.code === 'not_confirmed')
      return NextResponse.json({ error: 'Please confirm the route before clocking in.' }, { status: 409 })
    return NextResponse.json({ error: 'Clock in before you clock out.' }, { status: 409 })
  }

  // Location off → tell the owner in real time (best-effort, after the lock releases).
  if (outcome.changed && outcome.denied) {
    try {
      await alertOwnerClockLocationOff(res.route, { name: crewName }, action)
    } catch {
      /* non-fatal */
    }
  }

  return NextResponse.json({ ok: true, already: outcome.already, denied: outcome.denied })
})
