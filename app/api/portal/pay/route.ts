import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { listRoutes } from '../../../lib/routes'
import { computeCrewComp } from '../../../lib/crew-comp'
import { getFinanceSettings } from '../../../lib/finance'
import { centralToday, mondayOf } from '../../../lib/dates'

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
  const summary = computeCrewComp(who.staffId, routes, today, mondayOf(today))
  return NextResponse.json({ ok: true, visible: true, summary })
})
