// Employee Route Assignment + Confirmation — data layer (Upstash Redis).
// Mirrors the booking model: a 64-hex CSPRNG token is the record key and the
// public confirmation-link key. Everything is one JSON blob + a sorted-set index.
// Workers are 1099 contractors, drawn from the existing crew roster (lib/staff).
import { redis } from './redis'
import { bindToken, revokeTokenBinding } from './platform/tenancy/token-binding'
import { currentTenantId } from './platform/tenancy/context'
import { DEFAULT_TENANT_ID } from './platform/tenancy/types'
import { COMPANY } from './company'

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
  actor: string                 // 'admin' | 'contractor' | 'system' (coarse bucket)
  action: string                // human-readable
  actorId?: string              // resolved Principal.sub — WHICH named user acted (H3 attribution)
  actorRole?: string            // resolved Principal.role
  from?: RouteStatus
  to?: RouteStatus
  note?: string
}

export type ConfirmEventType = 'link_opened' | 'disclaimer_viewed' | 'confirmed' | 'declined' | 'completed' | 'clock_in' | 'clock_out'
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
  disclaimerAcceptedAt?: number    // set ONLY when they accepted CONFIRM_DISCLAIMER themselves
  confirmedAt?: number
  // How the confirmation was captured. 'link' = they tapped confirm and accepted the
  // disclaimer (disclaimerAcceptedAt + confirmIp are set). 'verbal' = the owner spoke
  // to them and recorded it — NO disclaimer was accepted, so it is never back-dated
  // into disclaimerAcceptedAt. Absent on pre-existing records: treat as 'link'.
  confirmedVia?: 'link' | 'verbal'
  verbalNote?: string              // optional context, e.g. "called at 6am, said he's good"
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

  // ── Timeclock (per person) ──
  // Captured when the crew member taps Clock In / Clock Out on their route link.
  // lat/lng/accuracy come from the browser Geolocation API and are the owner's
  // proof of where they were. Coordinates are best-effort: a crew member can deny
  // location permission and still clock in (we record locationDenied instead of
  // blocking their shift), so absence of coords is a fact to surface, not an error.
  clockInAt?: number
  clockInLat?: number
  clockInLng?: number
  clockInAccuracy?: number         // meters, as reported by the device
  clockInLocationDenied?: boolean  // they clocked in but withheld/failed location
  clockOutAt?: number
  clockOutLat?: number
  clockOutLng?: number
  clockOutAccuracy?: number
  clockOutLocationDenied?: boolean
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
  // Optional stored destination coordinates for GPS on-site verification (Wave I).
  // Additive: absent on legacy routes → geofence verification derives 'expected_unavailable'
  // (never a false positive). Populated by manual entry; NO geocoding in the request path.
  reportLat?: number
  reportLng?: number
  reportTime: string            // free text, e.g. "7:00 AM"
  routeDate: string             // YYYY-MM-DD
  description?: string
  payRate?: string              // legacy route-level rate; crew pay lives per-assignee
  vehicle?: string              // snapshot display name of the equipment (or "Crew's own equipment")
  equipmentId?: string          // links to the Equipment roster when a specific asset was picked; absent for own-equipment
  specialNotes?: string

  // Crew (source of truth for multi-person assignment)
  assignees?: Assignee[]
  requiresHelper?: boolean       // stamped from the client's setting — needs a driver + helper

  // Does this route need a COMPANY vehicle or a roster equipment asset before it can
  // be run? OPT-IN, and deliberately so. Plenty of legitimate work needs no company
  // asset at all — crew-own-equipment routes, ride-along/supervision days, routes
  // where the client supplies the truck — and those must never be nagged for a
  // vehicle they will never have. Absent/false (every route that exists today) means
  // "no vehicle needed": no missing-vehicle conflict, no confirm-time validation.
  // Only when an owner explicitly marks a route does the requirement apply.
  requiresVehicle?: boolean

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
  // This crew member's own clock state — drives the Clock In / Clock Out button.
  // Coordinates are never sent back to the crew; only the timestamps they need to
  // see their own status.
  clockInAt?: number
  clockOutAt?: number
  // Whether THIS crew member uses the timeclock at all. False hides the whole
  // clock section on their route link. Resolved live from their staff record.
  timeclock?: boolean
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

