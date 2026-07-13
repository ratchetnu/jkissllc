import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../../../lib/rate-limit'
import { getBookingByToken } from '../../../../lib/bookings'
import { projectCustomerFinalState } from '../../../../lib/ai/confirmation-ui'
import { customerEstimateView } from '../../../../lib/ai/estimate-store'
import { selectFollowUpQuestions } from '../../../../lib/ai/followup-questions'
import { serviceFamily } from '../../../../lib/bookings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/quote/status/[token] — customer-safe status of a Book Now request, for
// the "Finalizing your estimate" screen + secure continuation / refresh recovery.
//
// The token IS the booking's secure random token (unguessable, tenant-scoped
// through the redis chokepoint). Returns ONLY customer-safe data — never the
// internal pricing breakdown, cost basis, model names, or provider errors.
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (await rateLimit(req, 'quotestatus', 60, 5 * 60_000)) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  }
  const { token } = await ctx.params
  if (!token || !/^[a-zA-Z0-9_-]{16,}$/.test(token)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const b = await getBookingByToken(token)
  if (!b || b.source !== 'online') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const final = projectCustomerFinalState(b)
  return NextResponse.json({
    ok: true,
    requestNumber: b.bookingNumber,
    hasConfirmation: !!b.confirmation,
    confirmationVersion: b.confirmation?.confirmationVersion ?? 0,
    final,
    // For resume: the customer-safe initial detections (no cost basis / margin).
    estimate: b.aiEstimate ? customerEstimateView(b.aiEstimate) : null,
    followUps: b.aiEstimate ? selectFollowUpQuestions({ serviceFamily: serviceFamily(b.serviceType), analysis: b.aiEstimate.analysis }) : [],
  })
}
