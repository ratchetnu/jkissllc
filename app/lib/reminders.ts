import { redis } from './redis'
import type { ReminderChannel, AckKind, SegmentId } from './reminder-templates'
import { ACK_IS_DONE } from './reminder-templates'

// Reminder engine store (request Parts 2-7, 11, 15). Mirrors the platform's Redis
// conventions (a JSON blob per record + sorted-set indexes, exactly like messages.ts
// / routes.ts). Two entities:
//
//   Reminder          — the RULE: what to say, to whom, on what schedule, over which
//                       channels, with what escalation. Admins/managers manage these.
//   ReminderInstance  — one SEND: a materialized reminder for one crew member at one
//                       occurrence. Carries the full delivery + acknowledgement +
//                       escalation lifecycle. This is the analytics + audit backbone.
//
// Pure store — scheduling logic lives in reminder-engine.ts, targeting in
// reminder-segments.ts, so this file has no provider or Next.js dependencies.

// ── Schedule (request Part 2) ────────────────────────────────────────────────
export type ScheduleKind =
  | 'one_time'        // once, at date + time
  | 'daily'           // every day at time
  | 'weekly'          // on selected weekdays at time
  | 'route_relative'  // offsetMinutes before/after each targeted route's start
  | 'route_start'     // at each targeted route's start time
  | 'route_end'       // at each targeted route's end (best-effort from reportTime)

export type ReminderSchedule = {
  kind: ScheduleKind
  time?: string            // "HH:MM" 24h, Central — time-based kinds
  date?: string            // YYYY-MM-DD — one_time only
  weekdays?: number[]      // 0=Sun..6=Sat — weekly / selected-day
  offsetMinutes?: number   // route_relative: negative = before route start
}

// ── Targeting (request Part 1) ───────────────────────────────────────────────
export type TargetMode = 'all' | 'crew' | 'business' | 'route' | 'segment'
export type ReminderTarget = {
  mode: TargetMode
  staffIds?: string[]
  businessKeys?: string[]
  routeTokens?: string[]
  segment?: SegmentId
}

// ── Escalation (request Part 6) ──────────────────────────────────────────────
export type EscalationAction = 'resend' | 'notify_manager' | 'notify_admin'
export type EscalationStep = {
  afterMinutes: number     // minutes after the send with no acknowledgement
  action: EscalationAction
}

export type ReminderStats = {
  sent: number; delivered: number; opened: number
  acked: number; completed: number; failed: number; escalations: number
}
const ZERO_STATS: ReminderStats = { sent: 0, delivered: 0, opened: 0, acked: 0, completed: 0, failed: 0, escalations: 0 }

export type Reminder = {
  id: string
  templateId: string
  title: string
  message: string
  channels: ReminderChannel[]
  schedule: ReminderSchedule
  target: ReminderTarget
  requireAck: boolean
  ackOptions: AckKind[]
  smartSuppress: boolean        // apply the template's suppression predicate
  escalation: EscalationStep[]

  active: boolean               // master on/off
  paused: boolean
  archived: boolean

  // Ownership + scope. A manager's reminder is scoped to the businesses they manage;
  // enforced server-side (see the reminders API). createdByRole records who authored it.
  createdBy: string
  createdByRole: string
  scopeBusinessKeys?: string[]  // manager scope snapshot (empty/undefined = unscoped/admin)

  stats: ReminderStats
  lastRunAt?: number
  nextRunAt?: number            // best-effort next fire (epoch ms), for the table

  createdAt: number
  updatedAt: number
}

export type InstanceOrigin = 'schedule' | 'dispatch' | 'bulk'

