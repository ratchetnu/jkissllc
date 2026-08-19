import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { getBusinessAddress, saveBusinessAddress } from '../../../lib/business-address'
import { auditAdmin } from '../../../lib/audit'

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who
  return NextResponse.json({ address: await getBusinessAddress() })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => null)
  const result = await saveBusinessAddress(body)
  if (!result.address) return NextResponse.json({ error: result.error }, { status: 400 })
  await auditAdmin(who, 'settings.business_address_updated', {
    entity: 'business_settings',
    entityId: 'address',
    summary: `Updated business address to ${result.address.city}, ${result.address.state} ${result.address.postalCode}`,
    meta: { city: result.address.city, state: result.address.state, postalCode: result.address.postalCode },
  })
  return NextResponse.json({ address: result.address })
})
