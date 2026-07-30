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
import { listCorrectionsForPunches, punchId } from '../time-corrections'
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
    /** Corrections projected onto the punches. Loading these is mandatory: the
     *  report throws rather than falling back to raw stamps. */
    corrections: {
      punchIdsQueried: number
      punchesWithCorrections: number
      entriesCorrected: number
    }
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
      // A punch that exists ONLY because of a correction has no originating surface —
      // an admin created it. Claiming one would be a guess, so it stays unattributable.
      map.set(`route:${r.token}:${a.staffId}`,
        a.clockInAt ? inferRoutePunchSurface(r.audit ?? [], a.name ?? '') : 'unattributable')
    }
  }
  for (const b of bookings) {
    for (const a of b.assignees ?? []) {
      map.set(`booking:${b.token}:${a.staffId}`,
        a.clockInAt ? BOOKING_PUNCH_SURFACE : 'unattributable')
    }
  }
  return map
}

/**
 * Every punch id in the scan — for EVERY assignee, not only those with a raw
 * clock-in. `selectTimeEntries` surfaces an entry that exists purely because of a
 * correction (a crew member who forgot to punch), so narrowing this to punched
 * assignees would hide exactly those.
 */
function allPunchIds(routes: RouteRecord[], bookings: Booking[]): string[] {
  const ids: string[] = []
  for (const r of routes) for (const a of r.assignees ?? []) ids.push(punchId('route', r.token, a.staffId))
  for (const b of bookings) for (const a of b.assignees ?? []) ids.push(punchId('booking', b.token, a.staffId))
  return ids
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

  // CORRECTIONS ARE PART OF THE ANSWER, NOT A GARNISH. A time correction is exactly
  // how a bad punch gets fixed, so an audit that read raw stamps would keep reporting
  // a corrected punch as open and would compute overlaps from superseded times. This
  // shipped that way in #137 and the first correction ever applied exposed it.
  //
  // If corrections cannot be loaded this THROWS rather than falling back to raw
  // punches. Silently degrading would produce confident, wrong numbers on the one
  // surface whose entire purpose is accuracy — the endpoint answers 503 instead.
  const punchIds = allPunchIds(scan.routes, bookingRecords)
  let corrections: Awaited<ReturnType<typeof listCorrectionsForPunches>>
  try {
    corrections = await listCorrectionsForPunches(punchIds)
  } catch (cause) {
    throw new Error('punch-overlap: corrections could not be loaded; refusing to report raw punches', { cause })
  }

  // Every timestamp below is the EFFECTIVE (correction-adjusted) punch.
  const entries = selectTimeEntries(scan.routes, bookingRecords, {}, corrections)
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
      corrections: {
        punchIdsQueried: punchIds.length,
        punchesWithCorrections: corrections.size,
        entriesCorrected: entries.filter(e => e.corrected).length,
      },
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
