import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import {
  listRoutes, saveRoute, generateToken, nextRouteNumber, pushAudit,
  type RouteRecord,
} from '../../../lib/routes'
import { assignAndNotify } from '../../../lib/route-notify'
import { contractorStatsObject } from '../../../lib/route-stats'
import { listStaff } from '../../../lib/staff'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    // One scan: load once, derive stats from the same list, return the newest 500.
    const routes = await listRoutes(1000)
    const stats = await contractorStatsObject(routes)
    return NextResponse.json({ items: routes.slice(0, 500), stats })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/routes GET]', err)
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))

  const businessName = S(body.businessName, 200)
  const reportAddress = S(body.reportAddress, 300)
  const reportTime = S(body.reportTime, 60)
  const routeDate = S(body.routeDate, 20)
  if (!businessName) return NextResponse.json({ error: 'Business/client name is required.' }, { status: 400 })
  if (!reportAddress) return NextResponse.json({ error: 'Report/pickup address is required.' }, { status: 400 })
  if (!reportTime) return NextResponse.json({ error: 'Report time is required.' }, { status: 400 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(routeDate)) return NextResponse.json({ error: 'A valid route date is required.' }, { status: 400 })

  const now = Date.now()
  const route: RouteRecord = {
    token: generateToken(),
    routeNumber: await nextRouteNumber(),
    status: 'draft',
    businessName,
    contactPerson: S(body.contactPerson, 120) || undefined,
    contactPhone: S(body.contactPhone, 40) || undefined,
    reportAddress,
    reportTime,
    routeDate,
    description: S(body.description, 2000) || undefined,
    payRate: S(body.payRate, 80) || undefined,
    vehicle: S(body.vehicle, 200) || 'Box truck',   // J KISS is box-truck only
    specialNotes: S(body.specialNotes, 2000) || undefined,
    events: [],
    audit: [],
    createdAt: now,
    updatedAt: now,
    createdBy: 'admin',
  }
  pushAudit(route, 'admin', `Route created for ${businessName}`)

  // Optionally assign + text a contractor in the same step.
  let smsWarning: string | undefined
  const staffId = S(body.staffId, 80)
  if (staffId) {
    const staff = (await listStaff()).find(s => s.id === staffId)
    if (!staff) return NextResponse.json({ error: 'Selected contractor not found.' }, { status: 400 })
    const r = await assignAndNotify(route, staff)
    if (!r.ok) smsWarning = r.error
  }

  await saveRoute(route)
  return NextResponse.json({ ok: true, route, smsWarning })
}
