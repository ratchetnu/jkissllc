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

export type ConfirmEventType = 'link_opened' | 'disclaimer_viewed' | 'confirmed' | 'declined' | 'completed'
export type ConfirmEvent = {
  at: number
  type: ConfirmEventType
  ip?: string
  ua?: string
}

// What J KISS is paid for this route, snapshotted when the route is created.
// Editing a business's contract rate later does NOT rewrite this — completed
// routes keep the price they actually ran at. Admin-only; never projected to the
// public confirmation page.
export type RouteFinancials = {
  businessPriceCents?: number   // undefined = no contract rate was on file
  priceSource: 'contract' | 'manual' | 'none'
  snapshotAt: number
}

// One crew member on a route. Each confirms independently (own token/link) and
// carries their own pay for THIS route (driver ≠ helper; the route's payRate is
// not the crew's pay). Confirmation + SMS state is per person.
export type Assignee = {
  staffId: string
  name: string
  phone?: string
  role?: string                 // e.g. Driver / Helper (from staff.role)
  pay?: string                  // per-person pay, free text ("$175") — display + legacy
  payCents?: number             // per-person pay, canonical. Snapshotted at assign time.
  paySource?: 'crew_business' | 'crew_default' | 'manual'
  token: string                 // this crew member's own confirmation-link token

  // Confirmation (per person)
  linkOpenedAt?: number
  disclaimerAcceptedAt?: number
  confirmedAt?: number
  declinedAt?: number
  declineReason?: string
  confirmIp?: string

  // Outbound SMS (per person)
  smsSid?: string
  smsStatus?: string
  smsError?: string
  smsSentAt?: number

  // Automation dedupe stamps (per person, one-shot; written by the daily cron)
  reminderSentAt?: number
  morningOfSentAt?: number
  noResponseAlertedAt?: number
}

export type RouteRecord = {
  token: string
  routeNumber: string           // JK-R-1001
  status: RouteStatus           // route-level rollup (derived from assignees)

  // Route details
  businessName: string
  contactPerson?: string
  contactPhone?: string
  reportAddress: string
  reportTime: string            // free text, e.g. "7:00 AM"
  routeDate: string             // YYYY-MM-DD
  description?: string
  payRate?: string              // legacy route-level rate; crew pay lives per-assignee
  vehicle?: string
  specialNotes?: string

  // Crew (source of truth for multi-person assignment)
  assignees?: Assignee[]
  requiresHelper?: boolean       // stamped from the client's setting — needs a driver + helper

  // What the client pays for this route. Snapshotted at create; see RouteFinancials.
  financials?: RouteFinancials

  // Legacy single-assignee mirror (= assignees[0], the "lead"). Kept so existing
  // reads keep working; write via syncLead().
  assignedStaffId?: string
  assignedStaffName?: string
  assignedStaffPhone?: string

  // Confirmation (mirrors the lead assignee)
  linkOpenedAt?: number
  disclaimerAcceptedAt?: number
  confirmedAt?: number
  declinedAt?: number
  declineReason?: string
  confirmIp?: string
  confirmPhone?: string

  // Completion + proof (marked on-site by the contractor, or by an admin)
  completedAt?: number
  completedBy?: 'contractor' | 'admin'
  completionNote?: string
  completionPhotos?: string[]   // Vercel Blob URLs

  // Outbound SMS (assignment text)
  smsSid?: string
  smsStatus?: string            // Twilio message status: sent | delivered | failed | ...
  smsError?: string
  smsSentAt?: number

  // Automation dedupe stamps (one-shot; written by the daily cron)
  reminderSentAt?: number       // "please confirm" nudge to the contractor
  morningOfSentAt?: number      // day-of reminder for a confirmed route
  noResponseAlertedAt?: number  // owner alerted the route went unanswered past its date

  // Logs
  events: ConfirmEvent[]
  audit: AuditEntry[]

  // Lifecycle
  templateId?: string           // set when generated from a recurring template
  invoiceId?: string            // set when this completed route has been billed to a client
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
  completedAt?: number
  completionNote?: string
  completionPhotos?: string[]
  expired: boolean
}