export type ReminderInstance = {
  id: string
  token: string                 // public one-tap ack link token
  reminderId?: string           // absent for ad-hoc dispatch/bulk sends
  templateId: string
  title: string
  message: string
  origin: InstanceOrigin

  staffId: string
  staffName: string
  staffPhone?: string
  staffEmail?: string
  businessKey?: string
  routeToken?: string

  occurrenceKey: string         // dedup: one instance per (reminder, staff, occurrence)
  channels: ReminderChannel[]
  channelResults: Partial<Record<ReminderChannel, boolean>>
  messageId?: string            // the in-app Message this created

  requireAck: boolean
  ackOptions: AckKind[]

  // Lifecycle timestamps (request Part 5 record: Delivered/Opened/Acknowledged/Completed).
  sentAt: number
  deliveredAt?: number
  openedAt?: number
  ackAt?: number
  ackKind?: AckKind
  completedAt?: number
  device?: string

  // Escalation (request Part 6).
  escalation: EscalationStep[]
  escalationStage: number       // count of escalation steps already fired
  escalatedAt: number[]

  createdBy?: string
  createdByRole?: string
}

// ── keys ─────────────────────────────────────────────────────────────────────
const R_KEY = (id: string) => `rem:${id}`
const R_INDEX = 'rem:index'                              // zset score=createdAt

const I_KEY = (id: string) => `rsend:${id}`
const I_INDEX = 'rsend:index'                            // zset score=sentAt — all sends
const I_OPEN = 'rsend:open'                              // zset of sends awaiting ack (escalation scan)
const iReminder = (rid: string) => `rsend:reminder:${rid}`
const iStaff = (sid: string) => `rsend:staff:${sid}`
const occKey = (k: string) => `rsend:occ:${k}`           // occurrence dedup -> instance id
const tokKey = (t: string) => `rsend:token:${t}`         // public ack token -> instance id

