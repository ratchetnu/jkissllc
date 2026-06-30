import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import { DEBRIS_CATEGORIES, type DebrisCategory } from '../../../../lib/disposal'
import { listOutcomes, getCalibration, recordJobOutcome, accuracyStats, type JobOutcome } from '../../../../lib/job-learning'

export const dynamic = 'force-dynamic'

// GET — recent completed-job history + the learned calibration + accuracy stats.
export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const outcomes = await listOutcomes(50)
  return NextResponse.json({ ok: true, outcomes, calibration: await getCalibration(), stats: accuracyStats(outcomes) })
}

const num = (v: unknown) => Math.max(0, Math.round(Number(v) || 0))
const dollarsToCents = (v: unknown) => Math.round((Number(v) || 0) * 100)

// POST — log what actually happened on a completed job. Dollar amounts come in as
// dollars; fill % as whole numbers. This folds into the per-category fill bias.
export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const b = await req.json().catch(() => ({}))

  const category: DebrisCategory = (DEBRIS_CATEGORIES as string[]).includes(b.category) ? b.category : 'general'
  if (!(num(b.actualFillPct) > 0) || !(num(b.estFillPct) > 0)) {
    return NextResponse.json({ error: 'Estimated and actual truck fill % are required.' }, { status: 400 })
  }

  const id = `${(b.date || '').toString().slice(0, 10) || 'job'}-${num(b.actualTrips)}-${Math.abs(num(b.finalPrice))}`
  const outcome: JobOutcome = {
    id,
    date: (typeof b.date === 'string' && b.date) ? b.date.slice(0, 10) : new Date(Number(b.now) || 0).toISOString().slice(0, 10),
    category,
    service: typeof b.service === 'string' ? b.service.slice(0, 40) : undefined,
    estFillPct: num(b.estFillPct), actualFillPct: num(b.actualFillPct),
    estTrips: Math.max(1, num(b.estTrips)), actualTrips: Math.max(1, num(b.actualTrips)),
    estDisposalCents: dollarsToCents(b.estDisposal), actualDisposalCents: dollarsToCents(b.actualDisposal),
    estLaborCents: dollarsToCents(b.estLabor), actualLaborCents: dollarsToCents(b.actualLabor),
    estProfitCents: dollarsToCents(b.estProfit), actualProfitCents: dollarsToCents(b.actualProfit),
    finalPriceCents: dollarsToCents(b.finalPrice),
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 300) : undefined,
  }

  const calibration = await recordJobOutcome(outcome)
  const outcomes = await listOutcomes(50)
  return NextResponse.json({ ok: true, calibration, outcomes, stats: accuracyStats(outcomes) })
}
