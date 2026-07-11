import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { computeAiAnalytics, computeCostView } from '../../../../lib/ai/analytics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// GET /api/admin/ai/cost — cost forecasting + optimization. Returns the daily spend
// series, month-to-date, projected month-end, trend, cap risk, and explainable
// optimization hints. Estimated costs are reconciled to provider-reported cost when
// the Gateway supplies it (see costSource on the analytics models breakdown).
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'ai:analytics')
  if (who instanceof NextResponse) return who
  try {
    const analytics = await computeAiAnalytics(2000)
    const { forecast, hints } = await computeCostView(analytics, 30)
    return NextResponse.json({
      ok: true,
      forecast,
      hints,
      models: analytics.models,
      totals: { estCostUsd: analytics.totals.estCostUsd, actualCostUsd: analytics.totals.actualCostUsd },
      generatedAt: analytics.generatedAt,
    })
  } catch (e) {
    console.error('[ai/cost]', e)
    return NextResponse.json({ error: 'Failed to load cost view.' }, { status: 500 })
  }
}
