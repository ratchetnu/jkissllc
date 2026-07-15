import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import {
  getTemplate, saveTemplate, deleteTemplate, materializeTemplate, parseWeekdays, parseCrewByWeekday,
} from '../../../../lib/route-templates'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })

export const PATCH = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePermission(req, 'recurring:manage')
  if (who instanceof NextResponse) return who
  const { id } = await params
  const t = await getTemplate(id)
  if (!t) return NextResponse.json({ error: 'Template not found.' }, { status: 404 })

  const b = await req.json().catch(() => ({}))
  const action = S(b.action, 40)

  if (action === 'generate') {
    // Materialize the upcoming window now (default 14 days, capped at 60).
    const horizon = Math.min(60, Math.max(1, Number(b.horizonDays) || 14))
    const { created } = await materializeTemplate(t, dayFmt.format(new Date()), horizon)
    return NextResponse.json({ ok: true, created })
  }
  if (action === 'toggle') {
    t.active = !t.active
    await saveTemplate(t)
    return NextResponse.json({ ok: true, template: t })
  }
  if (action === 'update') {
    const str: Array<[keyof typeof t, number]> = [
      ['label', 120], ['businessName', 200], ['reportAddress', 300], ['reportTime', 60],
      ['contactPerson', 120], ['contactPhone', 40], ['vehicle', 200], ['payRate', 80],
      ['description', 2000], ['specialNotes', 2000], ['defaultStaffId', 80],
    ]
    for (const [k, max] of str) if (b[k] !== undefined) (t as Record<string, unknown>)[k] = S(b[k], max) || undefined
    if (b.weekdays !== undefined) {
      const w = parseWeekdays(b.weekdays)
      if (!w.length) return NextResponse.json({ error: 'Pick at least one day of the week.' }, { status: 400 })
      t.weekdays = w
      // Dropping a weekday must drop its standing crew, or the rule quietly
      // resurrects when that day is re-added.
      if (t.crewByWeekday) t.crewByWeekday = parseCrewByWeekday(t.crewByWeekday, w)
    }
    // Validated against the POST-update weekdays, so crew can be set in the same
    // call that adds the day they run on.
    if (b.crewByWeekday !== undefined) t.crewByWeekday = parseCrewByWeekday(b.crewByWeekday, t.weekdays)
    if (typeof b.active === 'boolean') t.active = b.active
    await saveTemplate(t)
    return NextResponse.json({ ok: true, template: t })
  }
  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
})

export const DELETE = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePermission(req, 'recurring:manage')
  if (who instanceof NextResponse) return who
  const { id } = await params
  await deleteTemplate(id)
  return NextResponse.json({ ok: true })
})
