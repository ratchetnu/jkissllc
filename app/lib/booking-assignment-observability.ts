// ─────────────────────────────────────────────────────────────────────────────
// Crew activity — aggregate-only view of the booking ASSIGNMENT audit ledger.
//
// WHY THIS EXISTS. `BOOKING_ASSIGNMENT_ENABLED` has been serving in Production
// since 2026-07-27 and nobody could answer the simplest question about it: has
// any crew member actually used it? The events were already being written by
// `pushBookingEvent` — what was missing was a way to READ them in aggregate.
// Nothing here instruments, migrates, or backfills anything.
//
// WHAT IT DELIBERATELY DOES NOT RETURN. No customer names, addresses, booking
// tokens, pay, notes, photo URLs, individual crew identities, or per-booking
// rows. Crew is a DISTINCT COUNT only — staff ids are hashed into a Set and
// discarded. Every field on the response type below is a number, a boolean, or a
// date string. That is enforced by scripts/booking-assignment-observability.test.ts.
//
// TENANCY. Every read goes through the redis chokepoint (`app/lib/redis.ts`), so
// each key is scoped to the ACTIVE tenant and a missing tenant context throws.
// There is no cross-tenant path: this module never takes a tenant id, never
// iterates tenants, and cannot widen its own scope.
//
// COVERAGE HONESTY. An aggregate that reports totals must be able to prove it saw
// everything. We take the authoritative index size (ZCARD) first, then page the
// index and compare. If the traversal is short for ANY reason — page ceiling hit,
// a token whose record is gone, concurrent index churn — `scanComplete` is false
// and every total must be read as a LOWER BOUND. The UI refuses to present
// authoritative totals in that state.
// ─────────────────────────────────────────────────────────────────────────────

import {
  BOOKING_MAX_EVENTS,
  countBookingIndex,
  readBookingsByTokens,
  scanBookingIndexPage,
  type Booking,
  type BookingEvent,
} from './bookings'

/** The five crew-side assignment actions this surface reports. */
export const ASSIGNMENT_ACTIONS = [
  'assignment.accepted',
  'assignment.declined',
  'assignment.clock_in',
  'assignment.clock_out',
  'assignment.completion_recorded',
] as const
export type AssignmentAction = (typeof ASSIGNMENT_ACTIONS)[number]

const ACTION_SET: ReadonlySet<string> = new Set(ASSIGNMENT_ACTIONS)

export const DEFAULT_RANGE_DAYS = 7
export const MAX_RANGE_DAYS = 90
export const SCAN_PAGE_SIZE = 250
/** Ceiling on pages so one request can never walk an unbounded index. Hitting it
 *  is not silent — it sets `scanComplete: false`. */
export const SCAN_MAX_PAGES = 40
const DAY_MS = 86_400_000

export type ScanCoverage = {
  /** Authoritative index size for the active tenant, taken before paging. */
  indexCount: number
  /** Distinct index tokens traversed. */
  tokensScanned: number
  /** Records successfully loaded and aggregated. */
  bookingsRead: number
  /** Tokens present in the index whose record was missing or unparseable. */
  missingRecords: number
  pagesRead: number
  /** True when the page ceiling stopped the traversal early. */
  pageLimitReached: boolean
  /** False ⇒ every total is a LOWER BOUND. */
  scanComplete: boolean
}

export type AssignmentActivitySummary = {
  range: { start: string; end: string; days: number }
  coverage: ScanCoverage
  totals: {
    events: number
    accepted: number
    declined: number
    clockIn: number
    clockOut: number
    completionRecorded: number
  }
  /** Epoch ms of the earliest / latest in-range assignment event, or null. */
  firstEventAt: number | null
  lastEventAt: number | null
  /** COUNT of distinct crew members seen. Never their identities. */
  distinctCrew: number
  /**
   * Completion idempotency. `withRequestId` splits exactly into
   * `distinctRequestIds + duplicateRequestIds`.
   *
   * Request ids are deduped PER BOOKING, because that is the scope the server
   * dedupes in (`booking.completionRequestIds`).
   *
   * `legacyWithoutRequestId` counts completion events written BEFORE request ids
   * existed. Those events are simply OUTSIDE this check — they are not evidence
   * of a duplicate and not evidence of correctness. Any caller rendering this
   * must say so rather than folding them into either column.
   */
  completionIdempotency: {
    withRequestId: number
    distinctRequestIds: number
    duplicateRequestIds: number
    legacyWithoutRequestId: number
  }
  eventCap: {
    maxEventsPerBooking: number
    bookingsAtCap: number
    /** True when at least one booking sits at the cap, so older events for it
     *  may already have rolled off and its counts are a lower bound. */
    mayHaveDroppedEvents: boolean
  }
}

