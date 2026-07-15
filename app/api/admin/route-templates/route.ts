import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import {
  listTemplates, saveTemplate, generateTemplateId, autoLabel, parseWeekdays, parseCrewByWeekday,
  type RouteTemplate,
} from '../../../lib/route-templates'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'recurring:manage')
  if (who instanceof NextResponse) return who
  try {
    return NextResponse.json({ items: await listTemplates() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[route-templates GET]', err)
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'recurring:manage')
  if (who instanceof NextResponse) return who
  const b = await req.json().catch(() => ({}))
  const businessName = S(b.businessName, 200)
  const reportAddress = S(b.reportAddress, 300)
  const reportTime = S(b.reportTime, 60)
  const weekdays = parseWeekdays(b.weekdays)
  if (!businessName) return NextResponse.json({ error: 'Business/client name is required.' }, { status: 400 })
  if (!reportAddress) return NextResponse.json({ error: 'Report address is required.' }, { status: 400 })
  if (!reportTime) return NextResponse.json({ error: 'Report time is required.' }, { status: 400 })
  if (!weekdays.length) return NextResponse.json({ error: 'Pick at least one day of the week.' }, { status: 400 })
  const label = S(b.label, 120) || autoLabel(businessName, weekdays)

  const now = Date.now()
  const t: RouteTemplate = {
    id: generateTemplateId(), label, businessName, reportAddress, reportTime,
    contactPerson: S(b.contactPerson, 120) || undefined, contactPhone: S(b.contactPhone, 40) || undefined,
    vehicle: S(b.vehicle, 200) || undefined, payRate: S(b.payRate, 80) || undefined,
    description: S(b.description, 2000) || undefined, specialNotes: S(b.specialNotes, 2000) || undefined,
    weekdays,
    crewByWeekday: parseCrewByWeekday(b.crewByWeekday, weekdays),
    defaultStaffId: S(b.defaultStaffId, 80) || undefined,
    active: b.active !== false, createdAt: now, updatedAt: now,
  }
  await saveTemplate(t)
  return NextResponse.json({ ok: true, template: t })
})
