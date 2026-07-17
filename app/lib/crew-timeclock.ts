import { listRoutes, type Assignee, type RouteRecord } from './routes'
import { getStaff, staffUsesTimeclock } from './staff'
import { centralToday } from './dates'

// ── Crew-portal timeclock ──────────────────────────────────────────────────────
// The portal's session-authenticated punch path. The public route endpoint
// (app/api/route/[token]/route.ts) lets a crew member clock in from their route
// LINK (the token is the credential); this module lets them do the same from
// INSIDE the portal, authenticated by their session and scoped to their staffId.
//
// It never changes the route schema: the clock/GPS fields already live on the
// Assignee (see routes.ts). We only read the routes and mutate those fields —
// always under the route lock (mutateByConfirmToken) at the call site. The pure
// helpers below are what the API route and the tests exercise.

export type ClockAction = 'clock_in' | 'clock_out'
export type ClockPhase = 'not_started' | 'clocked_in' | 'clocked_out'

// A route the crew member can NOT punch — it's over or was called off. (declined /
// unconfirmed is handled per-assignee below, not by route status.)
const NOT_CLOCKABLE_STATUS = new Set(['cancelled', 'completed'])

export type Gps = { lat?: unknown; lng?: unknown; accuracy?: unknown; locationDenied?: unknown }

// A finite number in [lo, hi], else undefined — garbage coordinates are dropped
// rather than stored, matching the public route endpoint. A missing pin is honest;
// a fabricated one is worse than none.
export const coord = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined

export function clockPhase(a: Pick<Assignee, 'clockInAt' | 'clockOutAt'>): ClockPhase {
  if (a.clockOutAt) return 'clocked_out'
  if (a.clockInAt) return 'clocked_in'
  return 'not_started'
}

// May this crew member punch this assignment? They must have confirmed (you can't
// clock a route you never accepted), not declined it, and the route must still be live.
export function isClockable(
  route: Pick<RouteRecord, 'status'>,
  a: Pick<Assignee, 'confirmedAt' | 'declinedAt'>,
): boolean {
  return !!a.confirmedAt && !a.declinedAt && !NOT_CLOCKABLE_STATUS.has(route.status)
}

// The flat, portal-safe view of one clockable assignment. Never includes pay,
// financials, other crew, or GPS coordinates — only this crew member's own punch
// timestamps (coordinates are the owner's proof, surfaced admin-side, not back to crew).
export type ClockableRoute = {
  assigneeToken: string   // this crew member's own token — the mutation key
  routeToken: string      // canonical route token (display/deep-link only)
  routeNumber: string
  businessName: string
  reportAddress: string
  reportTime: string
  routeDate: string
  role: string | null
  status: string
  clockInAt: number | null
  clockOutAt: number | null
  phase: ClockPhase
}

// Pure projection: the crew member's clockable assignments for `day`, from a list
// of routes. Kept pure so it is unit-testable without Redis.
export function selectClockable(routes: RouteRecord[], staffId: string, day: string): ClockableRoute[] {
  const out: ClockableRoute[] = []
  for (const r of routes) {
    if (r.routeDate !== day) continue
    const a = r.assignees?.find((x) => x.staffId === staffId)
    if (!a || !isClockable(r, a)) continue
    out.push({
      assigneeToken: a.token,
      routeToken: r.token,
      routeNumber: r.routeNumber,
      businessName: r.businessName,
      reportAddress: r.reportAddress,
      reportTime: r.reportTime,
      routeDate: r.routeDate,
      role: a.role ?? null,
      status: r.status,
      clockInAt: a.clockInAt ?? null,
      clockOutAt: a.clockOutAt ?? null,
      phase: clockPhase(a),
    })
  }
  return out
}

export async function listClockableForStaff(staffId: string, day = centralToday()): Promise<ClockableRoute[]> {
  const routes = await listRoutes(500)
  return selectClockable(routes, staffId, day)
}

// When no explicit route is named, pick the sensible one to act on: a shift already
// clocked-in-not-out (so the next tap clocks OUT), else one not yet started, else
// the first. Returns null when there is nothing to punch.
export function pickActiveClockable(clockable: ClockableRoute[]): ClockableRoute | null {
  return (
    clockable.find((c) => c.phase === 'clocked_in') ??
    clockable.find((c) => c.phase === 'not_started') ??
    clockable[0] ??
    null
  )
}

// Feature gate — read live from the staff record so the owner's toggle takes effect
// on already-assigned routes. Fail OPEN (default on) if the record can't be read: a
// lookup blip should never strand a legitimate punch.
export async function crewUsesTimeclock(staffId: string): Promise<boolean> {
  try {
    return staffUsesTimeclock(await getStaff(staffId))
  } catch {
    return true
  }
}

export type PunchResult =
  | { ok: true; changed: boolean; already: boolean; denied: boolean }
  | { ok: false; code: 'not_confirmed' | 'not_clocked_in' }

// The pure punch. Mutates the assignee's clock fields for `action` and reports the
// outcome. Idempotent: a repeat clock_in/clock_out makes no change and returns
// `already: true`. GPS is best-effort — a denied/missing fix still records the time
// and flags `denied` so the owner sees the pin is missing, never blocking the shift.
export function applyPunch(assignee: Assignee, action: ClockAction, gps: Gps, now: number): PunchResult {
  if (!assignee.confirmedAt) return { ok: false, code: 'not_confirmed' }

  const lat = coord(gps.lat, -90, 90)
  const lng = coord(gps.lng, -180, 180)
  const acc = coord(gps.accuracy, 0, 100_000)
  const denied = gps.locationDenied === true || lat == null || lng == null

  if (action === 'clock_in') {
    if (assignee.clockInAt) return { ok: true, changed: false, already: true, denied: !!assignee.clockInLocationDenied }
    assignee.clockInAt = now
    assignee.clockInLat = lat
    assignee.clockInLng = lng
    assignee.clockInAccuracy = acc
    assignee.clockInLocationDenied = denied || undefined
    return { ok: true, changed: true, already: false, denied }
  }

  // clock_out
  if (!assignee.clockInAt) return { ok: false, code: 'not_clocked_in' }
  if (assignee.clockOutAt) return { ok: true, changed: false, already: true, denied: !!assignee.clockOutLocationDenied }
  assignee.clockOutAt = now
  assignee.clockOutLat = lat
  assignee.clockOutLng = lng
  assignee.clockOutAccuracy = acc
  assignee.clockOutLocationDenied = denied || undefined
  return { ok: true, changed: true, already: false, denied }
}
