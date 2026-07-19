import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../_lib/session'
import { getApproval } from '../../../../lib/platform/release/approval-store'
import { listPublishes } from '../../../../lib/platform/release/publish-store'
import { listRollbacks } from '../../../../lib/platform/release/rollback-store'
import { buildReleaseHistory, filterReleaseHistory, type ReleaseHistoryFilter } from '../../../../lib/platform/release/release-history'
import type { ReleaseApproval } from '../../../../lib/platform/release/approval'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/release/history — owner-only, READ-ONLY release history.
// Projects the existing publish + rollback records (with their approvals) into a unified,
// filterable history. Never mutates anything, never executes a release. Filters via query:
// business, environment, status, kind, from, to (epoch ms). No secrets, no provider calls.
const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who

  const [publishes, rollbacks] = await Promise.all([listPublishes(500), listRollbacks(500)])

  // Resolve the approvals referenced by the publishes (dedup).
  const approvalIds = [...new Set(publishes.map((p) => p.approvalId).filter(Boolean) as string[])]
  const approvals = await Promise.all(approvalIds.map(getApproval))
  const approvalsById = new Map<string, ReleaseApproval>()
  approvals.forEach((a) => { if (a) approvalsById.set(a.id, a) })

  const all = buildReleaseHistory({ publishes, approvalsById, rollbacks })

  const q = req.nextUrl.searchParams
  const num = (v: string | null) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined)
  const filter: ReleaseHistoryFilter = {
    businessId: q.get('business') || undefined,
    environment: q.get('environment') || undefined,
    status: q.get('status') || undefined,
    kind: (q.get('kind') as ReleaseHistoryFilter['kind']) || undefined,
    from: num(q.get('from')),
    to: num(q.get('to')),
  }
  const entries = filterReleaseHistory(all, filter)

  // Distinct businesses/statuses present — powers the filter UI without a second query.
  const businesses = [...new Map(all.map((e) => [e.businessId, e.businessSlug])).entries()].map(([id, slug]) => ({ id, slug }))
  return NextResponse.json({ ok: true, count: entries.length, total: all.length, businesses, entries }, { headers: noStore })
})