// ── Redis keys ───────────────────────────────────────────────────────────────
const KEY = (token: string) => `rt:${token}`
const KEY_NUM = (num: string) => `rt:num:${num}`
const KEY_INDEX = 'rt:index'      // sorted set, score = updatedAt, member = token
const KEY_COUNTER = 'rt:counter'
const KEY_ATOK = (t: string) => `rt:atok:${t}`   // assignee confirm-token → route token

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

// Pull cents out of the legacy free-text pay ("$175/route", "175", "$1,250.00").
// Duplicated from route-pay.parsePayCents on purpose: route-pay imports this
// module, so importing it back would be a cycle.
function legacyPayCents(pay?: string): number | null {
  if (!pay) return null
  const m = pay.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
function normalize(r: RouteRecord): RouteRecord {
  r.events = Array.isArray(r.events) ? r.events : []
  r.audit = Array.isArray(r.audit) ? r.audit : []
  // Migrate a legacy single-assignee route into the assignees[] model. The old
  // confirm link WAS the route token, so the migrated assignee keeps it.
  if (!Array.isArray(r.assignees)) {
    r.assignees = r.assignedStaffId
      ? [{
          staffId: r.assignedStaffId, name: r.assignedStaffName || 'Crew', phone: r.assignedStaffPhone,
          pay: r.payRate, token: r.token,
          linkOpenedAt: r.linkOpenedAt, disclaimerAcceptedAt: r.disclaimerAcceptedAt,
          confirmedAt: r.confirmedAt, declinedAt: r.declinedAt, declineReason: r.declineReason, confirmIp: r.confirmIp,
          smsSid: r.smsSid, smsStatus: r.smsStatus, smsError: r.smsError, smsSentAt: r.smsSentAt,
        }]
      : []
  }
  // Back-fill payCents from the free-text pay on routes written before pay became
  // numeric, so finance reporting sees historical payouts instead of zeros. Only
  // fills what's missing — a real snapshot is never overwritten.
  for (const a of r.assignees) {
    if (typeof a.payCents !== 'number') {
      const cents = legacyPayCents(a.pay)
      if (cents != null) a.payCents = cents
    }
  }
  return r
}

// When a client requires a driver + helper, what's still missing on the crew.
export function crewGap(r: RouteRecord): { needsDriver: boolean; needsHelper: boolean; incomplete: boolean } {
  if (!r.requiresHelper) return { needsDriver: false, needsHelper: false, incomplete: false }
  const roles = (r.assignees ?? []).map(a => (a.role || '').toLowerCase())
  const needsDriver = !roles.some(x => x.includes('driver'))
  const needsHelper = !roles.some(x => x.includes('helper'))
  return { needsDriver, needsHelper, incomplete: needsDriver || needsHelper }
}

// Route-level status rolled up from the crew (best-effort, for board chips).
// Explicit terminal statuses set by an admin (completed/cancelled/no_show) win.
export function rollupStatus(r: RouteRecord): RouteStatus {
  if (r.status === 'cancelled' || r.status === 'completed' || r.status === 'no_show') return r.status
  const a = r.assignees ?? []
  if (a.length === 0) return 'draft'
  if (a.every(x => x.confirmedAt)) return 'confirmed'
  const pending = a.filter(x => !x.confirmedAt && !x.declinedAt)
  if (pending.length) return pending.some(x => x.smsSentAt) ? 'text_sent' : 'assigned'
  return a.some(x => x.confirmedAt) ? 'confirmed' : 'declined'  // no pending: some mix / all declined
}

// Mirror the lead assignee (assignees[0]) onto the legacy route-level fields and
// recompute the route status. Call after any crew mutation.
export function syncLead(r: RouteRecord): void {
  const lead = (r.assignees ?? [])[0]
  r.assignedStaffId = lead?.staffId
  r.assignedStaffName = lead?.name
  r.assignedStaffPhone = lead?.phone
  r.linkOpenedAt = lead?.linkOpenedAt
  r.disclaimerAcceptedAt = lead?.disclaimerAcceptedAt
  r.confirmedAt = lead?.confirmedAt
  r.declinedAt = lead?.declinedAt
  r.declineReason = lead?.declineReason
  r.confirmIp = lead?.confirmIp
  r.smsSid = lead?.smsSid
  r.smsStatus = lead?.smsStatus
  r.smsError = lead?.smsError
  r.smsSentAt = lead?.smsSentAt
  r.status = rollupStatus(r)
}

// Add a crew member (no dupes). Returns the assignee (new or existing).
export function addAssignee(r: RouteRecord, input: { staffId: string; name: string; phone?: string; role?: string; pay?: string }): Assignee {
  r.assignees = r.assignees ?? []
  const existing = r.assignees.find(a => a.staffId === input.staffId)
  if (existing) return existing
  const a: Assignee = { staffId: input.staffId, name: input.name, phone: input.phone, role: input.role, pay: input.pay, token: generateToken() }
  r.assignees.push(a)
  pushAudit(r, 'admin', `Added ${input.name}${input.role ? ` (${input.role})` : ''} to the crew`)
  syncLead(r)
  return a
}

// Remove a crew member. Returns the removed assignee's token (dead link) or null.
export function removeAssignee(r: RouteRecord, staffId: string): string | null {
  const found = (r.assignees ?? []).find(a => a.staffId === staffId)
  r.assignees = (r.assignees ?? []).filter(a => a.staffId !== staffId)
  if (found) pushAudit(r, 'admin', `Removed ${found.name} from the crew`)
  syncLead(r)
  return found?.token ?? null
}

// Resolve a public confirm token (assignee token, or a legacy route token) to the
// route + the specific crew member.
export async function getRouteByConfirmToken(token: string): Promise<{ route: RouteRecord; assignee: Assignee } | null> {
  if (!token || !TOKEN_RE.test(token)) return null
  let routeToken = token
  try { const mapped = await redis.get(KEY_ATOK(token)); if (mapped) routeToken = mapped } catch { /* fall through */ }
  const route = await getRouteByToken(routeToken)
  if (!route) return null
  const assignee = (route.assignees ?? []).find(a => a.token === token)
  return assignee ? { route, assignee } : null
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
  // Map each assignee's own confirm token → this route (the route token maps to
  // itself implicitly, so skip it).
  for (const a of r.assignees ?? []) {
    if (a.token && a.token !== r.token) await redis.set(KEY_ATOK(a.token), r.token)
  }
}

export async function deleteRoute(token: string): Promise<void> {
  const r = await getRouteByToken(token)
  await redis.del(KEY(token))
  if (r) {
    await redis.del(KEY_NUM(r.routeNumber.toUpperCase()))
    for (const a of r.assignees ?? []) if (a.token && a.token !== token) await redis.del(KEY_ATOK(a.token))
  }
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
    completedAt: r.completedAt,
    completionNote: r.completionNote,
    completionPhotos: r.completionPhotos,
    expired: isExpired(r),
  }
}

