import { listRoutes, type RouteRecord } from './routes'
import { centralToday, addDaysStr, weekdayOf } from './dates'
import { getTemplate, type ReminderChannel, type AckKind } from './reminder-templates'
import {
  listReminders, getReminder, createInstance, saveInstance, claimOccurrence, bumpReminderStats,
  saveReminder, listOpenInstances,
  type Reminder, type ReminderInstance, type ReminderSchedule, type InstanceOrigin,
} from './reminders'
import {
  buildCrewCards, isSuppressedForTemplate, filterBySegment, type CrewCard,
} from './reminder-segments'
import { deliverToCrew, ackUrlFor } from './crew-notify'
import { recordAudit } from './audit'
import { sendOwnerAlert } from './owner-alerts'
import { COMPANY } from './company'

// The reminder engine (request Parts 2, 4, 6, 10). Two scheduled passes plus an
// immediate-send path:
//   • runDueReminders  — fire every active reminder whose schedule is due this tick,
//                        after smart suppression + occurrence dedup.
//   • runEscalations   — walk unacknowledged require-ack sends and apply escalation.
//   • sendImmediate    — dispatch quick-blasts + command-center bulk sends (bypass
//                        the schedule entirely, request Parts 13-14).
//
// Everything is Central-time aware (request Part 10). Because routes carry no
// structured start time (only a free-text reportTime), route-relative timing is
// best-effort parsed and skipped when unparseable — never guessed wildly.

const CATCHUP_MIN = 120     // fire a time-based reminder up to 2h late (cron gap tolerance)
const DEFAULT_ROUTE_LEN_MIN = 480   // assumed shift length for route_end when no end time

// ── Central time-of-day ──────────────────────────────────────────────────────
function centralMinutesOfDay(now: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(now))
  let h = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0')
  if (h === 24) h = 0
  return h * 60 + m
}
const centralWeekday = (now: number): number => weekdayOf(centralToday(now))

