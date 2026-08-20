import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { crewStatementSummary, listForStaff } from '../../../lib/pay-statements'

// A crew member's OWN issued pay statements (never another person's; void ones are
// hidden). The response is a crew projection: internal/manual-entry provenance stays
// in Operion's admin surface and is never exposed in the portal payload.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const params = new URL(req.url).searchParams
  const offset = Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0)
  const limit = Math.min(100, Math.max(1, Number.parseInt(params.get('limit') ?? '100', 10) || 100))
  const page = await listForStaff(who.staffId, limit, offset)
  const statements = page.filter(s => s.status === 'issued').map(crewStatementSummary)
  return NextResponse.json({ ok: true, statements, nextOffset: page.length === limit ? offset + page.length : null })
})
