import { NextRequest, NextResponse } from 'next/server'
import { requireCrew } from '../_lib/crew'
import { listInstancesForStaff } from '../../../lib/reminders'
import { buildCrewCards } from '../../../lib/reminder-segments'
import { crewUnreadCount } from '../../../lib/messages'
import { centralToday } from '../../../lib/dates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The crew dashboard feed (request Part 8): today's tasks, urgent alerts, reminders,
// incomplete vs completed, and the crew member's own live status — everything
// actionable in one tap. Scoped to the caller's own staffId (never a request id).
export async function GET(req: NextRequest) {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const staffId = who.staffId
  const today = centralToday()

  const [instances, cards, unread] = await Promise.all([
    listInstancesForStaff(staffId, 200),
    buildCrewCards(),
    crewUnreadCount(staffId, 150),
  ])
  const card = cards.find(c => c.id === staffId) ?? null

  const todays = instances.filter(i => centralToday(i.sentAt) === today)
  const tasks = todays.map(i => ({
    id: i.id, token: i.token, title: i.title, message: i.message, templateId: i.templateId,
    origin: i.origin, requireAck: i.requireAck, ackOptions: i.ackOptions,
    ackKind: i.ackKind ?? null, completedAt: i.completedAt ?? null, openedAt: i.openedAt ?? null,
    sentAt: i.sentAt,
  }))
  const incomplete = tasks.filter(t => t.requireAck && !t.ackKind)
  const completed = tasks.filter(t => t.completedAt || t.ackKind)
  const urgent = tasks.filter(t => (t.origin === 'dispatch') && !t.ackKind)

  return NextResponse.json({
    today,
    unread,
    status: card ? {
      confirmed: card.confirmed, clockIn: card.clockIn, clockOut: card.clockOut,
      uniform: card.uniform, availabilitySubmitted: card.availabilitySubmitted,
      onTimeOff: card.onTimeOff, hasActiveRouteToday: card.hasActiveRouteToday,
    } : null,
    routes: card?.todayRoutes ?? [],
    upcoming: card?.upcomingRoutes ?? [],
    tasks,
    counts: { incomplete: incomplete.length, completed: completed.length, urgent: urgent.length },
  })
}
