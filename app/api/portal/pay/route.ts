import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { listRoutes } from '../../../lib/routes'
import { computeCrewComp } from '../../../lib/crew-comp'
import { computePay } from '../../../lib/route-pay'
import { getFinanceSettings } from '../../../lib/finance'
import { centralToday, mondayOf } from '../../../lib/dates'
import { recordedYtdForStaff } from '../../../lib/pay-statements'

// My earnings — computed ONLY from completed work already snapshotted onto routes
// (see lib/crew-comp: truthful, never fabricated). Scoped to the caller's staffId.
// Honors the owner's showPayInConfirm setting: when off, amounts are withheld
// (crew still see their schedule/routes, just not dollar figures).
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const fin = await getFinanceSettings()
  if (!fin?.showPayInConfirm) {
    return NextResponse.json({ ok: true, visible: false })
  }

  const routes = await listRoutes(1000)
  const today = centralToday()

  // Earnings must be the SAME number Admin payroll computes. computePay applies the
  // one effective model (corrections + compensation snapshots, hourly or flat); we
  // project its per-route amounts back onto this crew member's assignments so the
  // portal cannot drift from payroll. Legacy flat pay resolves to itself, so a
  // deployment with neither corrections nor snapshots is unchanged.
  const effective = new Map<string, number>()
  try {
    const lifetime = await computePay('1970-01-01', '2999-12-31')
    const mine = lifetime.contractors.find(c => c.staffId === who.staffId)
    for (const line of mine?.routes ?? []) {
      if (line.source === 'booking') continue          // this surface is the routes lane
      if (line.amountCents != null) effective.set(line.routeNumber, line.amountCents)
    }
  } catch { /* fall back to the stored snapshot below — never block the portal */ }

  const projected = routes.map(r => ({
    ...r,
    assignees: (r.assignees ?? []).map(a => (
      a.staffId === who.staffId && effective.has(r.routeNumber)
        ? { ...a, effectivePayCents: effective.get(r.routeNumber) }
        : a
    )),
  }))

  const summary = computeCrewComp(who.staffId, projected, today, mondayOf(today))
  const issuedYtd = await recordedYtdForStaff(who.staffId, today)
  return NextResponse.json({ ok: true, visible: true, summary: { ...summary, issuedYtd } })
})
