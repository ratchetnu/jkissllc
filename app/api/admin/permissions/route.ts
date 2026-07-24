// Read-only RBAC matrix projection — gated on permissions:view. Grants are computed
// through `can()`, the SAME primitive the route guards use, so this viewer can never
// disagree with runtime enforcement. There is no write path: the static matrix in
// lib/rbac.ts remains the authoritative, non-configurable model.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { ROLES, PERMISSION_DOMAINS, can, roleLabel } from '../../../lib/rbac'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'permissions:view')
  if (who instanceof NextResponse) return who

  const roles = ROLES.map((r) => ({ id: r, label: roleLabel[r] }))
  const domains = PERMISSION_DOMAINS.map((d) => ({
    domain: d.domain,
    permissions: d.permissions.map((p) => ({ id: p, grantedBy: ROLES.filter((r) => can(r, p)) })),
  }))
  return NextResponse.json({ roles, domains, readOnly: true })
})
