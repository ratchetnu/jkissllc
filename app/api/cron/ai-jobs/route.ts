import { NextRequest, NextResponse } from 'next/server'
import { runDueAiJobs } from '../../../lib/book-now-ai'
import { runDueFinalAiJobs } from '../../../lib/book-now-confirmation'
import { notifyOwnerAiOutcome } from '../../../lib/booking-notify'
import { getBookingByToken } from '../../../lib/bookings'
import { withBackgroundTenant } from '../../../lib/platform/tenancy/request-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Durable Book Now AI worker. Runs every few minutes: picks up queued/retrying AI
// jobs whose backoff has elapsed and advances each through the analysis→pricing
// chain, attaching an estimate or scheduling a bounded retry. This is the RECOVERY
// path for the customer-side instant estimate — a request never strands at
// "Awaiting AI". Auth mirrors /api/cron/daily (CRON_SECRET bearer; Vercel injects it).
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // fail closed
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  let summary: { processed: number; results: { token: string; status: string }[] } = { processed: 0, results: [] }
  let finalSummary: { processed: number; results: { token: string; status: string }[] } = { processed: 0, results: [] }
  await withBackgroundTenant('cron', async () => {
    try {
      summary = await runDueAiJobs(10)
      // Owner alerts on terminal outcomes (ready / manual review / failed). Fail-soft:
      // a notification error never affects the durable job state already persisted.
      for (const r of summary.results) {
        if (r.status === 'completed' || r.status === 'manual_review' || r.status === 'failed') {
          try {
            const b = await getBookingByToken(r.token)
            if (b) await notifyOwnerAiOutcome(b, r.status)
          } catch (e) { console.error('[cron/ai-jobs] notify', e) }
        }
      }
    } catch (e) { console.error('[cron/ai-jobs] run', e) }

    // Second (final) analysis recovery: process due FINAL jobs the same way, so a
    // customer who confirms then closes the browser still gets a durable result.
    try {
      finalSummary = await runDueFinalAiJobs(10)
      for (const r of finalSummary.results) {
        if (r.status === 'completed' || r.status === 'manual_review' || r.status === 'failed') {
          try {
            const b = await getBookingByToken(r.token)
            if (b) await notifyOwnerAiOutcome(b, r.status)
          } catch (e) { console.error('[cron/ai-jobs] final notify', e) }
        }
      }
    } catch (e) { console.error('[cron/ai-jobs] final run', e) }
  })
  return NextResponse.json({ ok: true, ...summary, final: finalSummary, at: Date.now() })
}
