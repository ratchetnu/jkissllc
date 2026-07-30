// ─────────────────────────────────────────────────────────────────────────────
// Sprint 3.1 Phase A — MEASUREMENT ONLY.
//
// Does D1 actually happen? D1 is the divergence where the crew portal refuses a
// second concurrent clock-in (`hasOtherOpenPunch`) but the public contractor link
// does not, so one person can hold two open punches at once.
//
// This module decides NOTHING and changes NOTHING. It does not enforce a rule, set
// a flag, or write a record. It counts. Phase B (consolidating the duplicated punch
// logic) and Phase C (actually enforcing one open punch) are separate, and are not
// started until this produces a number.
//
// A NUANCE WORTH KNOWING BEFORE READING THE OUTPUT. The portal's existing guard is
// DAY-SCOPED: `selectClockable` filters `r.routeDate !== day`, so today it only
// prevents a second open punch among items on the SAME service date. That is why
// every measure below is reported twice — once globally, once restricted to pairs
// sharing a service date. The same-date figure is what the current portal rule
// would have prevented; the global figure is what a stricter rule would catch.
//
// PRIVACY. Every field this module returns is a number, a boolean, or an epoch
// timestamp. No names, staff ids, job tokens, job numbers, locations, or per-record
// arrays. Enforced by scripts/punch-overlap-audit.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { TimeEntry } from '../timesheets'

/** Where a punch was most likely made. INFERRED, never authoritative. */
export type PunchSurface = 'link' | 'portal' | 'unattributable'

/** One punch reduced to what the analysis needs. */
export type PunchInterval = {
  staffKey: string          // opaque grouping key; never returned in the summary
  type: 'route' | 'booking'
  serviceDate: string
  startAt: number
  /** null ⇒ still open; the caller supplies `now` as the effective end. */
  endAt: number | null
  surface: PunchSurface
}

export type OverlapPairKind = 'route/route' | 'route/booking' | 'booking/booking'

export type PunchOverlapSummary = {
  /** The instant used as the end of every OPEN interval. */
  evaluatedAt: number
  punches: {
    total: number
    open: number
    complete: number
    invalid: number
  }
  /** Contractors currently holding more than one open punch — D1, live. */
  openDuplicates: {
    /** Distinct contractors with ≥2 open punches, any service date. */
    contractorsGlobal: number
    /** …restricted to ≥2 open punches sharing ONE service date. */
    contractorsSameDate: number
    /** Largest number of simultaneously open punches held by one contractor. */
    maxOpenForOneContractor: number
    earliestOpenAt: number | null
    latestOpenAt: number | null
  }
  /** Punch intervals that overlapped in time — D1, historical. */
  overlaps: {
    pairsGlobal: number
    pairsSameDate: number
    contractorsGlobal: number
    contractorsSameDate: number
    earliestOverlapStartAt: number | null
    latestOverlapEndAt: number | null
    byPairKind: Record<OverlapPairKind, number>
    /** Overlapping pairs where at least one side is still open. */
    pairsInvolvingOpenPunch: number
  }
  /**
   * INFERRED surface attribution, best-effort by construction — see
   * `inferRoutePunchSurface`. `unattributable` is a real answer, not a failure:
   * the punch outlives the audit entry that would have identified it.
   */
  attribution: {
    inferred: true
    punchesBySurface: Record<PunchSurface, number>
    /** Overlapping pairs, counted by the surfaces of BOTH sides. */
    overlapPairsWithAnyLinkSide: number
    overlapPairsBothPortal: number
    overlapPairsWithUnattributableSide: number
  }
}

/** Half-open intervals: touching endpoints do NOT overlap. A punch that ends at
 *  exactly the instant another begins is a clean handoff, not a double shift. */
export function intervalsOverlap(
  aStart: number, aEnd: number, bStart: number, bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd
}

/**
 * Infer which surface made a ROUTE punch.
 *
 * The punch record itself carries no marker — `Assignee` has `confirmedVia` for
 * confirmation but no `clockedVia` for punches — so this reads the audit trail:
 *   • the portal writes via `pushAuditFor`, which stamps `actorId`/`actorRole` and
 *     whose text says "from the portal";
 *   • the public link writes via `pushAudit`, which stamps neither.
 *
 * The audit array is capped at 200 entries, so on a busy route the punch outlives
 * the entry that identifies it — hence `unattributable`. Matching is by the crew
 * member's name because that is the only per-assignee signal in the audit text;
 * route `events` carry ip/ua but do not say WHICH assignee punched.
 */
export function inferRoutePunchSurface(
  audit: ReadonlyArray<{ action: string; actorId?: string }>,
  assigneeName: string,
): PunchSurface {
  if (!assigneeName) return 'unattributable'
  const mine = audit.filter(e =>
    typeof e.action === 'string' &&
    /clocked (in|out)/i.test(e.action) &&
    e.action.includes(assigneeName))
  if (!mine.length) return 'unattributable'
  const portal = mine.some(e => !!e.actorId || /from the portal/i.test(e.action))
  return portal ? 'portal' : 'link'
}

/** Booking punches can only be made from the authenticated portal — there is no
 *  public booking punch surface — so the lane itself is the attribution. */
export const BOOKING_PUNCH_SURFACE: PunchSurface = 'portal'

/**
 * Reduce timesheet entries to intervals. `attribution` is keyed by `punchId`
 * (`{type}:{jobToken}:{staffId}`), which `selectTimeEntries` already produces.
 *
 * `staffKey` is the raw staff id here so grouping is correct; it is consumed
 * internally and never reaches the summary.
 */
