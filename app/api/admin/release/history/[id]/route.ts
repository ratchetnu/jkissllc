import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../_lib/session'
import { getApproval } from '../../../../../lib/platform/release/approval-store'
import { getPublish } from '../../../../../lib/platform/release/publish-store'
import { getRollback, listRollbacks } from '../../../../../lib/platform/release/rollback-store'
import { publishToHistoryEntry, rollbackToHistoryEntry, buildReleaseDetails } from '../../../../../lib/platform/release/release-history'
import { listPlatformAuditForRef } from '../../../../../lib/platform/updates/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/release/history/[id] — owner-only, READ-ONLY release details.
// Resolves one publish (PUB-*) or rollback (RBK-*) record into a full detail view: the
// release entry + its audit trail. Never mutates, never executes. No secrets.
type Ctx = { params: Promise<{ id: string }> }
const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' }

export const GET = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params

  const entry = id.startsWith('RBK-')
    ? await getRollback(id).then((r) => (r ? rollbackToHistoryEntry(r) : null))
    : await getPublish(id).then(async (p) => (p ? publishToHistoryEntry(p, p.approvalId ? await getApproval(p.approvalId) : null, await rollbackReversing(p.id)) : null))

  if (!entry) return NextResponse.json({ ok: false, error: 'release not found' }, { status: 404, headers: noStore })

  const audit = await listPlatformAuditForRef({ businessId: entry.businessId }, 300)
  const details = buildReleaseDetails(entry, audit)
  return NextResponse.json({ ok: true, ...details }, { headers: noStore })
})

/** If a rollback restored a deployment for this business, note its id on the publish entry. */
async function rollbackReversing(publishId: string): Promise<string | undefined> {
  const rollbacks = await listRollbacks(500)
  return rollbacks.find((r) => r.status === 'completed' && r.rolledBackPublishId === publishId)?.id
}
