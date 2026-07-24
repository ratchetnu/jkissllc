import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { listInstances, listReminders } from '../../../../lib/reminders'
import { computeCommsAnalytics } from '../../../../lib/comms/analytics'
import { parseDays, windowStartMs } from '../../../../lib/analytics/range'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Communication analytics (request Part 15). Aggregates the ReminderInstance ledger:
// sent / read / ack / completion rates, response time, per-crew compliance, most-missed
// reminder, most-reliable crew. Aggregation lives in lib/comms/analytics (pure, tested,
// redacted); this route just loads + bounds. Response shape is unchanged.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'comms:analytics')
  if (who instanceof NextResponse) return who

  const days = parseDays(new URL(req.url).searchParams.get('days'))
  const [all, reminders] = await Promise.all([listInstances(2000), listReminders(400)])
  const result = computeCommsAnalytics(all, reminders, windowStartMs(days))
  return NextResponse.json({ windowDays: days, ...result })
})
