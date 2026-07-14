import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import {
  listReminders, createReminder, type NewReminder,
  type ScheduleKind, type TargetMode, type EscalationAction,
} from '../../../lib/reminders'
import { getTemplate, ALL_CHANNELS, type ReminderChannel, type AckKind, type SegmentId } from '../../../lib/reminder-templates'
import { recordAudit } from '../../../lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const SCHEDULE_KINDS: ScheduleKind[] = ['one_time', 'daily', 'weekly', 'route_relative', 'route_start', 'route_end']
const TARGET_MODES: TargetMode[] = ['all', 'crew', 'business', 'route', 'segment']
const ESC_ACTIONS: EscalationAction[] = ['resend', 'notify_manager', 'notify_admin']
const ALL_ACKS: AckKind[] = ['acknowledged', 'completed', 'calling', 'need_help', 'already_done', 'having_issues', 'unable']

function strArr(v: unknown, max = 500): string[] {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => (x as string).trim()).filter(Boolean).slice(0, max) : []
}

// Build a validated NewReminder from client input, or return an error string.
export function parseReminderInput(body: Record<string, unknown>, actor: { sub: string; role: string }): NewReminder | string {
  const title = S(body.title, 120)
  if (!title) return 'A title is required.'
  const templateId = S(body.templateId, 60) || 'custom'
  const t = getTemplate(templateId)
  const message = S(body.message, 1000) || t.defaultMessage
  if (!message) return 'A message is required.'

  const channels = (Array.isArray(body.channels) ? body.channels : [])
    .filter((c): c is ReminderChannel => ALL_CHANNELS.includes(c as ReminderChannel))
  const finalChannels = channels.length ? Array.from(new Set(channels)) : t.defaultChannels

  const sBody = (body.schedule ?? {}) as Record<string, unknown>
  const kind = SCHEDULE_KINDS.includes(sBody.kind as ScheduleKind) ? sBody.kind as ScheduleKind : 'daily'
  const time = /^\d{1,2}:\d{2}$/.test(S(sBody.time, 5)) ? S(sBody.time, 5) : undefined
  const date = /^\d{4}-\d{2}-\d{2}$/.test(S(sBody.date, 10)) ? S(sBody.date, 10) : undefined
  const weekdays = Array.isArray(sBody.weekdays)
    ? sBody.weekdays.filter(n => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6) as number[]
    : []
  const offsetMinutes = Number.isFinite(sBody.offsetMinutes as number) ? Math.trunc(sBody.offsetMinutes as number) : undefined

  if ((kind === 'daily' || kind === 'weekly' || kind === 'one_time') && !time) return 'A time is required for this schedule.'
  if (kind === 'one_time' && !date) return 'A date is required for a one-time reminder.'
  if (kind === 'weekly' && !weekdays.length) return 'Select at least one day of the week.'

  const tBody = (body.target ?? {}) as Record<string, unknown>
  const mode = TARGET_MODES.includes(tBody.mode as TargetMode) ? tBody.mode as TargetMode : 'all'
  const target = {
    mode,
    staffIds: mode === 'crew' ? strArr(tBody.staffIds) : undefined,
    businessKeys: mode === 'business' ? strArr(tBody.businessKeys) : undefined,
    routeTokens: mode === 'route' ? strArr(tBody.routeTokens) : undefined,
    segment: mode === 'segment' ? (S(tBody.segment, 40) as SegmentId) : undefined,
  }
  if (mode === 'crew' && !target.staffIds?.length) return 'Select at least one crew member.'
  if (mode === 'business' && !target.businessKeys?.length) return 'Select at least one business.'
  if (mode === 'route' && !target.routeTokens?.length) return 'Select at least one route.'
  if (mode === 'segment' && !target.segment) return 'Select a crew segment.'

  const ackOptions = (Array.isArray(body.ackOptions) ? body.ackOptions : [])
    .filter((a): a is AckKind => ALL_ACKS.includes(a as AckKind))
  const escalation = (Array.isArray(body.escalation) ? body.escalation : [])
    .map(e => e as Record<string, unknown>)
    .filter(e => Number.isFinite(e.afterMinutes as number) && ESC_ACTIONS.includes(e.action as EscalationAction))
    .map(e => ({ afterMinutes: Math.max(1, Math.trunc(e.afterMinutes as number)), action: e.action as EscalationAction }))
    .slice(0, 6)

  return {
    templateId, title, message, channels: finalChannels,
    schedule: { kind, time, date, weekdays, offsetMinutes },
    target,
    requireAck: typeof body.requireAck === 'boolean' ? body.requireAck : t.requireAckDefault,
    ackOptions: ackOptions.length ? ackOptions : t.ackOptions,
    smartSuppress: typeof body.smartSuppress === 'boolean' ? body.smartSuppress : true,
    escalation,
    active: body.active !== false,
    paused: false,
    archived: false,
    createdBy: actor.sub,
    createdByRole: actor.role,
    scopeBusinessKeys: strArr(body.scopeBusinessKeys),
  }
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'reminders:view')
  if (who instanceof NextResponse) return who
  const reminders = await listReminders(400)
  return NextResponse.json({ reminders })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'reminders:manage')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const parsed = parseReminderInput(body, who)
  if (typeof parsed === 'string') return NextResponse.json({ error: parsed }, { status: 400 })
  const r = await createReminder(parsed)
  await recordAudit({
    actor: who.sub, actorRole: who.role, action: 'reminder.created',
    entity: 'reminder', entityId: r.id, summary: `Created reminder "${r.title}"`,
    meta: { templateId: r.templateId, schedule: r.schedule.kind, target: r.target.mode },
  })
  return NextResponse.json({ reminder: r }, { status: 201 })
})
