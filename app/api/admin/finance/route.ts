// Route finance — revenue in, payouts out, profit between. Gated on
// 'profitability:view', which only admins hold (managers are excluded in the RBAC
// matrix). Every response here contains business pricing and profit, which drivers
// and contractors must never see. There is no public projection of this data
// anywhere (see lib/routes.toPublicRouteFor).
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { listRoutes } from '../../../lib/routes'
import { listStaff } from '../../../lib/staff'
import { computeFinance, getFinanceSettings, setFinanceSettings, type FinanceFilters } from '../../../lib/finance'

const P = (v: string | null, max = 80): string | undefined => {
  const s = (v ?? '').trim().slice(0, max)
  return s || undefined
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'profitability:view')
  if (who instanceof NextResponse) return who
  const q = new URL(req.url).searchParams
  const filters: FinanceFilters = {
    start: P(q.get('start'), 10),
    end: P(q.get('end'), 10),
    business: P(q.get('business'), 200),
    staffId: P(q.get('staffId')),
    status: P(q.get('status'), 20),
  }
  try {
    const [routes, staff, settings] = await Promise.all([listRoutes(2000), listStaff(), getFinanceSettings()])
    return NextResponse.json({ summary: computeFinance(routes, staff, filters), settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'finance failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[admin/finance GET]', err)
    return NextResponse.json({ error: 'finance failed' }, { status: 500 })
  }
})

// Update the finance settings (currently just: does the crew's confirmation text
// and page show them their own pay?).
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'profitability:view')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  if (typeof body.showPayInConfirm !== 'boolean') {
    return NextResponse.json({ error: 'showPayInConfirm must be true or false.' }, { status: 400 })
  }
  const settings = await setFinanceSettings({ showPayInConfirm: body.showPayInConfirm })
  return NextResponse.json({ ok: true, settings })
})
