// Read-only claims FINANCIAL report for the reporting surface. Gated on reports:view —
// this is the authz reconciliation: READING the claims report is a report concern
// (reports:view), while claims:manage stays for the claims-management route
// (/api/admin/claims), which is unchanged. Same computeClaimsReport engine → identical
// numbers, no calculation duplicated.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { listClaims } from '../../../../lib/claims'
import { computeClaimsReport } from '../../../../lib/claims-report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'reports:view')
  if (who instanceof NextResponse) return who
  try {
    const claims = await listClaims(1000)
    return NextResponse.json({ ok: true, report: computeClaimsReport(claims), generatedAt: Date.now() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/reports/claims]', err)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
})
