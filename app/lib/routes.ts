// Employee Route Assignment + Confirmation — data layer (Upstash Redis).
// Mirrors the booking model: a 64-hex CSPRNG token is the record key and the
// public confirmation-link key. Everything is one JSON blob + a sorted-set index.
// Workers are 1099 contractors, drawn from the existing crew roster (lib/staff).
import { redis } from './redis'

// ── Status ───────────────────────────────────────────────────────────────────
export type RouteStatus =
  | 'draft' | 'assigned' | 'text_sent' | 'confirmed' | 'declined'
  | 'no_response' | 'no_show' | 'completed' | 'cancelled'

export const ROUTE_STATUS_LABEL: Record<RouteStatus, string> = {
  draft: 'Draft',
  assigned: 'Assigned',
  text_sent: 'Text Sent',
  confirmed: 'Confirmed',
  declined: 'Declined',
  no_response: 'No Response',
  no_show: 'No Show',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

// ── Sub-records ──────────────────────────────────────────────────────────────
export type AuditEntry = {
  at: number
  actor: string                 // 'admin' | 'contractor' | 'system'
  action: string                // human-readable
  from?: RouteStatus
  to?: RouteStatus
  note?: string
}

export type ConfirmEventType = 'link_opened' | 'disclaimer_viewed' | 'confirmed' | 'declined'
export type ConfirmEvent = {
  at: number
  type: ConfirmEventType
  ip?: string
  ua?: string
}

export type RouteRecord = {
  token: string
  routeNumber: string           // JK-R-1001
  status: RouteStatus

  // Route details
  businessName: string
  contactPerson?: string
  contactPhone?: string
  reportAddress: string
  reportTime: string            // free text, e.g. "7:00 AM"
  routeDate: string             // YYYY-MM-DD
  description?: string
  payRate?: string              // free text (1099 — keep flexible, e.g. "$175/route")
  vehicle?: string
  specialNotes?: string

  // Assignment (to a crew member from lib/staff)
  assignedStaffId?: string
  assignedStaffName?: string
  assignedStaffPhone?: string

  // Confirmation
  linkOpenedAt?: number
  disclaimerAcceptedAt?: number
  confirmedAt?: number
  declinedAt?: number
  declineReason?: string
  confirmIp?: string
  confirmPhone?: string

  // Outbound SMS (assignment text)
  smsSid?: string
  smsStatus?: string            // Twilio message status: sent | delivered | failed | ...
  smsError?: string
  smsSentAt?: number

  // Logs
  events: ConfirmEvent[]
  audit: AuditEntry[]

  // Lifecycle
  createdAt: number
  updatedAt: number
  createdBy?: string
}

// Scrubbed shape sent to the PUBLIC confirmation page — no audit trail, IPs,
// SMS SIDs, or internal ids. Only what the assigned contractor needs to see.
export type PublicRoute = {
  token: string
  routeNumber: string
  status: RouteStatus
  businessName: string
  contactPerson?: string
  contactPhone?: string
  reportAddress: string
  reportTime: string
  routeDate: string
  description?: string
  payRate?: string
  vehicle?: string
  specialNotes?: string
  assignedStaffName?: string
  confirmedAt?: number
  declinedAt?: number
  expired: boolean
}

// ── Redis keys ───────────────────────────────────────────────────────────────
const KEY = (token: string) => `rt:${token}`
const KEY_NUM = (num: string) => `rt:num:${num}`
const KEY_INDEX = 'rt:index'      // sorted set, score = updatedAt, member = token
const KEY_COUNTER = 'rt:counter'

// ── Tokens + numbers ─────────────────────────────────────────────────────────
export function generateToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
}
const TOKEN_RE = /^[a-f0-9]{16,}$/i

export async function nextRouteNumber(): Promise<string> {
  let n: number
  try { n = await redis.incr(KEY_COUNTER) } catch { n = Date.now() % 100000 }
  return `JK-R-${1000 + n}`
}

