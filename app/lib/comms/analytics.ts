// ── Communications analytics (pure) ──────────────────────────────────────────
// Aggregates the ReminderInstance ledger into delivery/compliance metrics. Extracted
// from app/api/admin/comms/analytics so it is reusable by a UI and unit-testable, and
// so the REDACTION guarantee lives in one place: the output carries only counts, rates,
// staff ids/names, and reminder titles — NEVER a message body, phone number, email,
// or token. Input is already-loaded records; no Redis, no clock beyond the caller's.

export type CommsInstance = {
  staffId: string
  staffName: string
  sentAt: number
  deliveredAt?: number
  openedAt?: number
  ackAt?: number
  completedAt?: number
  requireAck: boolean
  escalatedAt?: number[]
  reminderId?: string
  title: string
}
export type CommsReminder = { active: boolean; archived?: boolean }

export type CrewCompliance = { staffId: string; name: string; sent: number; acked: number; completed: number; ackRate: number; avgResponseMs: number }
export type ReminderMiss = { reminderId: string; title: string; sent: number; acked: number; missRate: number }

export type CommsAnalytics = {
  totals: {
    sent: number; opened: number; acked: number; completed: number; failed: number
    escalations: number; lateResponses: number
    readRate: number; ackRate: number; completionRate: number; avgResponseMs: number
  }
  crewCompliance: CrewCompliance[]
  mostReliable: CrewCompliance[]
  mostMissed: ReminderMiss[]
  activeReminders: number
}

const LATE_MS = 30 * 60_000 // a response slower than 30 min counts as late

export function computeCommsAnalytics(instances: CommsInstance[], reminders: CommsReminder[], sinceMs: number): CommsAnalytics {
  const rows = instances.filter((i) => i.sentAt >= sinceMs)

  const sent = rows.length
  const opened = rows.filter((i) => i.openedAt).length
  const ackables = rows.filter((i) => i.requireAck)
  const acked = ackables.filter((i) => i.ackAt).length
  const completed = ackables.filter((i) => i.completedAt).length
  const failed = rows.filter((i) => !i.deliveredAt).length

  const responseTimes = rows.filter((i) => i.ackAt).map((i) => (i.ackAt as number) - i.sentAt)
  const avgResponseMs = responseTimes.length ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : 0
  const lateResponses = responseTimes.filter((ms) => ms > LATE_MS).length
  const escalations = rows.reduce((n, i) => n + (i.escalatedAt?.length ?? 0), 0)

  const byCrew = new Map<string, { name: string; sent: number; acked: number; completed: number; totalRespMs: number; responses: number }>()
  for (const i of rows) {
    const c = byCrew.get(i.staffId) ?? { name: i.staffName, sent: 0, acked: 0, completed: 0, totalRespMs: 0, responses: 0 }
    c.sent++
    if (i.ackAt) { c.acked++; c.totalRespMs += (i.ackAt - i.sentAt); c.responses++ }
    if (i.completedAt) c.completed++
    byCrew.set(i.staffId, c)
  }
  const crewCompliance: CrewCompliance[] = Array.from(byCrew.entries()).map(([id, c]) => ({
    staffId: id, name: c.name, sent: c.sent, acked: c.acked, completed: c.completed,
    ackRate: c.sent ? Math.round((c.acked / c.sent) * 100) : 0,
    avgResponseMs: c.responses ? Math.round(c.totalRespMs / c.responses) : 0,
  })).sort((a, b) => b.ackRate - a.ackRate || b.sent - a.sent)

  const mostReliable = crewCompliance.filter((c) => c.sent >= 2).slice(0, 5)

  const byReminder = new Map<string, { title: string; sent: number; acked: number }>()
  for (const i of ackables) {
    if (!i.reminderId) continue
    const r = byReminder.get(i.reminderId) ?? { title: i.title, sent: 0, acked: 0 }
    r.sent++; if (i.ackAt) r.acked++
    byReminder.set(i.reminderId, r)
  }
  const reminderRates: ReminderMiss[] = Array.from(byReminder.entries()).map(([id, r]) => ({
    reminderId: id, title: r.title, sent: r.sent, acked: r.acked,
    missRate: r.sent ? Math.round(((r.sent - r.acked) / r.sent) * 100) : 0,
  })).filter((r) => r.sent >= 2)
  const mostMissed = [...reminderRates].sort((a, b) => b.missRate - a.missRate).slice(0, 5)

  return {
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
    activeReminders: reminders.filter((r) => r.active && !r.archived).length,
  }
}
