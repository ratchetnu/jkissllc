import { NextRequest, NextResponse } from 'next/server'
import { rateLimit } from '../../lib/rate-limit'
import { getDepositCents, unitsForLoad } from '../../lib/availability'
import { getDisposalSettings, priceJob, categoryFor } from '../../lib/disposal'
import { getCalibration } from '../../lib/job-learning'

export const dynamic = 'force-dynamic'

const JOB_BASED = ['junk-removal', 'eviction', 'estate-cleanout', 'garage-cleanout']

// POST /api/estimate — instant, email-free price + deposit preview for the booking
// wizard. Uses the disposal-protected pricing for job-based services.
export async function POST(req: NextRequest) {
  if (await rateLimit(req, 'estimate', 30, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many requests. Please wait a moment.' }, { status: 429 })
  }
  const body = await req.json().catch(() => ({}))
  const service = typeof body.service === 'string' ? body.service : 'other'
  const loadSize = typeof body.loadSize === 'string' ? body.loadSize : undefined
  const debris = typeof body.debris === 'string' ? body.debris : undefined

  const depositCents = await getDepositCents()
  const units = unitsForLoad(loadSize)

  if (JOB_BASED.includes(service)) {
    const [settings, calibration] = await Promise.all([getDisposalSettings(), getCalibration()])
    const q = priceJob({ settings, category: categoryFor(service, debris), loadSize, calibration })
    return NextResponse.json({ ok: true, hasPrice: true, low: q.low, high: q.high, confidence: q.confidence, requiresReview: q.requiresReview, landfillTrips: q.landfillTrips, depositCents, units })
  }
  // Non-job-based (moving/appliance/etc.): no instant range, just the deposit to hold.
  return NextResponse.json({ ok: true, hasPrice: false, depositCents, units })
}
