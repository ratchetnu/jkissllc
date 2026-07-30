import { NextRequest } from 'next/server'
import { runAutoCancelJob } from '../../../lib/schedule/auto-cancel-job'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// Stale-route auto-cancellation — the cron entry point.
//
// The job body lives in lib/schedule/auto-cancel-job, and selection in
// lib/schedule/auto-cancel. Both take the clock as a parameter; this file is the
// only place that reads the real one.
//
// NOT SCHEDULED. There is deliberately no vercel.json cron entry: this endpoint
// exists, is authenticated, and can be driven by hand for a Preview dry run, but
// nothing fires it automatically. Registering the schedule and enabling
// ROUTE_AUTO_CANCEL_ENABLED are a separate rollout change.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // The ONLY clock read in this feature. Everything downstream receives `now` as an
  // argument, which is what lets the integration suite pin a fixed instant without
  // any query parameter, header, environment override, or Production test hook.
  return runAutoCancelJob(req, Date.now())
}
