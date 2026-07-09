import { NextRequest, NextResponse } from 'next/server'
import { COMPANY } from '../../../../lib/company'
import { requireSession } from '../../_lib/session'
import { listBookings } from '../../../../lib/bookings'
import { computeBookingAnalytics } from '../../../../lib/analytics'
import { aiText } from '../../../../lib/ai'

export const maxDuration = 30

// GET /api/admin/ai/insights — plain-English insights over the booking analytics.
export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
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
    const r = await aiText({
      system: 'You are a sharp small-business analyst for ' + COMPANY.legalName + ', a Dallas–Fort Worth box-truck delivery, junk-removal, and property-cleanout company. Be concise, specific, and practical. Use the numbers given. No fluff, no disclaimers.',
      prompt: `Here is the current business data (JSON):\n\n${JSON.stringify(summary, null, 2)}\n\nWrite a short briefing with:\n1. Three to four bullet insights about what's happening (revenue pace vs forecast, where money is coming from, outstanding A/R, job mix).\n2. Two concrete, high-ROI actions the owner should take this week.\nKeep it under 180 words. Use plain text with simple "- " bullets and short section headers.`,
      maxOutputTokens: 600,
      temperature: 0.4,
    })
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 503 })
    return NextResponse.json({ ok: true, insights: r.text, generatedAt: Date.now() })
  } catch (e) {
    console.error('[ai/insights]', e)
    return NextResponse.json({ error: 'Failed to generate insights.' }, { status: 500 })
  }
}