export type RangeInput = { start?: string | null; end?: string | null; days?: string | number | null }
export type RangeResolution =
  | { ok: true; startMs: number; endMs: number; start: string; end: string; days: number }
  | { ok: false; error: 'invalid_date' | 'inverted_range' | 'range_too_long' }

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * Resolve a bounded UTC range. Defaults to the trailing seven days. An explicit
 * `start`/`end` pair is honoured; anything unparseable, inverted, or longer than
 * MAX_RANGE_DAYS is REFUSED rather than silently clamped, so a caller can never
 * believe it received a 90-day answer when it asked for a year.
 */
export function resolveRange(input: RangeInput, now: number): RangeResolution {
  const rawDays = input.days == null || input.days === '' ? null : Number(input.days)
  const hasExplicit = !!(input.start || input.end)

  if (!hasExplicit) {
    const days = rawDays == null ? DEFAULT_RANGE_DAYS : Math.floor(rawDays)
    if (!Number.isFinite(days) || days < 1) return { ok: false, error: 'invalid_date' }
    if (days > MAX_RANGE_DAYS) return { ok: false, error: 'range_too_long' }
    const endMs = now
    const startMs = endMs - days * DAY_MS
    return { ok: true, startMs, endMs, start: isoDay(startMs), end: isoDay(endMs), days }
  }

  // Explicit range: whole UTC days, end inclusive.
  const startMs = Date.parse(`${input.start ?? ''}T00:00:00.000Z`)
  const endMs = Date.parse(`${input.end ?? isoDay(now)}T23:59:59.999Z`)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { ok: false, error: 'invalid_date' }
  if (endMs < startMs) return { ok: false, error: 'inverted_range' }
  const days = Math.ceil((endMs - startMs) / DAY_MS)
  if (days > MAX_RANGE_DAYS) return { ok: false, error: 'range_too_long' }
  return { ok: true, startMs, endMs, start: isoDay(startMs), end: isoDay(endMs), days }
}

/** Crew identity for DISTINCT COUNTING only. Never returned to a caller. */
function crewKey(e: BookingEvent): string | null {
  const metaStaff = e.meta && typeof e.meta === 'object' ? (e.meta as { staffId?: unknown }).staffId : undefined
  if (typeof metaStaff === 'string' && metaStaff) return metaStaff
  if (typeof e.actor === 'string' && e.actor.startsWith('crew:')) return e.actor.slice(5) || null
  if (typeof e.result === 'string' && e.result) return e.result
  return null
}

function requestIdOf(e: BookingEvent): string | null {
  const raw = e.meta && typeof e.meta === 'object' ? (e.meta as { requestId?: unknown }).requestId : undefined
  return typeof raw === 'string' && raw ? raw : null
}

/**
 * Pure aggregation over already-loaded records. Separated from I/O so the
 * counting rules are testable without a store.
 */
