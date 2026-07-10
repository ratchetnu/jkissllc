import { listStaff, staffUsesTimeclock } from './staff'
import { listRoutes, type RouteRecord, type Assignee } from './routes'
import { listAll as listAllTimeOff, type TimeOffRequest } from './timeoff'
import { getWeek } from './crew-availability'
import { hasUniformToday } from './uniform'
import { listInstances } from './reminders'
import { bizKey } from './businesses'
import { centralToday, addDaysStr, mondayOf, isDateStr } from './dates'
import type { SegmentId, SuppressKey } from './reminder-templates'

// Crew targeting + smart-suppression (request Parts 1 & 4). Builds one rich "crew
// card" per crew member with today's operational status, from which every directory
// segment and every suppression decision is derived. Computed from the existing
// stores (staff, routes, time-off, availability, uniform, reminder instances) — no
// new source of truth.

export type ClockState = 'in' | 'out' | 'none' | 'na'   // na = not on the clock today

export type CrewRouteLite = {
  token: string
  routeNumber: string
  businessName: string
  routeDate: string
  reportTime: string
  status: string
  confirmed: boolean
}

export type CrewCard = {
  id: string
  name: string
  photoUrl?: string
  phone?: string
  email?: string
  role?: string
  active: boolean
  onboarding: boolean

  businessNames: string[]
  businessKeys: string[]
  todayRoutes: CrewRouteLite[]
  upcomingRoutes: CrewRouteLite[]      // today + tomorrow, non-terminal
  hasActiveRouteToday: boolean

  // Operational status (today, Central).
  confirmed: boolean | null            // all upcoming assignments confirmed? null = none pending
  clockIn: ClockState
  clockOut: boolean
  uniform: boolean                     // uploaded today
  availabilitySubmitted: boolean       // NEXT week submitted
  onTimeOff: boolean                   // approved time off covering today
  hasOpenAck: boolean                  // an unacknowledged require-ack reminder is outstanding
  doneTemplatesToday: string[]         // template ids the crew acted "done" on today

  lastActivityAt?: number
  lastResponseAt?: number
  activeNow: boolean                   // activity within the last 15 minutes

  // Which "missing / status" segments this crew member is in right now.
  flags: SegmentId[]
}

const TERMINAL = new Set(['completed', 'cancelled', 'no_show', 'declined'])
const PENDING_ASSIGN = (a: Assignee) => !a.confirmedAt && !a.declinedAt

// Approved time off covering a given Central day (no built-in helper exists — Part 10).
export function approvedTimeOffOn(requests: TimeOffRequest[], staffId: string, dateYmd: string): boolean {
  return requests.some(r =>
    r.staffId === staffId &&
    r.status === 'approved' &&
    isDateStr(r.startDate) && isDateStr(r.endDate) &&
    r.startDate <= dateYmd && dateYmd <= r.endDate,
  )
}

function assigneeOf(route: RouteRecord, staffId: string): Assignee | undefined {
  return (route.assignees ?? []).find(a => a.staffId === staffId)
}

function toLite(route: RouteRecord, a: Assignee | undefined): CrewRouteLite {
  return {
    token: route.token,
    routeNumber: route.routeNumber,
    businessName: route.businessName,
    routeDate: route.routeDate,
    reportTime: route.reportTime || '',
    status: route.status,
    confirmed: !!a?.confirmedAt,
  }
}