export function toPunchIntervals(
  entries: ReadonlyArray<TimeEntry>,
  attribution: ReadonlyMap<string, PunchSurface>,
): PunchInterval[] {
  const out: PunchInterval[] = []
  for (const e of entries) {
    if (e.clockInAt == null) continue                 // 'invalid' — nothing to place on a timeline
    if (e.clockOutAt != null && e.clockOutAt < e.clockInAt) continue  // reversed; also 'invalid'
    out.push({
      staffKey: e.staffId,
      type: e.type,
      serviceDate: e.date,
      startAt: e.clockInAt,
      endAt: e.clockOutAt,
      surface: attribution.get(e.punchId)
        ?? (e.type === 'booking' ? BOOKING_PUNCH_SURFACE : 'unattributable'),
    })
  }
  return out
}

const pairKind = (a: PunchInterval, b: PunchInterval): OverlapPairKind =>
  a.type === 'route' && b.type === 'route' ? 'route/route'
    : a.type === 'booking' && b.type === 'booking' ? 'booking/booking'
      : 'route/booking'

/**
 * The whole measurement, pure.
 *
 * `now` is the audit request time and is used as the end of EVERY open interval,
 * so two punches left open are treated as overlapping right up to the moment the
 * report was produced — which is exactly the operational claim being tested.
 */
export function analysePunchOverlaps(
  intervals: ReadonlyArray<PunchInterval>,
  now: number,
): Omit<PunchOverlapSummary, 'punches'> & { punches: { open: number; complete: number } } {
  const byStaff = new Map<string, PunchInterval[]>()
  for (const p of intervals) {
    const list = byStaff.get(p.staffKey)
    if (list) list.push(p); else byStaff.set(p.staffKey, [p])
  }

  let open = 0, complete = 0
  let earliestOpenAt: number | null = null
  let latestOpenAt: number | null = null
  const openContractorsGlobal = new Set<string>()
  const openContractorsSameDate = new Set<string>()
  let maxOpenForOneContractor = 0

  let pairsGlobal = 0, pairsSameDate = 0, pairsInvolvingOpenPunch = 0
  const overlapContractorsGlobal = new Set<string>()
  const overlapContractorsSameDate = new Set<string>()
  let earliestOverlapStartAt: number | null = null
  let latestOverlapEndAt: number | null = null
  const byPairKind: Record<OverlapPairKind, number> = { 'route/route': 0, 'route/booking': 0, 'booking/booking': 0 }
  let anyLink = 0, bothPortal = 0, anyUnattributable = 0
  const punchesBySurface: Record<PunchSurface, number> = { link: 0, portal: 0, unattributable: 0 }

  for (const p of intervals) {
    punchesBySurface[p.surface]++
    if (p.endAt == null) open++; else complete++
  }

  for (const [staffKey, list] of byStaff) {
    // ── currently open ──
    const openList = list.filter(p => p.endAt == null)
    if (openList.length > maxOpenForOneContractor) maxOpenForOneContractor = openList.length
    if (openList.length >= 2) {
      openContractorsGlobal.add(staffKey)
      const perDate = new Map<string, number>()
      for (const p of openList) perDate.set(p.serviceDate, (perDate.get(p.serviceDate) ?? 0) + 1)
      if ([...perDate.values()].some(n => n >= 2)) openContractorsSameDate.add(staffKey)
    }
    for (const p of openList) {
      if (earliestOpenAt === null || p.startAt < earliestOpenAt) earliestOpenAt = p.startAt
      if (latestOpenAt === null || p.startAt > latestOpenAt) latestOpenAt = p.startAt
    }

    // ── overlapping intervals ──
    // O(n²) per contractor. One person's punch count is small; the scan that feeds
    // this is the bounded cost, not this loop.
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j]
        const aEnd = a.endAt ?? now
        const bEnd = b.endAt ?? now
        if (!intervalsOverlap(a.startAt, aEnd, b.startAt, bEnd)) continue

        pairsGlobal++
        overlapContractorsGlobal.add(staffKey)
        if (a.serviceDate === b.serviceDate) {
          pairsSameDate++
          overlapContractorsSameDate.add(staffKey)
        }
        if (a.endAt == null || b.endAt == null) pairsInvolvingOpenPunch++
        byPairKind[pairKind(a, b)]++

        const start = Math.min(a.startAt, b.startAt)
        const end = Math.max(aEnd, bEnd)
        if (earliestOverlapStartAt === null || start < earliestOverlapStartAt) earliestOverlapStartAt = start
        if (latestOverlapEndAt === null || end > latestOverlapEndAt) latestOverlapEndAt = end

        if (a.surface === 'unattributable' || b.surface === 'unattributable') anyUnattributable++
        else if (a.surface === 'link' || b.surface === 'link') anyLink++
        else bothPortal++
      }
    }
  }

  return {
    evaluatedAt: now,
    punches: { open, complete },
    openDuplicates: {
      contractorsGlobal: openContractorsGlobal.size,
      contractorsSameDate: openContractorsSameDate.size,
      maxOpenForOneContractor,
      earliestOpenAt,
      latestOpenAt,
    },
    overlaps: {
      pairsGlobal,
      pairsSameDate,
      contractorsGlobal: overlapContractorsGlobal.size,
      contractorsSameDate: overlapContractorsSameDate.size,
      earliestOverlapStartAt,
      latestOverlapEndAt,
      byPairKind,
      pairsInvolvingOpenPunch,
    },
    attribution: {
      inferred: true,
      punchesBySurface,
      overlapPairsWithAnyLinkSide: anyLink,
      overlapPairsBothPortal: bothPortal,
      overlapPairsWithUnattributableSide: anyUnattributable,
    },
  }
}