export function aggregateAssignmentActivity(
  bookings: ReadonlyArray<Pick<Booking, 'events'>>,
  range: { startMs: number; endMs: number; start: string; end: string; days: number },
  coverage: ScanCoverage,
): AssignmentActivitySummary {
  const totals = { events: 0, accepted: 0, declined: 0, clockIn: 0, clockOut: 0, completionRecorded: 0 }
  const crew = new Set<string>()
  let firstEventAt: number | null = null
  let lastEventAt: number | null = null
  let withRequestId = 0
  let distinctRequestIds = 0
  let duplicateRequestIds = 0
  let legacyWithoutRequestId = 0
  let bookingsAtCap = 0

  for (const b of bookings) {
    const events = Array.isArray(b.events) ? b.events : []
    if (events.length >= BOOKING_MAX_EVENTS) bookingsAtCap++

    // Per-booking, because that is the server's dedupe scope.
    const seenRequestIds = new Set<string>()

    for (const e of events) {
      if (!e || typeof e.at !== 'number') continue
      if (!ACTION_SET.has(e.action)) continue
      if (e.at < range.startMs || e.at > range.endMs) continue

      totals.events++
      if (firstEventAt === null || e.at < firstEventAt) firstEventAt = e.at
      if (lastEventAt === null || e.at > lastEventAt) lastEventAt = e.at

      const who = crewKey(e)
      if (who) crew.add(who)

      switch (e.action as AssignmentAction) {
        case 'assignment.accepted': totals.accepted++; break
        case 'assignment.declined': totals.declined++; break
        case 'assignment.clock_in': totals.clockIn++; break
        case 'assignment.clock_out': totals.clockOut++; break
        case 'assignment.completion_recorded': {
          totals.completionRecorded++
          const rid = requestIdOf(e)
          if (rid === null) { legacyWithoutRequestId++; break }
          withRequestId++
          if (seenRequestIds.has(rid)) duplicateRequestIds++
          else { seenRequestIds.add(rid); distinctRequestIds++ }
          break
        }
      }
    }
  }

  return {
    range: { start: range.start, end: range.end, days: range.days },
    coverage,
    totals,
    firstEventAt,
    lastEventAt,
    distinctCrew: crew.size,
    completionIdempotency: { withRequestId, distinctRequestIds, duplicateRequestIds, legacyWithoutRequestId },
    eventCap: {
      maxEventsPerBooking: BOOKING_MAX_EVENTS,
      bookingsAtCap,
      mayHaveDroppedEvents: bookingsAtCap > 0,
    },
  }
}

/**
 * Page the booking index for the active tenant and aggregate. Read-only.
 *
 * Coverage is proven, not assumed: ZCARD first, then page until the traversal
 * meets it. Tokens are deduped, because the index is scored by `updatedAt` and a
 * concurrent write can reorder it mid-scan — a duplicate must never inflate a
 * total, and the resulting short count correctly reports `scanComplete: false`.
 */
export async function summarizeAssignmentActivity(
  input: RangeInput,
  now: number = Date.now(),
  /** Paging knobs. Defaults ARE the production constants; tests inject a tiny page
   *  size to exercise multi-page traversal without seeding hundreds of records. */
  opts: { pageSize?: number; maxPages?: number } = {},
): Promise<{ ok: true; summary: AssignmentActivitySummary } | { ok: false; error: RangeResolution & { ok: false } }> {
  const pageSize = Math.max(1, opts.pageSize ?? SCAN_PAGE_SIZE)
  const maxPages = Math.max(1, opts.maxPages ?? SCAN_MAX_PAGES)

  const range = resolveRange(input, now)
  if (!range.ok) return { ok: false, error: range }

  const indexCount = await countBookingIndex()

  const seenTokens = new Set<string>()
  const collected: Pick<Booking, 'events'>[] = []
  let pagesRead = 0
  let missingRecords = 0
  let pageLimitReached = false

  for (let offset = 0; ; offset += pageSize) {
    if (pagesRead >= maxPages) { pageLimitReached = true; break }
    const tokens = await scanBookingIndexPage(offset, pageSize)
    pagesRead++
    if (!tokens.length) break

    const fresh = tokens.filter(t => !seenTokens.has(t))
    for (const t of fresh) seenTokens.add(t)
    if (fresh.length) {
      const { bookings, missing } = await readBookingsByTokens(fresh)
      collected.push(...bookings)
      missingRecords += missing
    }

    if (tokens.length < pageSize) break
    if (seenTokens.size >= indexCount && indexCount > 0) break
  }

  const tokensScanned = seenTokens.size
  const coverage: ScanCoverage = {
    indexCount,
    tokensScanned,
    bookingsRead: collected.length,
    missingRecords,
    pagesRead,
    pageLimitReached,
    scanComplete: !pageLimitReached && missingRecords === 0 && tokensScanned >= indexCount,
  }

  return { ok: true, summary: aggregateAssignmentActivity(collected, range, coverage) }
}