// Public projection for ONE crew member — their name + their own confirmation
// status (not the route rollup). The confirm page consumes the same PublicRoute
// shape, so it needs no changes.
//
// MONEY RULES (do not relax):
//   • payRate carries THIS crew member's own pay, never the route-level rate and
//     never another crew member's pay.
//   • It is omitted entirely unless the admin has enabled showPayInConfirm.
//   • RouteFinancials (what the client pays, and the profit) is not part of
//     PublicRoute at all, so it cannot leak through this projection.
export function toPublicRouteFor(r: RouteRecord, a: Assignee, opts: { showPay?: boolean } = {}): PublicRoute {
  const status: RouteStatus =
    r.status === 'cancelled' ? 'cancelled'
      : r.status === 'completed' ? 'completed'
        : a.confirmedAt ? 'confirmed'
          : a.declinedAt ? 'declined'
            : a.smsSentAt ? 'text_sent' : 'assigned'
  return {
    ...toPublicRoute(r),
    status,
    assignedStaffName: a.name,
    confirmedAt: a.confirmedAt,
    declinedAt: a.declinedAt,
    payRate: opts.showPay ? a.pay : undefined,
  }
}

// The contractor disclaimer (1099 framing — eligibility/priority, no auto-fine).
export const CONFIRM_DISCLAIMER =
  'I understand that by confirming this route I am agreeing, as an independent contractor, ' +
  'to report on time at the location above and complete the assigned work. If I confirm and ' +
  'then fail to report, J KISS LLC may, after review, reduce my route priority, remove me from ' +
  'future route assignments, or take other action available under my independent contractor ' +
  'agreement. Confirming does not guarantee the route if the client cancels it.'
