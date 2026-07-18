import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../_lib/session'
import { isEnabled } from '../../../../lib/platform/flags'
import { buildDashboard, reconcileAll } from '../../../../lib/platform/sync/service'
import { seedSyncProducts } from '../../../../lib/platform/sync/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/platform/sync — the multi-product Sync Status dashboard summary.
// Platform-owner only. READ-ONLY: renders whatever the last reconciliations recorded.
// Always available (even flag-off) so the UI can show the disabled state + provider health.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json({ ok: true, dashboard: await buildDashboard() })
})

// POST /api/admin/platform/sync — owner-triggered actions.
//   { action: 'seed' }          → idempotently register the initial product roster (no provider calls).
//   { action: 'reconcile-all' } → reconcile every product now (READ-only GitHub/Vercel). Flag-gated.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const action = typeof body?.action === 'string' ? body.action : ''

  if (action === 'seed') {
    const result = await seedSyncProducts(Date.now())
    return NextResponse.json({ ok: true, ...result })
  }
  if (action === 'reconcile-all') {
    if (!isEnabled('OPERION_SYNC_STATUS_ENABLED')) {
      return NextResponse.json({ error: 'sync status disabled (OPERION_SYNC_STATUS_ENABLED is off)' }, { status: 403 })
    }
    const result = await reconcileAll('manual', { now: Date.now() })
    return NextResponse.json({ ok: true, ...result })
  }
  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
})
