import { NextRequest, NextResponse } from 'next/server'
import { requirePermission } from '../../_lib/session'
import { listBookings } from '../../../../lib/bookings'
import { computeBookingAnalytics } from '../../../../lib/analytics'
import { runAiTask } from '../../../../lib/ai/service'

export const maxDuration = 30

// GET /api/admin/ai/insights — plain-English insights over the booking analytics.
export async function GET(req: NextRequest) {
  const who = await requirePermission(req, 'ai:use')
  if (who instanceof NextResponse) return who
  try {
    const bookings = await listBookings(1000)
    const a = computeBookingAnalytics(bookings, Date.now())
    const usd = (c: number) => `$${Math.round(c / 100)}`
    const summary = {
      revenue: { today: usd(a.revenue.today), week: usd(a.revenue.week), month: usd(a.revenue.month), year: usd(a.revenue.year), allTime: usd(a.revenue.allTime), forecastMonth: usd(a.revenue.forecastMonth), avgPerDay: usd(a.revenue.avgDaily30) },
      jobs: a.jobs,
      averageTicket: usd(a.averageTicketCents),
      outstanding: usd(a.outstandingCents),
      paymentStatus: a.paymentStatus,
      byService: a.byService.map(s => ({ service: s.key, revenue: usd(s.amountCents), jobs: s.count })),
      byCity: a.byCity.slice(0, 5).map(s => ({ city: s.key, revenue: usd(s.amountCents), jobs: s.count })),
      disposalCost: usd(a.disposal.totalCents),
      netAfterDisposal: usd(a.disposal.netAfterDisposalCents),
      refunds: usd(a.refunds.totalCents),
      refundRate: `${(a.refunds.rate * 100).toFixed(1)}%`,
      reviews: a.reviews,
    }
    const result = await runAiTask({
      taskId: 'ops.insights', feature: 'ops.insights', requiredPermission: 'ai:use',
      principal: { sub: who.sub, role: who.role },
      vars: { summaryJson: JSON.stringify(summary, null, 2) },
      maxOutputTokens: 600, temperature: 0.4,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true, insights: result.text, generatedAt: Date.now(), callId: result.callId })
  } catch (e) {
    console.error('[ai/insights]', e)
    return NextResponse.json({ error: 'Failed to generate insights.' }, { status: 500 })
  }
}
