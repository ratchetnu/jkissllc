import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { listInstances, listReminders } from '../../../../lib/reminders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Communication analytics (request Part 15). Aggregates the ReminderInstance ledger:
// sent / read / ack / completion rates, average response time, per-crew compliance,
// the most-missed reminder, and the most-reliable crew. All derived — no new store.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'comms:analytics')
  if (who instanceof NextResponse) return who

  const days = Math.min(180, Math.max(1, Number(new URL(req.url).searchParams.get('days')) || 30))
  const since = Date.now() - days * 86_400_000
  const [all, reminders] = await Promise.all([listInstances(2000), listReminders(400)])
  const rows = all.filter(i => i.sentAt >= since)

  const sent = rows.length
  const opened = rows.filter(i => i.openedAt).length
  const ackables = rows.filter(i => i.requireAck)
  const acked = ackables.filter(i => i.ackAt).length
  const completed = ackables.filter(i => i.completedAt).length
  const failed = rows.filter(i => !i.deliveredAt).length

  const responseTimes = rows.filter(i => i.ackAt).map(i => (i.ackAt as number) - i.sentAt)
  const avgResponseMs = responseTimes.length ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : 0
  const lateResponses = responseTimes.filter(ms => ms > 30 * 60_000).length   // > 30 min = late
  const escalations = rows.reduce((n, i) => n + (i.escalatedAt?.length ?? 0), 0)

  // Per-crew compliance (of require-ack sends, how many did they acknowledge?).
  const byCrew = new Map<string, { name: string; sent: number; acked: number; completed: number; totalRespMs: number; responses: number }>()
  for (const i of rows) {
    const c = byCrew.get(i.staffId) ?? { name: i.staffName, sent: 0, acked: 0, completed: 0, totalRespMs: 0, responses: 0 }
    c.sent++
    if (i.ackAt) { c.acked++; c.totalRespMs += (i.ackAt - i.sentAt); c.responses++ }
    if (i.completedAt) c.completed++
    byCrew.set(i.staffId, c)
  }
  const crewCompliance = Array.from(byCrew.entries()).map(([id, c]) => ({
    staffId: id, name: c.name, sent: c.sent, acked: c.acked, completed: c.completed,
    ackRate: c.sent ? Math.round((c.acked / c.sent) * 100) : 0,
    avgResponseMs: c.responses ? Math.round(c.totalRespMs / c.responses) : 0,
  })).sort((a, b) => b.ackRate - a.ackRate || b.sent - a.sent)

  const mostReliable = crewCompliance.filter(c => c.sent >= 2).slice(0, 5)

  // Most-missed reminder (lowest ack rate among require-ack reminders with volume).
  const byReminder = new Map<string, { title: string; sent: number; acked: number }>()
  for (const i of ackables) {
    if (!i.reminderId) continue
    const r = byReminder.get(i.reminderId) ?? { title: i.title, sent: 0, acked: 0 }
    r.sent++; if (i.ackAt) r.acked++
    byReminder.set(i.reminderId, r)
  }
  const reminderRates = Array.from(byReminder.entries()).map(([id, r]) => ({
    reminderId: id, title: r.title, sent: r.sent, acked: r.acked,
    missRate: r.sent ? Math.round(((r.sent - r.acked) / r.sent) * 100) : 0,
  })).filter(r => r.sent >= 2)
  const mostMissed = [...reminderRates].sort((a, b) => b.missRate - a.missRate).slice(0, 5)

  return NextResponse.json({
    windowDays: days,
    totals: {
      sent, opened, acked, completed, failed, escalations, lateResponses,
      readRate: sent ? Math.round((opened / sent) * 100) : 0,
      ackRate: ackables.length ? Math.round((acked / ackables.length) * 100) : 0,
      completionRate: ackables.length ? Math.round((completed / ackables.length) * 100) : 0,
      avgResponseMs,
    },
    crewCompliance,
    mostReliable,
    mostMissed,
    activeReminders: reminders.filter(r => r.active && !r.archived).length,
  })
})