function rid(): string { return `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` }
function iid(): string { return `rs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` }
function tok(): string { return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}` }

// ── Reminder CRUD ────────────────────────────────────────────────────────────
export type NewReminder = Omit<Reminder, 'id' | 'stats' | 'createdAt' | 'updatedAt'> &
  Partial<Pick<Reminder, 'stats'>>

export async function createReminder(input: NewReminder): Promise<Reminder> {
  const now = Date.now()
  const r: Reminder = {
    ...input,
    id: rid(),
    stats: input.stats ?? { ...ZERO_STATS },
    createdAt: now,
    updatedAt: now,
  }
  await saveReminder(r)
  return r
}

export async function saveReminder(r: Reminder): Promise<void> {
  r.updatedAt = Date.now()
  await redis.set(R_KEY(r.id), JSON.stringify(r))
  await redis.zadd(R_INDEX, r.createdAt, r.id)
}

export async function getReminder(id: string): Promise<Reminder | null> {
  const raw = await redis.get(R_KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as Reminder } catch { return null }
}

export async function listReminders(limit = 300): Promise<Reminder[]> {
  const ids = await redis.zrevrange(R_INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(R_KEY(id))))
  return raws
    .map(r => { try { return r ? JSON.parse(r as string) as Reminder : null } catch { return null } })
    .filter((x): x is Reminder => x !== null)
}

export async function deleteReminder(id: string): Promise<void> {
  await redis.del(R_KEY(id))
  await redis.zrem(R_INDEX, id)
}

export async function bumpReminderStats(id: string, patch: Partial<ReminderStats>): Promise<void> {
  const r = await getReminder(id)
  if (!r) return
  const s = r.stats ?? { ...ZERO_STATS }
  r.stats = {
    sent: s.sent + (patch.sent ?? 0),
    delivered: s.delivered + (patch.delivered ?? 0),
    opened: s.opened + (patch.opened ?? 0),
    acked: s.acked + (patch.acked ?? 0),
    completed: s.completed + (patch.completed ?? 0),
    failed: s.failed + (patch.failed ?? 0),
    escalations: s.escalations + (patch.escalations ?? 0),
  }
  await saveReminder(r)
}

// ── Instance (send) lifecycle ────────────────────────────────────────────────

// Reserve an occurrence atomically so two concurrent engine runs can't double-send
// the same reminder to the same crew member. Returns false if already claimed.
export async function claimOccurrence(occurrenceKey: string, ttlMs = 36 * 60 * 60 * 1000): Promise<boolean> {
  return redis.setNxPx(occKey(occurrenceKey), '1', ttlMs)
}

export async function saveInstance(i: ReminderInstance): Promise<void> {
  await redis.set(I_KEY(i.id), JSON.stringify(i))
  await redis.zadd(I_INDEX, i.sentAt, i.id)
  if (i.reminderId) await redis.zadd(iReminder(i.reminderId), i.sentAt, i.id)
  await redis.zadd(iStaff(i.staffId), i.sentAt, i.id)
  await redis.set(tokKey(i.token), i.id)
  // Track in the open set only while it still needs an acknowledgement.
  const settled = !!i.completedAt || (!!i.ackAt && isDoneAck(i.ackKind))
  if (i.requireAck && !settled) await redis.zadd(I_OPEN, i.sentAt, i.id)
  else await redis.zrem(I_OPEN, i.id)
}

function isDoneAck(k: AckKind | undefined): boolean {
  return !!k && ACK_IS_DONE[k]
}

export async function createInstance(input: Omit<ReminderInstance, 'id' | 'token' | 'escalationStage' | 'escalatedAt' | 'channelResults'> & {
  channelResults?: Partial<Record<ReminderChannel, boolean>>
}): Promise<ReminderInstance> {
  const i: ReminderInstance = {
    ...input,
    id: iid(),
    token: tok(),
    channelResults: input.channelResults ?? {},
    escalationStage: 0,
    escalatedAt: [],
  }
  await saveInstance(i)
  return i
}

export async function getInstance(id: string): Promise<ReminderInstance | null> {
  const raw = await redis.get(I_KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as ReminderInstance } catch { return null }
}

export async function getInstanceByToken(token: string): Promise<ReminderInstance | null> {
  const id = await redis.get(tokKey(token))
  if (!id) return null
  return getInstance(id as string)
}

export async function listInstances(limit = 1000): Promise<ReminderInstance[]> {
  return hydrateInstances(await redis.zrevrange(I_INDEX, 0, limit - 1))
}

export async function listInstancesForReminder(reminderId: string, limit = 500): Promise<ReminderInstance[]> {
  return hydrateInstances(await redis.zrevrange(iReminder(reminderId), 0, limit - 1))
}

export async function listInstancesForStaff(staffId: string, limit = 200): Promise<ReminderInstance[]> {
  return hydrateInstances(await redis.zrevrange(iStaff(staffId), 0, limit - 1))
}

// The escalation scan reads the open set oldest-first (those waiting longest).
export async function listOpenInstances(limit = 500): Promise<ReminderInstance[]> {
  return hydrateInstances(await redis.zrange(I_OPEN, 0, limit - 1))
}

async function hydrateInstances(ids: string[]): Promise<ReminderInstance[]> {
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(I_KEY(id))))
  return raws
    .map(r => { try { return r ? JSON.parse(r as string) as ReminderInstance : null } catch { return null } })
    .filter((x): x is ReminderInstance => x !== null)
}

// Mark opened (idempotent) — the crew member viewed it.
export async function markInstanceOpened(id: string, device?: string): Promise<ReminderInstance | null> {
  const i = await getInstance(id)
  if (!i) return null
  if (!i.openedAt) {
    i.openedAt = Date.now()
    if (device) i.device = device
    await saveInstance(i)
    if (i.reminderId) await bumpReminderStats(i.reminderId, { opened: 1 })
  }
  return i
}

// Record an acknowledgement (request Part 5). A "done" ack also stamps completedAt
// and drops the instance from the open (escalation) set.
export async function ackInstance(id: string, kind: AckKind, device?: string): Promise<ReminderInstance | null> {
  const i = await getInstance(id)
  if (!i) return null
  const now = Date.now()
  const firstAck = !i.ackAt
  i.ackAt = now
  i.ackKind = kind
  if (!i.openedAt) i.openedAt = now
  if (device) i.device = device
  if (ACK_IS_DONE[kind]) i.completedAt = now
  await saveInstance(i)
  if (i.reminderId && firstAck) {
    await bumpReminderStats(i.reminderId, { acked: 1, ...(ACK_IS_DONE[kind] ? { completed: 1 } : {}) })
  }
  return i
}
