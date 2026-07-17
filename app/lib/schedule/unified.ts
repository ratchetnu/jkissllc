// ─────────────────────────────────────────────────────────────────────────────
// Unified Operations schedule — the canonical "Operations job" READ-MODEL.
//
// This module projects the two existing record stores — customer Bookings (bk:*,
// app/lib/bookings) and contract/recurring Routes (rt:*, app/lib/routes) — into ONE
// common `ScheduleItem` shape so the owner sees every source of work (Book Now,
// manual, contract routes, recurring routes, deliveries, moving, junk-removal,
// estate-cleanouts …) on a single operational schedule.
//
// It is PURE + DETERMINISTIC (no Redis, no AI, no I/O). The API layer loads the
// records and calls the projectors here; nothing is persisted, so there is no
// duplicate job to keep in sync and no historical data to migrate. Source records
// stay the owners of their own detail (photos, quotes, AI, confirmations, pay).
// ─────────────────────────────────────────────────────────────────────────────

import {
  type Booking, type BookingStatus, type ServiceType,
  BOOKING_STATUS_LABEL, SERVICE_LABELS,
  effectiveServiceDate, netInvoiceCents, balanceDueCents, paymentSummaryStatus,
  type PaymentSummaryStatus,
} from '../bookings'
import {
  type RouteRecord, type RouteStatus,
  ROUTE_STATUS_LABEL, rollupStatus, crewGap,
} from '../routes'

// ── Common vocabulary ────────────────────────────────────────────────────────
export type ScheduleSource =
  | 'BOOK_NOW'         // Booking.source === 'online' (public Book Now intake)
  | 'MANUAL'           // Booking.source === 'admin'  (admin-created job)
  | 'CONTRACT_ROUTE'   // RouteRecord without a templateId (one-off / contract)
  | 'RECURRING_ROUTE'  // RouteRecord generated from a recurring template
  | 'IMPORTED'         // reserved — future bulk import channel
  | 'OTHER'            // reserved — future intake channels

export const SOURCE_LABEL: Record<ScheduleSource, string> = {
  BOOK_NOW: 'Book Now',
  MANUAL: 'Manual',
  CONTRACT_ROUTE: 'Contract',
  RECURRING_ROUTE: 'Recurring',
  IMPORTED: 'Imported',
  OTHER: 'Other',
}

export type ScheduleKind = 'booking' | 'route'

// Phase 5 — the two lanes. Pending = requested / awaiting review / tentative
// (intake that is NOT confirmed work). Confirmed = committed operational work
// (assigned / confirmed / in progress / completed). Confirmed stays dominant;
// pending renders in a restrained lane.
export type ScheduleLane = 'pending' | 'confirmed'

export type ScheduleCrew = {
  name: string
  staffId?: string       // present for routes (roster-linked); absent for bookings (free-text)
  role?: string
  confirmed?: boolean
}

export type ScheduleItem = {
  id: string                     // stable, unique across sources: `${kind}:${sourceRecordId}`
  kind: ScheduleKind
  source: ScheduleSource
  sourceRecordId: string         // booking token / route token
  number: string                 // JK-B-1042 / JK-R-1001

  serviceType?: ServiceType
  serviceLabel: string
  title: string                  // customer name (booking) or business name (route)
  address?: string

  date: string                   // yyyy-mm-dd real scheduled date; '' when unscheduled
  scheduled: boolean             // has a real, committed service date
  requestedDate?: string         // customer's tentative preferred date (pending Book Now)
  tentative: boolean             // placed on a day only by request, not confirmed
  timeLabel?: string             // arrival window / report time (display)
  sortMinutes: number            // minutes-from-midnight for chronological order (1440 = untimed)

  lane: ScheduleLane
  status: string                 // raw source status
  statusLabel: string
  cancelled: boolean
  completed: boolean
  inProgress: boolean

  crew: ScheduleCrew[]
  crewComplete: boolean          // best-effort: has the crew it needs
  vehicle?: string               // route vehicle snapshot (bookings have none)
  equipmentId?: string           // route equipment-roster link, when a specific asset was picked
  equipment: string[]            // display labels (vehicle + explicit equipment)

  valueCents?: number            // quoted amount (booking) / contract price (route) — caller gates by auth
  paymentState?: PaymentSummaryStatus | 'n/a'
  attention: string[]            // deterministic per-item flags (see attentionFor*)

  href: string                   // cross-navigation to the source record in the admin
}

