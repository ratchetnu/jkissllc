import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import {
  getRouteByToken, saveRoute, deleteRoute, setStatus, pushAudit,
  ROUTE_STATUS_LABEL, type RouteStatus,
} from '../../../../lib/routes'
import { assignAndNotify } from '../../../../lib/route-notify'
import { listStaff } from '../../../../lib/staff'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const route = await getRouteByToken(id)
  if (!route) return NextResponse.json({ error: 'Route not found.' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const action = S(body.action, 40)
  let smsWarning: string | undefined

  if (action === 'assign' || action === 'resend') {
    const staffId = action === 'resend' ? route.assignedStaffId ?? '' : S(body.staffId, 80)
    if (!staffId) return NextResponse.json({ error: 'No contractor to text.' }, { status: 400 })
    const staff = (await listStaff()).find(s => s.id === staffId)
    if (!staff) return NextResponse.json({ error: 'Contractor not found.' }, { status: 400 })
    if (action === 'resend') pushAudit(route, 'admin', `Re-sent assignment text to ${staff.name}`)
    const r = await assignAndNotify(route, staff)
    if (!r.ok) smsWarning = r.error
  } else if (action === 'status') {
    const status = S(body.status, 40) as RouteStatus
    if (!(status in ROUTE_STATUS_LABEL)) return NextResponse.json({ error: 'Invalid status.' }, { status: 400 })
    // Stamp completion metadata when an admin closes a route out by hand.
    if (status === 'completed' && !route.completedAt) {
      route.completedAt = Date.now()
      route.completedBy = 'admin'
    }
    setStatus(route, status, 'admin', S(body.note, 300) || undefined)
  } else if (action === 'update') {
    // Edit route details (kept simple — admin-trusted, audited).
    const fields: Array<[keyof typeof route, number]> = [
      ['businessName', 200], ['contactPerson', 120], ['contactPhone', 40], ['reportAddress', 300],
      ['reportTime', 60], ['routeDate', 20], ['description', 2000], ['payRate', 80],
      ['vehicle', 200], ['specialNotes', 2000],
    ]
    for (const [k, max] of fields) {
      if (body[k] !== undefined) (route as Record<string, unknown>)[k] = S(body[k], max) || undefined
    }
    pushAudit(route, 'admin', 'Route details edited')
  } else {
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  }

  await saveRoute(route)
  return NextResponse.json({ ok: true, route, smsWarning })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  await deleteRoute(id)
  return NextResponse.json({ ok: true })
}
