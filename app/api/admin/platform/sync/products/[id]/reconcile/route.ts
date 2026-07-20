import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../../../_lib/session'
import { isEnabled } from '../../../../../../../lib/platform/flags'
import { getProduct } from '../../../../../../../lib/platform/sync/store'
import { reconcileOne, syncProductAllowed } from '../../../../../../../lib/platform/sync/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

// POST /api/admin/platform/sync/products/[id]/reconcile — refresh ONE product now.
// Owner only; flag-gated (this is the only place per-product provider READS happen on
// demand). Read-only against GitHub/Vercel; writes nothing to any repo or deployment.
export const POST = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('OPERION_SYNC_STATUS_ENABLED')) {
    return NextResponse.json({ error: 'sync status disabled (OPERION_SYNC_STATUS_ENABLED is off)' }, { status: 403 })
  }
  const { id } = await ctx.params
  if (!syncProductAllowed(id)) return NextResponse.json({ error: 'product reconciliation is not enabled' }, { status: 403 })
  if (!(await getProduct(id))) return NextResponse.json({ error: 'unknown product' }, { status: 404 })
  const rec = await reconcileOne(id, 'manual', { now: Date.now() })
  return NextResponse.json({ ok: true, record: rec })
})
