import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../../_lib/crew'
import { crewPayStatement, getStatement, recordedYtdForStatement } from '../../../../lib/pay-statements'
import { formatBusinessAddress, getBusinessAddress } from '../../../../lib/business-address'

// One of the crew member's OWN statements. Ownership is enforced against the
// token's staffId — a crew member can never fetch someone else's statement by id.
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const { id } = await params
  const statement = await getStatement(id)
  if (!statement || statement.staffId !== who.staffId || statement.status !== 'issued') {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 })
  }
  const [ytd, businessAddress] = await Promise.all([recordedYtdForStatement(statement), getBusinessAddress()])
  return NextResponse.json({ ok: true, statement: crewPayStatement(statement), ytd, businessAddress: formatBusinessAddress(businessAddress) })
})