// No Redis fallback on purpose — a duplicate route number is worse than a failed
// create. See the note in lib/bookings.ts.
export async function nextRouteNumber(): Promise<string> {
  const n = await redis.incr(KEY_COUNTER)
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
// A driver+helper job is two people, at least one a driver. A SECOND driver fills
// the helper seat — assigning two drivers is the same as a driver + a helper — so a
// spare driver satisfies the helper requirement (it never satisfies the driver one).
export function crewGap(r: RouteRecord): { needsDriver: boolean; needsHelper: boolean; incomplete: boolean } {
  if (!r.requiresHelper) return { needsDriver: false, needsHelper: false, incomplete: false }
  const roles = (r.assignees ?? []).map(a => (a.role || '').toLowerCase())
  const drivers = roles.filter(x => x.includes('driver')).length
  const hasHelper = roles.some(x => x.includes('helper'))
  const needsDriver = drivers === 0
  const needsHelper = !hasHelper && drivers < 2
  return { needsDriver, needsHelper, incomplete: needsDriver || needsHelper }
}

// ── INVARIANT: crew confirmation is NEVER blocked by an owner-controlled field ─
//
// `rollupStatus` can return 'confirmed' the moment every assignee has confirmed,
// and `syncLead` writes that straight onto the record. The public crew link
// (app/api/route/[token]) goes through exactly that path, so a crew member tapping
// "I'll be there" moves the route to Confirmed WITHOUT passing the vehicle check
// that `PATCH action:'confirm'` enforces for an admin.
//
// THIS IS DELIBERATE, AND IT IS THE DESIGNED BEHAVIOUR — not an oversight.
//
//   `requiresVehicle` is an OWNER's setting. A contractor has no ability to assign a
//   truck and no visibility into why one is missing. Refusing their confirmation
//   would strand them on a dead link over a decision they cannot make, and the
//   operational cost of that (a crew member who cannot accept work, and an owner who
//   never learns they were trying to) is far worse than a route that is accepted but
//   not yet equipped.
//
// SO THE INVARIANT IS: crew acceptance and operational readiness are SEPARATE facts.
// Confirmation records "a person has agreed to run this". It does NOT assert the
// route is ready to dispatch. Readiness is `isDispatchReady()` below, which stays
// false while required equipment is missing, and which the schedule surfaces two
// ways that a confirmed status cannot hide:
//   • the `blocked_dispatch` attention flag on the route's own card, and
//   • the `missing_vehicle` conflict, which persists until equipment is assigned.
//
// TEMPORARY. The route model has one status axis, so "crew accepted" and
// "operationally ready" currently share it and readiness is derived rather than
// stored. Splitting them into an explicit dispatch state is tracked separately and
// is deliberately NOT attempted here. Until then, never read `status === 'confirmed'`
// as "ready to run" — read `isDispatchReady()`.
//
// Pinned by scripts/schedule-conflict-scope.test.ts ("CREW ROLLUP INVARIANT").

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

// ── Vehicle / equipment requirement ──────────────────────────────────────────
// ONE rule, shared by the schedule conflict detector and the confirm-time
// validation, so the warning a route shows and the reason it is blocked can never
// disagree. Both read `requiresVehicle`; neither infers the requirement from crew
// shape, service type, or anything else.

/** A company vehicle OR a roster equipment asset has been picked. Either satisfies. */
export function hasVehicleOrEquipment(r: Pick<RouteRecord, 'vehicle' | 'equipmentId'>): boolean {
  return Boolean((r.vehicle ?? '').trim() || (r.equipmentId ?? '').trim())
}

/**
 * True when this route was explicitly marked as needing a vehicle/equipment and
 * still has neither. Returns false for every route that has not opted in — which is
 * every route that exists today, so turning this on adds no warnings to historical
 * work and never blocks a route that legitimately runs without a company asset.
 */
export function needsVehicleAssignment(
  r: Pick<RouteRecord, 'requiresVehicle' | 'vehicle' | 'equipmentId'>,
): boolean {
  return r.requiresVehicle === true && !hasVehicleOrEquipment(r)
}

/** Owner-facing reason a Confirm was refused. Names the fix, not the rule. */
export const VEHICLE_REQUIRED_MESSAGE =
  'This route is marked as needing a vehicle or equipment. Assign one before confirming it, or turn off “Vehicle/equipment required” for this route.'

/**
 * Is this route actually ready to DISPATCH — as opposed to merely accepted?
 *
 * Deliberately distinct from `status === 'confirmed'`. A crew member can (and must
 * be able to) confirm a route whose owner has not yet assigned required equipment —
 * see the INVARIANT block above `rollupStatus`. This is the predicate that stays
 * false in that window, so "somebody agreed to run it" never silently reads as
 * "it can go out".
 *
 * Narrow on purpose: today the only readiness gate is the equipment requirement.
 * Crew sufficiency already has its own signals (`crewGap`, the `missing_crew`
 * conflict) and is not folded in here.
 */
export function isDispatchReady(r: Pick<RouteRecord, 'requiresVehicle' | 'vehicle' | 'equipmentId'>): boolean {
  return !needsVehicleAssignment(r)
}

/** Operator-facing reason a route is accepted but cannot be dispatched. */
export const DISPATCH_BLOCKED_MESSAGE =
  'Crew accepted, but this route still needs its required vehicle or equipment before it can go out.'

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

// The contractor told the owner directly that they're taking the route. This counts
// for scheduling and reliability, but it is NOT an acceptance of CONFIRM_DISCLAIMER
// — only the contractor tapping their own link produces that signature, so
// disclaimerAcceptedAt and confirmIp are deliberately left untouched.
// Someone who declined can still change their mind, so a decline is cleared.
export function confirmVerbally(
  r: RouteRecord, staffId: string, note?: string,
): { ok: true; assignee: Assignee; already?: boolean } | { ok: false; error: string } {
  const a = (r.assignees ?? []).find(x => x.staffId === staffId)
  if (!a) return { ok: false, error: 'That person is not on this crew.' }
  if (a.confirmedAt) return { ok: true, assignee: a, already: true }

  a.confirmedAt = Date.now()
  a.confirmedVia = 'verbal'
  a.verbalNote = note

  const wasDeclined = !!a.declinedAt
  if (wasDeclined) { a.declinedAt = undefined; a.declineReason = undefined }

  pushAudit(r, 'admin', `${a.name} confirmed verbally${wasDeclined ? ' (overrides their earlier decline)' : ''}${note ? ` — ${note}` : ''}`)
  syncLead(r)
  return { ok: true, assignee: a }
}

// Undo an owner-recorded verbal confirm. A confirmation the contractor signed through
// their own link is theirs — it is never erased here.
export function undoVerbalConfirm(
  r: RouteRecord, staffId: string,
): { ok: true; assignee: Assignee; already?: boolean } | { ok: false; error: string } {
  const a = (r.assignees ?? []).find(x => x.staffId === staffId)
  if (!a) return { ok: false, error: 'That person is not on this crew.' }
  if (!a.confirmedAt) return { ok: true, assignee: a, already: true }
  if (a.confirmedVia !== 'verbal')
    return { ok: false, error: `${a.name} confirmed through their own link — that can't be undone here.` }

  a.confirmedAt = undefined
  a.confirmedVia = undefined
  a.verbalNote = undefined
  pushAudit(r, 'admin', `Undid ${a.name}'s verbal confirmation`)
  syncLead(r)
  return { ok: true, assignee: a }
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
  // Read the stored copy BEFORE overwriting it — the assignee diff below is what
  // decides which stale tokens to revoke, and after the write it would compare the
  // record to itself and revoke nothing.
  const prior = await getRouteByToken(r.token).catch(() => null)
  r.updatedAt = Date.now()
  await redis.set(KEY(r.token), JSON.stringify(r))
  await redis.set(KEY_NUM(r.routeNumber.toUpperCase()), r.token)
  await redis.zadd(KEY_INDEX, r.updatedAt, r.token)
  // Map each assignee's own confirm token → this route (the route token maps to
  // itself implicitly, so skip it).
  //
  // WAVE 6D-A. Two things happen here that did not before.
  //
  // (1) ROTATION REVOKES. An assignee removed or re-tokened used to keep a working
  //     `rt:atok:` mapping forever — only deleteRoute cleaned them up, so a
  //     rotated-out driver retained a live public link to the route indefinitely.
  //     The diff against the PREVIOUS assignee set now deletes the stale mapping and
  //     its tenant binding in the SAME write that issues the replacement, so there is
  //     no window where both links work.
  // (2) BINDING. Each live token is bound to the owning tenant so the public route
  //     page can resolve a tenant with no session (see token-binding.ts).
  const live = new Set((r.assignees ?? []).map(a => a.token).filter((t): t is string => !!t && t !== r.token))
  for (const stale of (prior?.assignees ?? []).map(a => a.token)) {
    if (stale && stale !== r.token && !live.has(stale)) {
      await redis.del(KEY_ATOK(stale))
      await revokeTokenBinding(stale)
    }
  }
  for (const t of live) await redis.set(KEY_ATOK(t), r.token)

  // Bind the route token itself plus every live assignee token. All point at the same
  // route resource; the atok indirection is resolved by the handler, not the binding.
  const tenantId = currentTenantId() ?? DEFAULT_TENANT_ID
  for (const t of [r.token, ...live]) {
    try { await bindToken(t, { tenantId, resourceType: 'route', resourceId: r.token }) } catch { /* conflict: never overwrite */ }
  }
}

export async function deleteRoute(token: string): Promise<void> {
  const r = await getRouteByToken(token)
  await redis.del(KEY(token))
  if (r) {
    await redis.del(KEY_NUM(r.routeNumber.toUpperCase()))
    for (const a of r.assignees ?? []) {
      if (a.token && a.token !== token) { await redis.del(KEY_ATOK(a.token)); await revokeTokenBinding(a.token) }
    }
  }
  await redis.zrem(KEY_INDEX, token)
  // The capability dies with the resource.
  await revokeTokenBinding(token)
}

// ── Complete scan (for jobs that MUTATE based on what they find) ─────────────
//
// `listRoutes(n)` is a WINDOW: `zrevrange(rt:index, 0, n-1)` over an index scored by
// `updatedAt`. That is fine for a dashboard — you want the most recently touched
// work — but it is dangerous for a job that acts on what it sees, because a route
// dated today that simply has not been edited lately can fall outside the window and
// be silently skipped. The job then reports "0 candidates", which is indistinguishable
// from "nothing to do". A truncated scan that looks like a clean scan is the failure
// mode worth engineering against.
//
// This snapshots the WHOLE bounded index in one Redis command, then pages the record
// reads and verifies that index membership stayed unchanged. It never raises a limit
// and hopes; it proves coverage or admits it could not.

export type RouteScan = {
  routes: RouteRecord[]
  /** True only when every index entry in the opening snapshot was enumerated. */
  complete: boolean
  /** Index entries enumerated. */
  scanned: number
  /** `zcard` at the start of the scan — the target `scanned` must reach. */
  total: number
  /** Set when `complete` is false; safe to log. */
  truncatedReason?: string
}

/** Hard ceiling. A scan larger than this refuses rather than running unbounded. */
export const ROUTE_SCAN_MAX = 20_000
const ROUTE_SCAN_PAGE = 500

/**
 * Enumerate every route in a stable, bounded index snapshot.
 *
 * `complete` is the contract: it is true ONLY when every unique indexed token has a
 * readable record and index membership is unchanged at the end. Callers that mutate
 * must refuse to act when it is false.
 *
 * Routes written DURING the scan make the snapshot incomplete and defer the whole
 * batch. The auto-cancel path still re-runs full eligibility under each route lock:
 * the scan proposes, the locked record decides.
 */
export async function scanAllRoutes(opts?: { pageSize?: number; max?: number }): Promise<RouteScan> {
  const pageSize = Math.max(1, opts?.pageSize ?? ROUTE_SCAN_PAGE)
  const max = Math.max(1, opts?.max ?? ROUTE_SCAN_MAX)
  const total = await redis.zcard(KEY_INDEX)

  if (total > max) {
    return {
      routes: [], complete: false, scanned: 0, total,
      truncatedReason: `route index holds ${total} entries, above the ${max} scan ceiling`,
    }
  }

  // Capture the index in ONE Redis command. Offset pagination over a sorted set whose
  // scores can change between calls can duplicate one token and skip another while
  // still returning `total` rows. The ceiling above keeps this bounded.
  const openingTokens = total ? await redis.zrange(KEY_INDEX, 0, total - 1) : []
  const uniqueTokens = Array.from(new Set(openingTokens))
  if (openingTokens.length !== total || uniqueTokens.length !== total) {
    return {
      routes: [], complete: false, scanned: uniqueTokens.length, total,
      truncatedReason:
        `route index snapshot was unstable: expected ${total} unique entries, ` +
        `received ${openingTokens.length} entries / ${uniqueTokens.length} unique`,
    }
  }

  // Page the record reads, not the mutable index. A missing or malformed indexed
  // record means the scan is incomplete; destructive callers must see no routes.
  const routes: RouteRecord[] = []
  for (let start = 0; start < uniqueTokens.length; start += pageSize) {
    const page = uniqueTokens.slice(start, start + pageSize)
    const raws = await Promise.all(page.map(t => redis.get(KEY(t))))
    for (let i = 0; i < raws.length; i++) {
      const raw = raws[i]
      if (!raw) {
        return {
          routes: [], complete: false, scanned: routes.length, total,
          truncatedReason: `indexed route ${page[i]} has no readable record`,
        }
      }
      try {
        routes.push(normalize(JSON.parse(raw) as RouteRecord))
      } catch {
        return {
          routes: [], complete: false, scanned: routes.length, total,
          truncatedReason: `indexed route ${page[i]} contains malformed JSON`,
        }
      }
    }
  }

  // Re-read membership after loading records. Any addition, removal, or reordering
  // makes this pass conservative: cancel nothing and let a retry take a clean view.
  const closingTotal = await redis.zcard(KEY_INDEX)
  const closingTokens = closingTotal ? await redis.zrange(KEY_INDEX, 0, closingTotal - 1) : []
  const stable =
    closingTotal === total &&
    closingTokens.length === openingTokens.length &&
    closingTokens.every((token, i) => token === openingTokens[i])

  return stable
    ? { routes, complete: true, scanned: routes.length, total }
    : {
        routes: [], complete: false, scanned: routes.length, total,
        truncatedReason: 'route index changed while the complete scan was running',
      }
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

// Attributed audit: records WHICH named user acted (Principal.sub + role), not just
// the coarse 'admin'/'contractor'/'system' bucket. New guarded mutation sites should
// prefer this so every operational change is traceable to a person. Existing
// pushAudit callers keep the coarse actor until migrated (deferred — see
// docs/opspilot-os/20-security-hardening-sprint.md).
export function pushAuditFor(
  r: RouteRecord, who: { sub: string; role: string },
  actor: AuditEntry['actor'], action: string,
  opts?: { from?: RouteStatus; to?: RouteStatus; note?: string },
): void {
  r.audit.push({ at: Date.now(), actor, action, actorId: who.sub, actorRole: who.role, ...opts })
  if (r.audit.length > 200) r.audit = r.audit.slice(-200)
}

export function pushEvent(r: RouteRecord, type: ConfirmEventType, ip?: string, ua?: string): void {
  r.events.push({ at: Date.now(), type, ip, ua: ua?.slice(0, 300) })
  if (r.events.length > 100) r.events = r.events.slice(-100)
}

/** The synthetic principal every automatic route action is attributed to. */
export const SYSTEM_AUTO_CANCEL_PRINCIPAL = { sub: 'system:route-auto-cancel', role: 'system' } as const

/**
 * Cancel a route automatically, writing exactly ONE attributed lifecycle entry.
 *
 * Why not `setStatus` + a second `pushAudit`: that produced two rows for one event —
 * a bare "status → Cancelled" and a separate reason — and an investigator reading the
 * trail had to know they belonged together. One event, one row, everything needed to
 * explain it in that row:
 *
 *   actor      'system' (coarse bucket) + actorId/actorRole via the ATTRIBUTED path,
 *              so it is unambiguous that a machine did this and which machine
 *   from / to  the previous status and 'cancelled'
 *   note       the reason, the ROUTE date, and the CENTRAL execution date+time
 *
 * Returns false without touching the record if it is Draft or already terminal, so a
 * retry or a route returned to planning is a no-op rather than a cancellation.
 */
export function autoCancelRoute(
  r: RouteRecord,
  ctx: { reason: string; routeDate: string; centralAt: string },
): boolean {
  if (
    r.status === 'draft' ||
    r.status === 'cancelled' ||
    r.status === 'completed' ||
    r.status === 'no_show'
  ) return false
  const from = r.status
  r.status = 'cancelled'
  pushAuditFor(
    r, SYSTEM_AUTO_CANCEL_PRINCIPAL, 'system',
    'Auto-cancelled — no crew assigned at route day start',
    {
      from, to: 'cancelled',
      note: `${ctx.reason} Route date ${ctx.routeDate}. Executed ${ctx.centralAt} America/Chicago.`,
    },
  )
  return true
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
export function toPublicRouteFor(r: RouteRecord, a: Assignee, opts: { showPay?: boolean; timeclock?: boolean } = {}): PublicRoute {
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
    clockInAt: a.clockInAt,
    clockOutAt: a.clockOutAt,
    timeclock: opts.timeclock ?? true,
    payRate: opts.showPay ? a.pay : undefined,
  }
}

// The contractor disclaimer (1099 framing — eligibility/priority, no auto-fine).
export const CONFIRM_DISCLAIMER =
  'I understand that by confirming this route I am agreeing, as an independent contractor, ' +
  'to report on time at the location above and complete the assigned work. If I confirm and ' +
  `then fail to report, ${COMPANY.legalNameUpper} may, after review, reduce my route priority, remove me from ` +
  'future route assignments, or take other action available under my independent contractor ' +
  'agreement. Confirming does not guarantee the route if the client cancels it.'
