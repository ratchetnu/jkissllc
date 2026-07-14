import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { listRoutes } from '../../../lib/routes'
import { getFinanceSettings } from '../../../lib/finance'
import { centralToday } from '../../../lib/dates'

// My routes — only the routes this crew member is an assignee on. Pay figures are
// included only when the owner has opted to show pay to crew (showPayInConfirm),
// matching the confirmation-link behavior.
const DONE = new Set(['completed', 'cancelled', 'declined'])

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const [all, fin] = await Promise.all([listRoutes(500), getFinanceSettings()])
  const showPay = !!fin?.showPayInConfirm
  const today = centralToday()

  const mine = all
    .map(r => {
      const me = r.assignees?.find(a => a.staffId === who.staffId)
      if (!me) return null
      return {
        routeNumber: r.routeNumber,
        token: me.token,                 // their own confirm/clock link
        businessName: r.businessName,
        reportAddress: r.reportAddress,
        reportTime: r.reportTime,
        routeDate: r.routeDate,
        status: r.status,
        description: r.description ?? null,
        specialNotes: r.specialNotes ?? null,
        vehicle: r.vehicle ?? null,
        role: me.role ?? null,
        payCents: showPay ? (me.payCents ?? null) : null,
        confirmedAt: me.confirmedAt ?? null,
        declinedAt: me.declinedAt ?? null,
        clockInAt: me.clockInAt ?? null,
        clockOutAt: me.clockOutAt ?? null,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const upcoming = mine
    .filter(r => r.routeDate >= today && !DONE.has(r.status))
    .sort((a, b) => a.routeDate.localeCompare(b.routeDate))
  const past = mine
    .filter(r => r.routeDate < today || DONE.has(r.status))
    .sort((a, b) => b.routeDate.localeCompare(a.routeDate))
    .slice(0, 50)

  return NextResponse.json({ ok: true, upcoming, past, showPay })
})