// ── Expiry ───────────────────────────────────────────────────────────────────
// Link is valid through the route date and a short grace, then expires. Generous
// buffer (48h from the route date's UTC midnight) so a worker opening it the
// evening of the route in Central time is never wrongly locked out.
export function isExpired(r: Pick<RouteRecord, 'routeDate'>): boolean {
  const base = Date.parse(`${r.routeDate}T00:00:00Z`)
  if (Number.isNaN(base)) return false
  return Date.now() > base + 48 * 3600 * 1000
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
function normalize(r: RouteRecord): RouteRecord {
  r.events = Array.isArray(r.events) ? r.events : []
  r.audit = Array.isArray(r.audit) ? r.audit : []
  return r
}

export async function getRouteByToken(token: string): Promise<RouteRecord | null> {
  if (!token || !TOKEN_RE.test(token)) return null
  const raw = await redis.get(KEY(token))
  if (!raw) return null
  try { return normalize(JSON.parse(raw) as RouteRecord) } catch { return null }
}

export async function saveRoute(r: RouteRecord): Promise<void> {
  r.updatedAt = Date.now()
  await redis.set(KEY(r.token), JSON.stringify(r))
  await redis.set(KEY_NUM(r.routeNumber.toUpperCase()), r.token)
  await redis.zadd(KEY_INDEX, r.updatedAt, r.token)
}

export async function deleteRoute(token: string): Promise<void> {
  const r = await getRouteByToken(token)
  await redis.del(KEY(token))
  if (r) await redis.del(KEY_NUM(r.routeNumber.toUpperCase()))
  await redis.zrem(KEY_INDEX, token)
}

export async function listRoutes(limit = 500): Promise<RouteRecord[]> {
  const tokens = await redis.zrevrange(KEY_INDEX, 0, limit - 1)
  if (!tokens.length) return []
  const raws = await Promise.all(tokens.map(t => redis.get(KEY(t))))
  return raws
    .filter(Boolean)
    .map(r => { try { return normalize(JSON.parse(r as string) as RouteRecord) } catch { return null } })
    .filter((r): r is RouteRecord => r !== null)
}

// ── Mutations (audit-logged) ─────────────────────────────────────────────────
export function pushAudit(
  r: RouteRecord, actor: AuditEntry['actor'], action: string,
  opts?: { from?: RouteStatus; to?: RouteStatus; note?: string },
): void {
  r.audit.push({ at: Date.now(), actor, action, ...opts })
  if (r.audit.length > 200) r.audit = r.audit.slice(-200)
}

export function pushEvent(r: RouteRecord, type: ConfirmEventType, ip?: string, ua?: string): void {
  r.events.push({ at: Date.now(), type, ip, ua: ua?.slice(0, 300) })
  if (r.events.length > 100) r.events = r.events.slice(-100)
}

// Change status with an audit trail in one call.
export function setStatus(r: RouteRecord, to: RouteStatus, actor: AuditEntry['actor'], note?: string): void {
  const from = r.status
  if (from === to) return
  r.status = to
  pushAudit(r, actor, `status → ${ROUTE_STATUS_LABEL[to]}`, { from, to, note })
}

// ── Public projection ────────────────────────────────────────────────────────
export function toPublicRoute(r: RouteRecord): PublicRoute {
  return {
    token: r.token,
    routeNumber: r.routeNumber,
    status: r.status,
    businessName: r.businessName,
    contactPerson: r.contactPerson,
    contactPhone: r.contactPhone,
    reportAddress: r.reportAddress,
    reportTime: r.reportTime,
    routeDate: r.routeDate,
    description: r.description,
    payRate: r.payRate,
    vehicle: r.vehicle,
    specialNotes: r.specialNotes,
    assignedStaffName: r.assignedStaffName,
    confirmedAt: r.confirmedAt,
    declinedAt: r.declinedAt,
    expired: isExpired(r),
  }
}

// The contractor disclaimer (1099 framing — eligibility/priority, no auto-fine).
export const CONFIRM_DISCLAIMER =
  'I understand that by confirming this route I am agreeing, as an independent contractor, ' +
  'to report on time at the location above and complete the assigned work. If I confirm and ' +
  'then fail to report, J KISS LLC may, after review, reduce my route priority, remove me from ' +
  'future route assignments, or take other action available under my independent contractor ' +
  'agreement. Confirming does not guarantee the route if the client cancels it.'
