// Sprint 3.1 Phase A — the scan that feeds the pure analysis.
//
// Read-only. No writes, no flags, no behaviour change. Every read goes through the
// redis chokepoint via the existing helpers, so keys are scoped to the ACTIVE tenant
// and a missing tenant context fails closed. This module names no tenant and takes
// no tenant argument, so it cannot aggregate across tenants.
//
// COVERAGE IS REPORTED PER LANE. Routes and bookings are scanned by different
// primitives with different ceilings, so a partial route scan must not be hidden
// behind a complete booking scan. Either lane falling short makes every total a
// LOWER BOUND, and the page says so instead of presenting authoritative numbers.

import {
  ROUTE_SCAN_MAX, scanAllRoutes, type RouteRecord,
} from '../routes'
import {
  BOOKING_MAX_EVENTS, countBookingIndex, readBookingsByTokens, scanBookingIndexPage,
  type Booking,
} from '../bookings'
import { selectTimeEntries } from '../timesheets'
import {
  analysePunchOverlaps, inferRoutePunchSurface, toPunchIntervals,
  BOOKING_PUNCH_SURFACE, type PunchOverlapSummary, type PunchSurface,
} from './punch-overlaps'

export const BOOKING_PAGE_SIZE = 250
export const BOOKING_MAX_PAGES = 40
/** Route audit/event ledgers are capped in `routes.ts`; mirrored here for reporting. */
export const ROUTE_AUDIT_CAP = 200
export const ROUTE_EVENT_CAP = 100

export type LaneCoverage = {
  indexCount: number
  scanned: number
  read: number
  missingRecords: number
  pageLimitReached: boolean
  scanComplete: boolean
  /** Records sitting AT a ledger cap, so older entries may already have rolled off. */
  recordsAtAuditCap: number
  recordsAtEventCap: number
}

export type PunchOverlapReport = {
  summary: PunchOverlapSummary
  coverage: {
    routes: LaneCoverage
    bookings: LaneCoverage
    /** False ⇒ every count in `summary` is a LOWER BOUND. */
    authoritative: boolean
    caps: {
      routeScanMax: number
      routeAuditCap: number
      routeEventCap: number
      bookingEventCap: number
      bookingPageSize: number
      bookingMaxPages: number
    }
  }
}

const emptyLane = (): LaneCoverage => ({
  indexCount: 0, scanned: 0, read: 0, missingRecords: 0,
  pageLimitReached: false, scanComplete: true, recordsAtAuditCap: 0, recordsAtEventCap: 0,
})

/** Page the booking index completely, deduping tokens (the index is scored by
 *  `updatedAt`, so a concurrent write can reorder it mid-scan). */
async function scanBookings(pageSize: number, maxPages: number): Promise<{ bookings: Booking[]; lane: LaneCoverage }> {
  const lane = emptyLane()
  lane.indexCount = await countBookingIndex()
  const seen = new Set<string>()
  const bookings: Booking[] = []

  for (let offset = 0, pages = 0; ; offset += pageSize) {
    if (pages >= maxPages) { lane.pageLimitReached = true; break }
    const tokens = await scanBookingIndexPage(offset, pageSize)
    pages++
    if (!tokens.length) break
    const fresh = tokens.filter(t => !seen.has(t))
    for (const t of fresh) seen.add(t)
    if (fresh.length) {
      const { bookings: got, missing } = await readBookingsByTokens(fresh)
      bookings.push(...got)
      lane.missingRecords += missing
    }
    if (tokens.length < pageSize) break
    if (lane.indexCount > 0 && seen.size >= lane.indexCount) break
  }

  lane.scanned = seen.size
  lane.read = bookings.length
  for (const b of bookings) if ((b.events?.length ?? 0) >= BOOKING_MAX_EVENTS) lane.recordsAtEventCap++
  lane.scanComplete = !lane.pageLimitReached && lane.missingRecords === 0 && lane.scanned >= lane.indexCount
  return { bookings, lane }
}

function routeLane(scan: { routes: RouteRecord[]; complete: boolean; scanned: number; total: number }): LaneCoverage {
  const lane = emptyLane()
  lane.indexCount = scan.total
  lane.scanned = scan.scanned
  lane.read = scan.routes.length
  lane.pageLimitReached = !scan.complete
  for (const r of scan.routes) {
    if ((r.audit?.length ?? 0) >= ROUTE_AUDIT_CAP) lane.recordsAtAuditCap++
    if ((r.events?.length ?? 0) >= ROUTE_EVENT_CAP) lane.recordsAtEventCap++
  }
  lane.scanComplete = scan.complete && lane.scanned >= lane.indexCount
  return lane
}

/**
 * Build the punch-surface map. Route punches are inferred from the audit trail;
 * booking punches are portal by construction (no public booking punch surface).
 * Keys are `punchId` — `{type}:{jobToken}:{staffId}` — as produced by
 * `selectTimeEntries`.
 */
function buildAttribution(routes: RouteRecord[], bookings: Booking[]): Map<string, PunchSurface> {
  const map = new Map<string, PunchSurface>()
  for (const r of routes) {
    for (const a of r.assignees ?? []) {
      if (!a.clockInAt) continue
      map.set(`route:${r.token}:${a.staffId}`, inferRoutePunchSurface(r.audit ?? [], a.name ?? ''))
    }
  }
  for (const b of bookings) {
    for (const a of b.assignees ?? []) {
      if (!a.clockInAt) continue
      map.set(`booking:${b.token}:${a.staffId}`, BOOKING_PUNCH_SURFACE)
    }
  }
  return map
}

export async function buildPunchOverlapReport(
  now: number = Date.now(),
  opts: { bookingPageSize?: number; bookingMaxPages?: number } = {},
): Promise<PunchOverlapReport> {
  const pageSize = Math.max(1, opts.bookingPageSize ?? BOOKING_PAGE_SIZE)
  const maxPages = Math.max(1, opts.bookingMaxPages ?? BOOKING_MAX_PAGES)

  const scan = await scanAllRoutes()
  const routes = routeLane(scan)
  const { bookings: bookingRecords, lane: bookingsLane } = await scanBookings(pageSize, maxPages)

  const entries = selectTimeEntries(scan.routes, bookingRecords, {})
  const attribution = buildAttribution(scan.routes, bookingRecords)
  const intervals = toPunchIntervals(entries, attribution)
  const analysis = analysePunchOverlaps(intervals, now)

  // `invalid` punches (no clock-in, or clock-out before clock-in) are excluded from
  // the timeline but still counted, so the totals reconcile against Timesheets.
  const invalid = entries.length - intervals.length

  return {
    summary: {
      ...analysis,
      punches: { total: entries.length, open: analysis.punches.open, complete: analysis.punches.complete, invalid },
    },
    coverage: {
      routes,
      bookings: bookingsLane,
      authoritative: routes.scanComplete && bookingsLane.scanComplete,
      caps: {
        routeScanMax: ROUTE_SCAN_MAX,
        routeAuditCap: ROUTE_AUDIT_CAP,
        routeEventCap: ROUTE_EVENT_CAP,
        bookingEventCap: BOOKING_MAX_EVENTS,
        bookingPageSize: pageSize,
        bookingMaxPages: maxPages,
      },
    },
  }
}