// ── Bookings that are pre-confirmation intake (the "pending" lane) ────────────
// Everything NOT in this set is committed work: booking_created (deposit taken +
// date reserved), confirmed, in_progress, continued, and the terminal states.
const BOOKING_PENDING_STATUSES: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'quote_received',
  'pending_payment',
  'pending_zelle_verification',
  'payment_received',
  'confirmation_link_sent',
  'customer_viewed',
  'time_verification_pending',
  'time_verified',
])

const BOOKING_CANCELLED: ReadonlySet<BookingStatus> = new Set<BookingStatus>(['cancelled', 'refunded'])
const BOOKING_COMPLETED: ReadonlySet<BookingStatus> = new Set<BookingStatus>([
  'completed', 'partially_completed', 'could_not_complete',
])

// Routes are owner-created committed work; only a `draft` is tentative (not yet
// dispatched). Everything else — assigned, text_sent, confirmed, … — is the
// confirmed lane. Crew-confirmation state is a sub-detail, not a lane.
const ROUTE_CANCELLED: ReadonlySet<RouteStatus> = new Set<RouteStatus>(['cancelled'])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const isIsoDate = (v?: string): v is string => typeof v === 'string' && ISO_DATE.test(v)

// Parse a human time ("8am", "8:00 AM", "7:00 AM", "10:30am–12:30pm", "13:00") to
// minutes-from-midnight using the FIRST time token. Returns null when there is no
// recognizable time so the caller can sort untimed work to the end of the day.
export function parseTimeToMinutes(s?: string): number | null {
  if (!s) return null
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  const ap = m[3]?.toLowerCase()
  if (h > 23 || min > 59) return null
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  return h * 60 + min
}

const UNTIMED = 24 * 60 // untimed work sorts after all timed work, still within its day

// ── Booking → ScheduleItem ───────────────────────────────────────────────────
export function bookingToScheduleItem(b: Booking): ScheduleItem {
  const source: ScheduleSource = b.source === 'online' ? 'BOOK_NOW' : 'MANUAL'
  const date = effectiveServiceDate(b) || ''
  const scheduled = isIsoDate(date)
  const requestedDate = b.bookNow?.requestedDate && isIsoDate(b.bookNow.requestedDate)
    ? b.bookNow.requestedDate : undefined
  const timeLabel = (b.status === 'continued' && b.continuation?.returnWindow)
    ? b.continuation.returnWindow
    : (b.selectedWindow || undefined)

  const cancelled = BOOKING_CANCELLED.has(b.status)
  const completed = BOOKING_COMPLETED.has(b.status)
  const inProgress = b.status === 'in_progress' || b.status === 'continued'
  const lane: ScheduleLane = BOOKING_PENDING_STATUSES.has(b.status) ? 'pending' : 'confirmed'
  const tentative = !scheduled && !!requestedDate

  const crew: ScheduleCrew[] = []
  if (b.assignedTo?.trim()) crew.push({ name: b.assignedTo.trim(), role: 'Lead' })
  if (b.assignedHelper?.trim()) crew.push({ name: b.assignedHelper.trim(), role: 'Helper' })

  const placementDate = scheduled ? date : (requestedDate ?? '')
  const sortMinutes = parseTimeToMinutes(timeLabel) ?? UNTIMED

  return {
    id: `booking:${b.token}`,
    kind: 'booking',
    source,
    sourceRecordId: b.token,
    number: b.bookingNumber,

    serviceType: b.serviceType,
    serviceLabel: SERVICE_LABELS[b.serviceType] ?? 'Service',
    title: b.customerName || 'Customer',
    address: b.jobSiteAddress || b.pickupAddress || b.dropoffAddress || undefined,

    date: scheduled ? date : '',
    scheduled,
    requestedDate,
    tentative,
    timeLabel,
    sortMinutes,

    lane,
    status: b.status,
    statusLabel: BOOKING_STATUS_LABEL[b.status] ?? b.status,
    cancelled,
    completed,
    inProgress,

    crew,
    crewComplete: crew.length > 0,
    vehicle: undefined,
    equipmentId: undefined,
    equipment: [],

    valueCents: netInvoiceCents(b) || undefined,
    paymentState: paymentSummaryStatus(b),
    attention: attentionForBooking(b, { scheduled, placementDate }),

    href: `/admin/operations/book-now/${b.token}`,
  }
}