// Build the full directory. One pass over staff + routes + time-off + a single
// instance scan; per-crew availability/uniform are the only per-person lookups.
export async function buildCrewCards(now: number = Date.now()): Promise<CrewCard[]> {
  const today = centralToday(now)
  const tomorrow = addDaysStr(today, 1)
  const nextWeekMonday = addDaysStr(mondayOf(today), 7)

  const [staff, routes, timeoff, instances] = await Promise.all([
    listStaff(500),
    listRoutes(1000),
    listAllTimeOff(500),
    listInstances(1500),
  ])

  // Per-staff ack maps from a single instance scan (today only), for missing_ack +
  // missing_delivery_app + the 'acked_done' suppression rule.
  const openAck = new Set<string>()
  const doneByStaff = new Map<string, Set<string>>()
  const lastResponseByStaff = new Map<string, number>()
  for (const i of instances) {
    if (centralToday(i.sentAt) !== today) continue
    if (i.requireAck && !i.completedAt && !i.ackAt) openAck.add(i.staffId)
    if (i.completedAt || i.ackAt) {
      const prev = lastResponseByStaff.get(i.staffId) ?? 0
      const at = i.ackAt ?? i.completedAt ?? 0
      if (at > prev) lastResponseByStaff.set(i.staffId, at)
    }
    if (i.completedAt) {
      const set = doneByStaff.get(i.staffId) ?? new Set<string>()
      set.add(i.templateId)
      doneByStaff.set(i.staffId, set)
    }
  }

  // Index routes by the crew assigned to them (today + tomorrow window).
  const window = new Set([today, tomorrow])
  const cards = await Promise.all(staff.map(async (s): Promise<CrewCard> => {
    const myRoutes = routes.filter(r => window.has(r.routeDate) && (r.assignees ?? []).some(a => a.staffId === s.id))
    const todayRoutesR = myRoutes.filter(r => r.routeDate === today && !TERMINAL.has(r.status))
    const upcomingR = myRoutes.filter(r => !TERMINAL.has(r.status))

    const todayRoutes = todayRoutesR.map(r => toLite(r, assigneeOf(r, s.id)))
    const upcomingRoutes = upcomingR.map(r => toLite(r, assigneeOf(r, s.id)))
    const businessNames = Array.from(new Set(upcomingRoutes.map(r => r.businessName).filter(Boolean)))
    const businessKeys = Array.from(new Set(businessNames.map(bizKey)))

    // Confirmation across pending upcoming assignments.
    const pendingUpcoming = upcomingR.filter(r => PENDING_ASSIGN(assigneeOf(r, s.id) ?? ({} as Assignee)))
    const confirmed: boolean | null = upcomingR.length === 0 ? null : pendingUpcoming.length === 0

    // Clock status from today's assignee punches (only if this person is on the clock).
    const usesClock = staffUsesTimeclock(s)
    let clockIn: ClockState = 'na'
    let clockOut = false
    if (todayRoutesR.length && usesClock) {
      const a = assigneeOf(todayRoutesR[0], s.id)
      clockIn = a?.clockInAt ? 'in' : 'none'
      clockOut = !!a?.clockOutAt
      if (clockOut) clockIn = 'out'
    }

    const onTimeOff = approvedTimeOffOn(timeoff, s.id, today)

    const [uniform, nextWeek] = await Promise.all([
      hasUniformToday(s.id, today),
      getWeek(s.id, nextWeekMonday),
    ])
    const availabilitySubmitted = nextWeek?.status === 'submitted'

    const done = doneByStaff.get(s.id) ?? new Set<string>()
    const hasActiveRouteToday = todayRoutesR.length > 0

    // Last activity: latest of confirm / clock / ack timestamps we can see cheaply.
    const activityTimes: number[] = []
    for (const r of todayRoutesR) {
      const a = assigneeOf(r, s.id)
      for (const t of [a?.confirmedAt, a?.clockInAt, a?.clockOutAt]) if (t) activityTimes.push(t)
    }
    const lastResponseAt = lastResponseByStaff.get(s.id)
    if (lastResponseAt) activityTimes.push(lastResponseAt)
    const lastActivityAt = activityTimes.length ? Math.max(...activityTimes) : undefined

    const card: CrewCard = {
      id: s.id, name: s.name, photoUrl: s.photoUrl, phone: s.phone, email: s.email,
      role: s.role, active: s.active, onboarding: !!s.onboarding,
      businessNames, businessKeys, todayRoutes, upcomingRoutes, hasActiveRouteToday,
      confirmed, clockIn, clockOut, uniform, availabilitySubmitted, onTimeOff,
      hasOpenAck: openAck.has(s.id), doneTemplatesToday: Array.from(done),
      lastActivityAt, lastResponseAt,
      activeNow: !!lastActivityAt && (now - lastActivityAt) < 15 * 60 * 1000,
      flags: [],
    }
    card.flags = computeFlags(card)
    return card
  }))

  return cards.sort((a, b) => a.name.localeCompare(b.name))
}

function computeFlags(c: CrewCard): SegmentId[] {
  const flags: SegmentId[] = ['all']
  // Time off suppresses the "missing / owes us something" signals — they're not
  // expected to act today.
  if (!c.onTimeOff) {
    if (c.hasActiveRouteToday && !c.uniform) flags.push('missing_uniform')
    if (c.hasActiveRouteToday && c.clockIn === 'none') flags.push('missing_clock_in')
    if (c.hasActiveRouteToday && c.clockIn === 'in' && !c.clockOut) flags.push('missing_clock_out')
    if (c.confirmed === false) { flags.push('missing_route_confirmation'); flags.push('unconfirmed') }
    if (c.hasActiveRouteToday && !c.doneTemplatesToday.includes('delivery_app')) flags.push('missing_delivery_app')
    if (c.hasOpenAck) flags.push('missing_ack')
  }
  if (!c.availabilitySubmitted) flags.push('missing_availability')
  // "available" reflects submitted availability that says available — we approximate
  // with: not on time off and has upcoming work or submitted next-week availability.
  if (!c.onTimeOff && (c.hasActiveRouteToday || c.availabilitySubmitted)) flags.push('available')
  return flags
}

export function segmentMatch(card: CrewCard, seg: SegmentId): boolean {
  if (seg === 'all') return true
  return card.flags.includes(seg)
}

export function filterBySegment(cards: CrewCard[], seg: SegmentId): CrewCard[] {
  return cards.filter(c => segmentMatch(c, seg))
}

// The suppression decision for one crew card + one template (request Part 4). Returns
// true when the reminder should NOT be sent. The universal time-off guard is applied
// by the engine before this; here we handle the task-specific rules.
export function isSuppressedForTemplate(card: CrewCard, suppress: SuppressKey, templateId: string): boolean {
  switch (suppress) {
    case 'uniform_uploaded': return card.uniform
    case 'clocked_in': return card.clockIn === 'in' || card.clockIn === 'out'
    case 'clocked_out': return card.clockOut
    case 'route_confirmed': return card.confirmed === true
    case 'availability_submitted': return card.availabilitySubmitted
    case 'acked_done': return card.doneTemplatesToday.includes(templateId)
    case 'none':
    default: return false
  }
}

// Convenience for the directory API: the ordered segment list with live counts.
export function segmentCounts(cards: CrewCard[]): Record<SegmentId, number> {
  const ids: SegmentId[] = [
    'all', 'available', 'unconfirmed', 'missing_uniform', 'missing_clock_in',
    'missing_clock_out', 'missing_route_confirmation', 'missing_delivery_app',
    'missing_availability', 'missing_ack',
  ]
  const out = {} as Record<SegmentId, number>
  for (const id of ids) out[id] = cards.filter(c => segmentMatch(c, id)).length
  return out
}
