// ─────────────────────────────────────────────────────────────────────────────
// Stale-route auto-cancellation — SELECTION ONLY.
//
// A route sitting on today's board with nobody assigned to it is not a schedule,
// it is a gap the owner has already run out of time to fill. The rule the owner
// asked for: at midnight America/Chicago, as the route day BEGINS, a live route
// dated that day with no crew on it is called off.
//
// This module decides WHO is eligible and nothing else. It performs no I/O, holds
// no clock of its own (every entry point takes a timestamp), and never mutates a
// route — so the boundary conditions that actually matter (midnight, DST, "is this
// route today or tomorrow") are testable without Redis, without a cron, and without
// the feature flag. The write path lives in app/api/cron/route-auto-cancel.
//
// DELIBERATE NON-GOALS
//   • Future routes are never touched. A route dated tomorrow has not reached its
//     deadline; cancelling it early would destroy work the owner still has a full
//     day to staff.
//   • PAST routes are never touched either. History is not re-litigated by a cron —
//     a route that already happened is the owner's to close out, and a job that
//     silently cancelled last week's work would be rewriting the record.
//   • A route with ANY crew on it is never touched, whatever else is missing. Missing
//     a vehicle is a warning; missing a person is what this rule is about.
// ─────────────────────────────────────────────────────────────────────────────

import type { RouteRecord, RouteStatus } from '../routes'

/** Statuses that are already closed out. Re-cancelling these is meaningless. */
const TERMINAL: ReadonlySet<RouteStatus> = new Set<RouteStatus>(['cancelled', 'completed', 'no_show'])

/** The operational timezone. The owner's midnight, not the server's. */
export const OPS_TIMEZONE = 'America/Chicago'

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: OPS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
})
const HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: OPS_TIMEZONE, hour: '2-digit', hour12: false,
})

/** Calendar date (yyyy-mm-dd) in the operational timezone for a timestamp. */
export function centralDate(ts: number): string {
  return DATE_FMT.format(new Date(ts))
}

/**
 * Hour-of-day 0–23 in the operational timezone.
 *
 * Uses Intl rather than a fixed UTC offset on purpose: Central is UTC-5 for part of
 * the year and UTC-6 for the rest, so any hardcoded offset is wrong for ~half the
 * calendar. `hour12: false` can format midnight as "24" in some ICU versions, which
 * is why this normalizes rather than trusting the string.
 */
export function centralHour(ts: number): number {
  const h = Number(HOUR_FMT.format(new Date(ts)))
  return Number.isFinite(h) ? h % 24 : NaN
}

/**
 * How long after Central midnight the cancellation may still run.
 *
 * A single instant (hour 0 only) meant exactly ONE attempt per day: if that attempt
 * was missed — a deploy in flight, a cold start that timed out, a platform hiccup —
 * the route rolled past its date the next day and became permanently ineligible,
 * silently. The rule simply would not have happened, and nothing said so.
 *
 * A short grace window turns that single point of failure into a retry. It is safe
 * precisely because eligibility is pinned to `routeDate === today Central`: a run at
 * 02:00 can only ever touch routes for TODAY, never yesterday's or anything older.
 * Widening this window can never reach back into history.
 */
export const CANCELLATION_GRACE_HOURS = 3

/**
 * Is `ts` inside the cancellation window — Central midnight through the end of the
 * grace period (00:00–02:59:59 America/Chicago)?
 *
 * Multiple firings inside the window are EXPECTED and safe: the write path re-reads
 * each record under its lock and `autoCancelRoute` refuses an already-terminal route,
 * so the second and later attempts are no-ops rather than second cancellations.
 */
export function isCancellationWindow(ts: number): boolean {
  const h = centralHour(ts)
  return Number.isFinite(h) && h >= 0 && h < CANCELLATION_GRACE_HOURS
}

/** Central wall-clock stamp (yyyy-mm-dd HH:mm) — recorded on the audit entry. */
const STAMP_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: OPS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})
export function centralStamp(ts: number): string {
  return STAMP_FMT.format(new Date(ts)).replace(',', '')
}

export type AutoCancelReason = 'no_crew_at_route_day_start'

export type AutoCancelCandidate = {
  token: string
  routeNumber: string
  routeDate: string
  businessName: string
  status: RouteStatus
  reason: AutoCancelReason
  /** Owner-readable justification — this is what dry-run reports and what is audited. */
  detail: string
}

/** A route is "live" when it is on the board and not already closed out. */
export function isLiveRoute(r: RouteRecord): boolean {
  return !TERMINAL.has(r.status)
}

/** Nobody at all is assigned. Not "short-handed" — literally zero crew. */
export function hasNoCrew(r: RouteRecord): boolean {
  return (r.assignees?.length ?? 0) === 0
}

/**
 * Eligible routes for automatic cancellation at `now`.
 *
 * A route qualifies when ALL of these hold:
 *   1. its `routeDate` is exactly today in Central time — not earlier, not later;
 *   2. it is committed work, not a draft (`status !== 'draft'`, the same test the
 *      schedule uses to place a route in the confirmed lane);
 *   3. it is not already cancelled / completed / no-show;
 *   4. it has zero crew assigned.
 *
 * Returns a stable, sorted list so a dry-run report and the subsequent live run
 * describe the same routes in the same order, and so retrying produces an identical
 * result rather than a reshuffled one.
 *
 * Note this is INDEPENDENT of the cancellation window: callers ask "who is eligible"
 * and separately "is it time". Keeping those apart is what lets a dry-run at 2pm
 * still answer the real question.
 */
export function selectAutoCancelCandidates(routes: RouteRecord[], now: number): AutoCancelCandidate[] {
  const today = centralDate(now)
  const out: AutoCancelCandidate[] = []
  for (const r of routes) {
    if (r.routeDate !== today) continue          // not its day (past OR future)
    if (r.status === 'draft') continue           // not committed work yet
    if (!isLiveRoute(r)) continue                // already closed out
    if (!hasNoCrew(r)) continue                  // somebody is on it
    out.push({
      token: r.token,
      routeNumber: r.routeNumber,
      routeDate: r.routeDate,
      businessName: r.businessName || '',
      status: r.status,
      reason: 'no_crew_at_route_day_start',
      detail: `No crew assigned as of 00:00 ${OPS_TIMEZONE} on ${r.routeDate}.`,
    })
  }
  out.sort((a, b) => a.routeNumber.localeCompare(b.routeNumber) || a.token.localeCompare(b.token))
  return out
}

/** The audit note written when a candidate is actually cancelled. */
export function autoCancelAuditNote(c: AutoCancelCandidate): string {
  return `Auto-cancelled: ${c.detail}`
}