// ── Route → ScheduleItem ─────────────────────────────────────────────────────
export function routeToScheduleItem(r: RouteRecord): ScheduleItem {
  const source: ScheduleSource = r.templateId ? 'RECURRING_ROUTE' : 'CONTRACT_ROUTE'
  const rolled = rollupStatus(r)
  const date = isIsoDate(r.routeDate) ? r.routeDate : ''
  const scheduled = !!date
  const cancelled = ROUTE_CANCELLED.has(r.status)
  const completed = r.status === 'completed'
  const lane: ScheduleLane = r.status === 'draft' ? 'pending' : 'confirmed'

  const crew: ScheduleCrew[] = (r.assignees ?? []).map(a => ({
    name: a.name, staffId: a.staffId, role: a.role, confirmed: !!a.confirmedAt,
  }))
  const gap = crewGap(r)
  const equipment: string[] = r.vehicle ? [r.vehicle] : []

  const sortMinutes = parseTimeToMinutes(r.reportTime) ?? UNTIMED

  return {
    id: `route:${r.token}`,
    kind: 'route',
    source,
    sourceRecordId: r.token,
    number: r.routeNumber,

    serviceType: undefined,
    serviceLabel: 'Contract Route',
    title: r.businessName || 'Route',
    address: r.reportAddress || undefined,

    date,
    scheduled,
    requestedDate: undefined,
    tentative: false,
    timeLabel: r.reportTime || undefined,
    sortMinutes,

    lane,
    status: r.status,
    statusLabel: ROUTE_STATUS_LABEL[rolled] ?? r.status,
    cancelled,
    completed,
    inProgress: false,

    crew,
    crewComplete: (r.assignees?.length ?? 0) > 0 && !gap.incomplete,
    vehicle: r.vehicle || undefined,
    equipmentId: r.equipmentId,
    equipment,

    valueCents: r.financials?.businessPriceCents,
    paymentState: 'n/a',
    attention: attentionForRoute(r, gap),

    href: `/admin/operations/${r.token}`,
  }
}

// ── Per-item attention flags (deterministic; cross-record checks live in conflicts.ts) ──
function attentionForBooking(b: Booking, ctx: { scheduled: boolean; placementDate: string }): string[] {
  const out: string[] = []
  if (b.status === 'quote_received') out.push('needs_review')
  if (b.status === 'pending_zelle_verification') out.push('zelle_review')
  if (b.aiEstimate?.decision === 'manual_review' && (b.invoiceAmountCents ?? 0) <= 0) out.push('manual_review')
  // Confirmed work with money still owed.
  if (!BOOKING_PENDING_STATUSES.has(b.status) && !BOOKING_CANCELLED.has(b.status) && balanceDueCents(b) > 0) {
    out.push('balance_due')
  }
  // Committed work missing a crew.
  const committed = b.status === 'confirmed' || b.status === 'in_progress'
  if (committed && !b.assignedTo?.trim()) out.push('no_crew')
  void ctx
  return out
}

