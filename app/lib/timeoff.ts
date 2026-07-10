import { redis } from './redis'
import { isDateStr } from './dates'

// Time-off requests (Part 8). Independent contractors, so: NO document uploads,
// reason optional (except late requests — see the 24-hour policy). A request never
// auto-removes a confirmed route assignment; the crew member stays responsible
// until management approves (enforced by keeping this separate from route status).

export type TimeOffStatus = 'draft' | 'pending' | 'approved' | 'denied' | 'cancelled'

export type TimeOffRequest = {
  id: string
  staffId: string
  staffName?: string     // snapshot for the admin queue (avoids a lookup per row)
  startDate: string      // YYYY-MM-DD
  endDate: string        // YYYY-MM-DD (== startDate for a single day)
  partial: boolean       // a partial day (uses start/end time) vs full day(s)
  startTime?: string     // "HH:MM", partial only
  endTime?: string
  reason?: string
  status: TimeOffStatus
  isLate: boolean        // submitted < 24h before the requested start
  decidedBy?: string     // userId/role label of the approver
  decidedAt?: number
  decisionNote?: string
  createdAt: number
  updatedAt: number
}

const KEY = (id: string) => `timeoff:${id}`
const INDEX = 'timeoff:index'
const STAFF_INDEX = (staffId: string) => `timeoff:staff:${staffId}`

export function newTimeOffId(): string {
  return `to_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`
}

// The 24-hour policy. A request is "late" when its requested start is less than
// 24h away. We interpret the wall-clock start in US Central using the CDT offset
// (UTC-5); during CST the true start is an hour later, so this only ever flags a
// request as late slightly more eagerly — the safe direction for a warning that
// then requires a reason.
const CENTRAL_CDT_OFFSET_H = 5
export function isLateRequest(startDate: string, startTime: string | undefined, nowMs: number): boolean {
  if (!isDateStr(startDate)) return false
  const [Y, M, D] = startDate.split('-').map(Number)
  const [h, m] = (startTime && /^\d{2}:\d{2}$/.test(startTime) ? startTime : '00:00').split(':').map(Number)
  const startUtcMs = Date.UTC(Y, M - 1, D, h + CENTRAL_CDT_OFFSET_H, m)
  return startUtcMs - nowMs < 24 * 60 * 60 * 1000
}

export async function getRequest(id: string): Promise<TimeOffRequest | null> {
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as TimeOffRequest } catch { return null }
}

async function persist(r: TimeOffRequest): Promise<void> {
  r.updatedAt = Date.now()
  await redis.set(KEY(r.id), JSON.stringify(r))
  await redis.zadd(INDEX, r.createdAt, r.id)
  await redis.zadd(STAFF_INDEX(r.staffId), r.createdAt, r.id)
}

export type CreateTimeOffInput = {
  staffId: string
  staffName?: string
  startDate: string
  endDate: string
  partial: boolean
  startTime?: string
  endTime?: string
  reason?: string
  submit: boolean        // true = submit for review (→ pending), false = save draft
}

export async function createRequest(input: CreateTimeOffInput, nowMs = Date.now()): Promise<TimeOffRequest> {
  const late = isLateRequest(input.startDate, input.partial ? input.startTime : undefined, nowMs)
  const r: TimeOffRequest = {
    id: newTimeOffId(),
    staffId: input.staffId,
    staffName: input.staffName,
    startDate: input.startDate,
    endDate: input.endDate < input.startDate ? input.startDate : input.endDate,
    partial: input.partial,
    startTime: input.partial ? input.startTime : undefined,
    endTime: input.partial ? input.endTime : undefined,
    reason: input.reason?.trim() || undefined,
    status: input.submit ? 'pending' : 'draft',
    isLate: late,
    createdAt: nowMs,
    updatedAt: nowMs,
  }
  await persist(r)
  return r
}

export async function listForStaff(staffId: string, limit = 50): Promise<TimeOffRequest[]> {
  const ids = await redis.zrevrange(STAFF_INDEX(staffId), 0, limit - 1)
  return hydrate(ids)
}

export async function listAll(limit = 200): Promise<TimeOffRequest[]> {
  const ids = await redis.zrevrange(INDEX, 0, limit - 1)
  return hydrate(ids)
}

async function hydrate(ids: string[]): Promise<TimeOffRequest[]> {
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  return raws
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r as string) as TimeOffRequest } catch { return null } })
    .filter((x): x is TimeOffRequest => x !== null)
}

// Approve / deny — management action. Only a pending request can be decided.
export async function decideRequest(id: string, approve: boolean, by: string, note?: string): Promise<TimeOffRequest | null> {
  const r = await getRequest(id)
  if (!r) return null
  if (r.status !== 'pending') return r // idempotent: don't re-decide a settled request
  r.status = approve ? 'approved' : 'denied'
  r.decidedBy = by
  r.decidedAt = Date.now()
  r.decisionNote = note?.trim() || undefined
  await persist(r)
  return r
}

// Crew cancels their own request. Allowed from draft or pending, or even after
// approval (plans change) — but never flips a denied one.
export async function cancelRequest(id: string, staffId: string): Promise<TimeOffRequest | null> {
  const r = await getRequest(id)
  if (!r || r.staffId !== staffId) return null
  if (r.status === 'denied' || r.status === 'cancelled') return r
  r.status = 'cancelled'
  await persist(r)
  return r
}
