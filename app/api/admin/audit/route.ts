// Audit-log viewer API — read-only, gated on audit:view. Tenant-scoped by
// construction: queryAudit reads the tenant-namespaced audit index (redis chokepoint),
// so a caller only ever sees their own tenant's records.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { queryAudit, type AuditFilter } from '../../../lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const dayMs = (v: string | null): number | undefined => {
  if (!v) return undefined
  const n = Date.parse(v)
  return Number.isFinite(n) ? n : undefined
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'audit:view')
  if (who instanceof NextResponse) return who

  const url = new URL(req.url)
  const start = dayMs(url.searchParams.get('start'))
  const endDay = dayMs(url.searchParams.get('end'))
  const filter: AuditFilter = {
    actor: url.searchParams.get('actor') || undefined,
    action: url.searchParams.get('action') || undefined,
    entity: url.searchParams.get('entity') || undefined,
    outcome: url.searchParams.get('outcome') || undefined,
    start,
    end: endDay != null ? endDay + 86_399_999 : undefined, // inclusive end-of-day
    search: url.searchParams.get('q') || undefined,
  }
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10) || 200))
  const entries = await queryAudit(filter, limit)
  return NextResponse.json({ entries, count: entries.length, limit })
})
