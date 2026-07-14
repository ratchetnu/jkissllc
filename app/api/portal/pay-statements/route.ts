import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { listForStaff } from '../../../lib/pay-statements'

// A crew member's OWN issued pay statements (never another person's; void ones are
// hidden). Statements only ever exist for approved/completed work — the admin issues
// them from the deterministic engine — so "approved periods only" holds by design.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const statements = (await listForStaff(who.staffId)).filter(s => s.status === 'issued')
  return NextResponse.json({ ok: true, statements })
})
