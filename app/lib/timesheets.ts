// ── Timesheets — one place for hours math + rollups ──────────────────────────
//
// The admin timesheet reads the SAME clock stamps the crew punch writes (on each
// route/booking assignee) and turns them into hours. Centralized + PURE so the
// duration rules — open punches, invalid ordering, overnight shifts, missing
// clock-out — are defined once and unit-tested without Redis. Nothing here mutates.

import type { RouteRecord } from './routes'
import { effectiveServiceDate, type Booking } from './bookings'
import type { JobAssignee } from './job-assignment'
import { punchId, effectivePunch, type TimeCorrection } from './time-corrections'

export type PunchStatus = 'open' | 'complete' | 'invalid'

export type TimeEntry = {
  type: 'route' | 'booking'
  jobToken: string
  jobNumber: string
  staffId: string
  staffName: string
  date: string
  /** EFFECTIVE clock stamps — the original punch unless a correction supersedes it. */
  clockInAt: number | null
  clockOutAt: number | null
  durationMinutes: number | null   // null unless the punch is complete + well-ordered
  status: PunchStatus
  locationDenied: boolean
  // ── Correction projection (FIN/TIME wave) ─────────────────────────────────
  /** Stable derived punch identity — `{type}:{jobToken}:{staffId}`. */
  punchId: string
  /** True when an active correction supersedes the original punch. */
  corrected: boolean
  /** The immutable original, kept beside the effective value for display + audit. */
  originalClockInAt: number | null
  originalClockOutAt: number | null
  correctionId?: string
  correctedAt?: number
  correctionCount: number
}

export type TimeFilter = { staffId?: string; start?: string; end?: string; type?: 'route' | 'booking' }

// open     = clocked in, not yet out (in progress, or a forgotten clock-out)
// invalid  = clock-out precedes clock-in, or a clock-out with no clock-in (bad data)
// complete = a well-ordered pair
export function punchStatus(clockInAt: number | null, clockOutAt: number | null): PunchStatus {
  if (clockInAt == null) return 'invalid'
  if (clockOutAt == null) return 'open'
  if (clockOutAt < clockInAt) return 'invalid'
  return 'complete'
}

// Minutes worked — ONLY for a complete, well-ordered punch. Open/invalid → null so
// they can never be silently folded into a payable total. An overnight shift is
// simply a larger positive diff and needs no special case.
export function durationMinutes(clockInAt: number | null, clockOutAt: number | null): number | null {
  if (punchStatus(clockInAt, clockOutAt) !== 'complete') return null
  return Math.round(((clockOutAt as number) - (clockInAt as number)) / 60_000)
}

// Corrections keyed by punchId. The map is supplied by the caller (which loads it
// from the correction store) so this stays pure and unit-testable.
export type CorrectionsByPunch = ReadonlyMap<string, TimeCorrection[]>

function toEntry(
  type: 'route' | 'booking', jobToken: string, jobNumber: string, date: string, a: JobAssignee,
  corrections?: CorrectionsByPunch,
): TimeEntry | null {
  const originalIn = a.clockInAt ?? null
  const originalOut = a.clockOutAt ?? null
  const pid = punchId(type, jobToken, a.staffId)
  const forPunch = corrections?.get(pid) ?? []

  // Never punched AND never corrected → not a time entry at all (an assigned-but-idle
  // crew member). A correction can legitimately CREATE payable time for a crew member
  // who forgot to punch, so a corrected entry surfaces even with no original stamps.
  if (originalIn == null && originalOut == null && forPunch.length === 0) return null

  const eff = effectivePunch({ clockInAt: originalIn, clockOutAt: originalOut }, forPunch)
  return {
    type, jobToken, jobNumber, staffId: a.staffId, staffName: a.name, date,
    clockInAt: eff.clockInAt, clockOutAt: eff.clockOutAt,
    durationMinutes: durationMinutes(eff.clockInAt, eff.clockOutAt),
    status: punchStatus(eff.clockInAt, eff.clockOutAt),
    locationDenied: !!a.clockInLocationDenied || !!a.clockOutLocationDenied,
    punchId: pid,
    corrected: eff.corrected,
    originalClockInAt: originalIn,
    originalClockOutAt: originalOut,
    ...(eff.correctionId ? { correctionId: eff.correctionId } : {}),
    ...(eff.correctedAt ? { correctedAt: eff.correctedAt } : {}),
    correctionCount: eff.correctionCount,
  }
}

function inWindow(date: string, f: TimeFilter): boolean {
  if (f.start && date < f.start) return false
  if (f.end && date > f.end) return false
  return true
}

// Project both lanes' punches into a flat, filtered, newest-first entry list. Pure:
// the caller supplies the already-loaded routes + bookings (bookings come in empty
// when BOOKING_ASSIGNMENT_ENABLED is off, so the booking lane simply contributes
// nothing).
export function selectTimeEntries(
  routes: RouteRecord[], bookings: Booking[], filter: TimeFilter = {},
  corrections?: CorrectionsByPunch,
): TimeEntry[] {
  const out: TimeEntry[] = []
  if (filter.type !== 'booking') {
    for (const r of routes) {
      if (!inWindow(r.routeDate, filter)) continue
      for (const a of r.assignees ?? []) {
        if (filter.staffId && a.staffId !== filter.staffId) continue
        const e = toEntry('route', r.token, r.routeNumber, r.routeDate, a, corrections)
        if (e) out.push(e)
      }
    }
  }
  if (filter.type !== 'route') {
    for (const b of bookings) {
      const date = effectiveServiceDate(b)
      if (!inWindow(date, filter)) continue
      for (const a of b.assignees ?? []) {
        if (filter.staffId && a.staffId !== filter.staffId) continue
        const e = toEntry('booking', b.token, b.bookingNumber, date, a, corrections)
        if (e) out.push(e)
      }
    }
  }
  return out.sort((x, y) => (y.clockInAt ?? 0) - (x.clockInAt ?? 0))
}

export type StaffRollup = {
  staffId: string
  staffName: string
  totalMinutes: number   // COMPLETE punches only
  entries: number
  openCount: number
  invalidCount: number
}

export function rollupByStaff(entries: TimeEntry[]): StaffRollup[] {
  const map = new Map<string, StaffRollup>()
  for (const e of entries) {
    let r = map.get(e.staffId)
    if (!r) { r = { staffId: e.staffId, staffName: e.staffName, totalMinutes: 0, entries: 0, openCount: 0, invalidCount: 0 }; map.set(e.staffId, r) }
    r.entries++
    if (e.status === 'complete') r.totalMinutes += e.durationMinutes ?? 0
    else if (e.status === 'open') r.openCount++
    else r.invalidCount++
  }
  return [...map.values()].sort((a, b) => b.totalMinutes - a.totalMinutes || a.staffName.localeCompare(b.staffName))
}

// Period total = COMPLETE, valid punches only. Open/invalid are surfaced to the
// owner separately and never silently counted toward payable hours.
export function periodTotalMinutes(entries: TimeEntry[]): number {
  return entries.reduce((s, e) => s + (e.status === 'complete' ? (e.durationMinutes ?? 0) : 0), 0)
}

// Presentation: minutes → "Hh Mm".
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.abs(min % 60)
  return `${h}h ${m}m`
}