function hmToMinutes(hm: string | undefined): number | null {
  if (!hm || !/^\d{1,2}:\d{2}$/.test(hm)) return null
  const [h, m] = hm.split(':').map(Number)
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

// Tolerant parse of a free-text clock string ("7:00 AM", "7am", "07:00", "13:00").
function parseClockToMinutes(s: string | undefined): number | null {
  if (!s) return null
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? '0')
  const ap = m[3]?.toLowerCase()
  if (ap) { if (h === 12) h = 0; if (ap === 'pm') h += 12 }
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

// Is a time-of-day due right now, allowing a catch-up window for cron gaps?
function timeDue(schedMin: number | null, nowMin: number): boolean {
  if (schedMin == null) return false
  return nowMin >= schedMin && nowMin < schedMin + CATCHUP_MIN
}

const TERMINAL = new Set(['completed', 'cancelled', 'no_show', 'declined'])

// ── Target resolution ────────────────────────────────────────────────────────
function resolveTargetCards(r: Reminder, cards: CrewCard[], routes: RouteRecord[]): CrewCard[] {
  const byId = new Map(cards.map(c => [c.id, c]))
  let out: CrewCard[]
  switch (r.target.mode) {
    case 'all': out = cards.slice(); break
    case 'crew': out = (r.target.staffIds ?? []).map(id => byId.get(id)).filter((c): c is CrewCard => !!c); break
    case 'business': {
      const keys = new Set(r.target.businessKeys ?? [])
      out = cards.filter(c => c.businessKeys.some(k => keys.has(k)))
      break
    }
    case 'segment': out = r.target.segment ? filterBySegment(cards, r.target.segment) : []; break
    case 'route': {
      const toks = new Set(r.target.routeTokens ?? [])
      const staffIds = new Set<string>()
      for (const rt of routes) {
        if (toks.has(rt.token)) for (const a of rt.assignees ?? []) staffIds.add(a.staffId)
      }
      out = cards.filter(c => staffIds.has(c.id))
      break
    }
    default: out = []
  }
  // Manager scope: never let a scoped reminder reach crew outside the author's
  // businesses (enforced again server-side at create time).
  if (r.scopeBusinessKeys && r.scopeBusinessKeys.length) {
    const scope = new Set(r.scopeBusinessKeys)
    out = out.filter(c => c.businessKeys.some(k => scope.has(k)))
  }
  return out.filter(c => c.active)
}

// Per-route fire minute for route-relative schedules.
function routeFireMinutes(route: RouteRecord, sched: ReminderSchedule): number | null {
  const start = parseClockToMinutes(route.reportTime)
  if (start == null) return null
  if (sched.kind === 'route_start') return start
  if (sched.kind === 'route_end') return Math.min(start + DEFAULT_ROUTE_LEN_MIN, 23 * 60 + 59)
  if (sched.kind === 'route_relative') return start + (sched.offsetMinutes ?? 0)
  return null
}

// ── Single send (with suppression + dedup) ───────────────────────────────────
async function trySend(
  r: Reminder,
  card: CrewCard,
  occurrenceKey: string,
  routeToken: string | undefined,
  now: number,
): Promise<boolean> {
  const t = getTemplate(r.templateId)
  // Universal guards (request Part 4): no reminders during approved time off.
  if (card.onTimeOff) return false
  // Route-linked templates need an active route context.
  if (t.routeLinked && !routeToken && !card.hasActiveRouteToday) return false
  // Smart suppression — skip when the task is already done.
  if (r.smartSuppress && isSuppressedForTemplate(card, t.suppress, t.id)) return false
  // Duplicate prevention — one send per occurrence, atomically.
  if (!(await claimOccurrence(occurrenceKey))) return false

  const inst = await createInstance({
    reminderId: r.id, templateId: r.templateId, title: r.title, message: r.message,
    origin: 'schedule',
    staffId: card.id, staffName: card.name, staffPhone: card.phone, staffEmail: card.email,
    businessKey: card.businessKeys[0], routeToken,
    occurrenceKey, channels: r.channels,
    requireAck: r.requireAck, ackOptions: r.ackOptions,
    sentAt: now, escalation: r.escalation,
    createdBy: r.createdBy, createdByRole: r.createdByRole,
  })

  const ackUrl = r.requireAck ? ackUrlFor(inst.token) : undefined
  const res = await deliverToCrew({
    staff: { id: card.id, name: card.name, phone: card.phone, email: card.email },
    title: r.title, message: r.message, channels: r.channels, kind: 'reminder',
    reminderId: r.id, ackUrl, tags: ['reminder', r.templateId],
  })
  inst.channelResults = res.channelResults
  inst.messageId = res.messageId
  if (res.anyDelivered) inst.deliveredAt = now
  await saveInstance(inst)
  await bumpReminderStats(r.id, { sent: 1, delivered: res.anyDelivered ? 1 : 0, failed: res.anyDelivered ? 0 : 1 })
  await recordAudit({
    actor: 'system', actorRole: 'system', action: 'reminder.sent',
    entity: 'reminder_instance', entityId: inst.id,
    summary: `Sent "${r.title}" to ${card.name}${res.anyDelivered ? '' : ' (no channel delivered)'}`,
    meta: { reminderId: r.id, channels: res.channelResults },
  })
  return true
}

// ── Pass 1: due reminders ────────────────────────────────────────────────────
export async function runDueReminders(now: number = Date.now()): Promise<{ evaluated: number; sent: number }> {
  const [reminders, routes, cards] = await Promise.all([
    listReminders(500), listRoutes(1000), buildCrewCards(now),
  ])
  const today = centralToday(now)
  const tomorrow = addDaysStr(today, 1)
  const nowMin = centralMinutesOfDay(now)
  const dow = centralWeekday(now)
  let sent = 0
  let evaluated = 0

  for (const r of reminders) {
    if (!r.active || r.paused || r.archived) continue
    evaluated++
    const sched = r.schedule
    let firedAny = false

    if (sched.kind === 'one_time') {
      if (sched.date !== today) continue
      if (!timeDue(hmToMinutes(sched.time), nowMin)) continue
      for (const card of resolveTargetCards(r, cards, routes)) {
        if (await trySend(r, card, `${r.id}:${card.id}:${today}:${sched.time}`, undefined, now)) { sent++; firedAny = true }
      }
    } else if (sched.kind === 'daily') {
      if (!timeDue(hmToMinutes(sched.time), nowMin)) continue
      for (const card of resolveTargetCards(r, cards, routes)) {
        if (await trySend(r, card, `${r.id}:${card.id}:${today}:${sched.time}`, undefined, now)) { sent++; firedAny = true }
      }
    } else if (sched.kind === 'weekly') {
      if (!(sched.weekdays ?? []).includes(dow)) continue
      if (!timeDue(hmToMinutes(sched.time), nowMin)) continue
      for (const card of resolveTargetCards(r, cards, routes)) {
        if (await trySend(r, card, `${r.id}:${card.id}:${today}:${sched.time}`, undefined, now)) { sent++; firedAny = true }
      }
    } else {
      // Route-based (route_relative / route_start / route_end). One occurrence per
      // (reminder, crew, route). Only today's + tomorrow's non-terminal routes.
      const window = new Set([today, tomorrow])
      const cardById = new Map(cards.map(c => [c.id, c]))
      const targetCardIds = new Set(resolveTargetCards(r, cards, routes).map(c => c.id))
      for (const route of routes) {
        if (!window.has(route.routeDate) || TERMINAL.has(route.status)) continue
        // Respect route-mode targeting explicitly.
        if (r.target.mode === 'route' && !(r.target.routeTokens ?? []).includes(route.token)) continue
        const fireMin = routeFireMinutes(route, sched)
        if (!timeDue(fireMin, nowMin)) continue
        for (const a of route.assignees ?? []) {
          if (!targetCardIds.has(a.staffId)) continue
          const card = cardById.get(a.staffId)
          if (!card) continue
          if (await trySend(r, card, `${r.id}:${a.staffId}:${route.token}:${sched.kind}`, route.token, now)) { sent++; firedAny = true }
        }
      }
    }

    // Re-read before stamping lastRunAt: trySend's bumpReminderStats already
    // persisted stat increments on a fresh copy, so saving our stale `r` here would
    // clobber them (stats.sent would stay 0). Stamp on the fresh record instead.
    if (firedAny) {
      const fresh = await getReminder(r.id)
      if (fresh) { fresh.lastRunAt = now; await saveReminder(fresh) }
    }
  }
  return { evaluated, sent }
}

// ── Pass 2: escalation (request Part 6) ──────────────────────────────────────
export async function runEscalations(now: number = Date.now()): Promise<{ escalated: number }> {
  const open = await listOpenInstances(500)
  let escalated = 0
  for (const i of open) {
    if (i.ackAt || i.completedAt || !i.requireAck || !i.escalation?.length) { await saveInstance(i); continue }
    const elapsedMin = (now - i.sentAt) / 60000
    const steps = [...i.escalation].sort((a, b) => a.afterMinutes - b.afterMinutes)
    let changed = false
    while (i.escalationStage < steps.length && steps[i.escalationStage].afterMinutes <= elapsedMin) {
      const step = steps[i.escalationStage]
      await applyEscalation(i, step.action)
      i.escalationStage++
      i.escalatedAt.push(now)
      changed = true
      escalated++
      if (i.reminderId) await bumpReminderStats(i.reminderId, { escalations: 1 })
      await recordAudit({
        actor: 'system', actorRole: 'system', action: 'reminder.escalated',
        entity: 'reminder_instance', entityId: i.id,
        summary: `Escalated "${i.title}" for ${i.staffName} → ${step.action} (${Math.round(elapsedMin)}m unacknowledged)`,
        meta: { reminderId: i.reminderId, action: step.action, stage: i.escalationStage },
      })
    }
    if (changed) await saveInstance(i)
  }
  return { escalated }
}

async function applyEscalation(i: ReminderInstance, action: string): Promise<void> {
  if (action === 'resend') {
    await deliverToCrew({
      staff: { id: i.staffId, name: i.staffName, phone: i.staffPhone, email: i.staffEmail },
      title: `Reminder: ${i.title}`, message: i.message, channels: i.channels, kind: 'reminder',
      reminderId: i.reminderId, ackUrl: ackUrlFor(i.token), tags: ['reminder', 'escalation', i.templateId],
    })
    return
  }
  // notify_manager / notify_admin — alert the ops owner (single-owner ops today; the
  // manager roster has no separate contact channel). Message names who + what.
  const who = action === 'notify_admin' ? 'Admin' : 'Manager'
  const link = `${(process.env.NEXT_PUBLIC_SITE_URL || COMPANY.siteUrlApex).replace(/\/$/, '')}/admin/operations/messages`
  await sendOwnerAlert({
    smsBody: `${COMPANY.legalName}: ${i.staffName} has not acknowledged "${i.title}". ${who} escalation. ${link}`,
    emailSubject: `Escalation: ${i.staffName} hasn't acknowledged "${i.title}"`,
    emailHtml: `<p><strong>${i.staffName}</strong> has not acknowledged the reminder <strong>${i.title}</strong>.</p><p>Sent ${new Date(i.sentAt).toLocaleString('en-US', { timeZone: 'America/Chicago' })} Central. This is a ${who}-level escalation.</p><p><a href="${link}">Open the Communication Center</a></p>`,
  })
}

// ── Immediate send: dispatch quick-blast + command-center bulk (Parts 13-14) ──
export type ImmediateSend = {
  staffIds: string[]
  title: string
  message: string
  channels: ReminderChannel[]
  requireAck: boolean
  ackOptions: AckKind[]
  templateId: string
  origin: InstanceOrigin           // 'dispatch' | 'bulk'
  createdBy: string
  createdByRole: string
  scopeBusinessKeys?: string[]
  suppress?: boolean               // apply smart suppression? (bulk may, dispatch never)
}

export async function sendImmediate(opts: ImmediateSend, now: number = Date.now()): Promise<{ sent: number; instances: ReminderInstance[] }> {
  const cards = await buildCrewCards(now)
  const byId = new Map(cards.map(c => [c.id, c]))
  const t = getTemplate(opts.templateId)
  const scope = opts.scopeBusinessKeys && opts.scopeBusinessKeys.length ? new Set(opts.scopeBusinessKeys) : null
  const out: ReminderInstance[] = []

  for (const staffId of opts.staffIds) {
    const card = byId.get(staffId)
    if (!card || !card.active) continue
    if (scope && !card.businessKeys.some(k => scope.has(k))) continue
    // Dispatch bypasses suppression (Part 13); bulk may opt into it.
    if (opts.suppress && isSuppressedForTemplate(card, t.suppress, t.id)) continue

    const occ = `${opts.origin}:${staffId}:${now}`
    if (!(await claimOccurrence(occ, 60 * 60 * 1000))) continue

    const inst = await createInstance({
      templateId: opts.templateId, title: opts.title, message: opts.message, origin: opts.origin,
      staffId: card.id, staffName: card.name, staffPhone: card.phone, staffEmail: card.email,
      businessKey: card.businessKeys[0], routeToken: undefined,
      occurrenceKey: occ, channels: opts.channels,
      requireAck: opts.requireAck, ackOptions: opts.ackOptions,
      sentAt: now, escalation: [],
      createdBy: opts.createdBy, createdByRole: opts.createdByRole,
    })
    const ackUrl = opts.requireAck ? ackUrlFor(inst.token) : undefined
    const res = await deliverToCrew({
      staff: { id: card.id, name: card.name, phone: card.phone, email: card.email },
      title: opts.title, message: opts.message, channels: opts.channels,
      kind: opts.origin === 'dispatch' ? 'dispatch' : 'broadcast',
      ackUrl, tags: [opts.origin, opts.templateId],
    })
    inst.channelResults = res.channelResults
    inst.messageId = res.messageId
    if (res.anyDelivered) inst.deliveredAt = now
    await saveInstance(inst)
    out.push(inst)
  }

  await recordAudit({
    actor: opts.createdBy, actorRole: opts.createdByRole,
    action: opts.origin === 'dispatch' ? 'dispatch.sent' : 'bulk.sent',
    entity: 'reminder_instance',
    summary: `${opts.origin === 'dispatch' ? 'Dispatch' : 'Bulk'} "${opts.title}" → ${out.length} crew`,
    meta: { templateId: opts.templateId, channels: opts.channels, count: out.length },
  })
  return { sent: out.length, instances: out }
}