function attentionForRoute(r: RouteRecord, gap: ReturnType<typeof crewGap>): string[] {
  const out: string[] = []
  if ((r.assignees?.length ?? 0) === 0) out.push('no_crew')
  else if (gap.incomplete) out.push(gap.needsDriver ? 'needs_driver' : 'needs_helper')
  if (!r.vehicle && !r.equipmentId) out.push('no_vehicle')
  if (r.status === 'no_response') out.push('no_response')
  if (r.status === 'no_show') out.push('no_show')
  return out
}

// ── Merge + filter ───────────────────────────────────────────────────────────
// The day a schedule item belongs to: its real scheduled date, else (for a pending
// Book Now request) the customer's tentative preferred date.
export function itemDay(it: ScheduleItem): string {
  return it.date || it.requestedDate || ''
}

// Stable chronological order within a day: timed work first (by minute), untimed
// after, then a deterministic tiebreak on number so ordering never flickers.
export function compareItems(a: ScheduleItem, b: ScheduleItem): number {
  if (a.sortMinutes !== b.sortMinutes) return a.sortMinutes - b.sortMinutes
  return a.number.localeCompare(b.number)
}

export type MergeInput = { bookings?: Booking[]; routes?: RouteRecord[] }

// Project both stores into one sorted list of schedule items.
export function mergeSchedule(input: MergeInput): ScheduleItem[] {
  const items: ScheduleItem[] = [
    ...(input.bookings ?? []).map(bookingToScheduleItem),
    ...(input.routes ?? []).map(routeToScheduleItem),
  ]
  return items.sort(compareItems)
}

// Items that fall on a specific day (yyyy-mm-dd), chronologically ordered. Includes
// tentative Book Now requests whose preferred date matches (Phase 3/5).
export function itemsForDay(items: ScheduleItem[], day: string): ScheduleItem[] {
  return items.filter(it => itemDay(it) === day).sort(compareItems)
}

// Items within an inclusive [startDay, endDay] window (yyyy-mm-dd string compare is
// safe for ISO dates), chronologically then by date.
export function itemsInRange(items: ScheduleItem[], startDay: string, endDay: string): ScheduleItem[] {
  return items
    .filter(it => { const d = itemDay(it); return d >= startDay && d <= endDay })
    .sort((a, b) => {
      const da = itemDay(a), db = itemDay(b)
      return da === db ? compareItems(a, b) : da.localeCompare(db)
    })
}

// Confirmed/committed work with no service date at all — belongs in the
// "Unscheduled" view. Pending intake (no date yet) lives in "Pending requests"
// instead, so the two views never double-count the same record.
export function unscheduledItems(items: ScheduleItem[]): ScheduleItem[] {
  return items.filter(it => it.lane === 'confirmed' && !it.scheduled && !it.cancelled && !it.completed)
}

// Pending intake (requests / awaiting review / tentative) — the restrained lane.
export function pendingItems(items: ScheduleItem[]): ScheduleItem[] {
  return items.filter(it => it.lane === 'pending' && !it.cancelled)
}

// A count summary for the schedule header (deterministic; excludes cancelled).
export type ScheduleCounts = {
  total: number; confirmed: number; pending: number; unscheduled: number
  completed: number; cancelled: number; needsAttention: number
}
export function scheduleCounts(items: ScheduleItem[]): ScheduleCounts {
  const live = items.filter(it => !it.cancelled)
  return {
    total: live.length,
    confirmed: live.filter(it => it.lane === 'confirmed' && !it.completed).length,
    pending: live.filter(it => it.lane === 'pending').length,
    unscheduled: unscheduledItems(items).length,
    completed: items.filter(it => it.completed).length,
    cancelled: items.filter(it => it.cancelled).length,
    needsAttention: live.filter(it => it.attention.length > 0).length,
  }
}
