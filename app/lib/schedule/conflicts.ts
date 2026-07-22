// ─────────────────────────────────────────────────────────────────────────────
// Deterministic operational conflict detection over the unified schedule.
//
// PURE + DETERMINISTIC — NO AI, no I/O, no clock. It takes the projected
// `ScheduleItem[]` (see ./unified) and returns concrete, explainable conflicts the
// owner must resolve. It NEVER auto-reschedules; it only reports.
//
// Covered (Phase 6): crew overlap, vehicle overlap, equipment overlap, unrealistic
// travel time, missing crew, missing vehicle, accepted-but-unscheduled, a scheduled
// job that isn't confirmed operational work, and duplicate canonical jobs.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScheduleItem } from './unified'
import { itemDay } from './unified'

export type ConflictType =
  | 'crew_overlap'
  | 'vehicle_overlap'
  | 'equipment_overlap'
  | 'travel_time'
  | 'missing_crew'
  | 'missing_vehicle'
  | 'accepted_not_scheduled'
  | 'unlinked_schedule'
  | 'duplicate_job'

export type ConflictSeverity = 'error' | 'warning'

export type Conflict = {
  type: ConflictType
  severity: ConflictSeverity
  message: string
  day?: string          // yyyy-mm-dd the conflict occurs on
  resource?: string     // the shared resource (crew name / vehicle / equipment)
  itemIds: string[]     // ScheduleItem.id(s) involved, sorted for stable identity
}

// Assumed minimum job footprint: two starts within this many minutes overlap in
// time. A gap beyond this but within the travel buffer is a too-tight turnaround.
const OVERLAP_WINDOW_MIN = 120
const TRAVEL_BUFFER_MIN = 60
const UNTIMED = 24 * 60

const norm = (s?: string): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

// Same physical site? Only true when BOTH addresses are present and equal — an
// unknown address can never be assumed to match (so a conflict is surfaced, not hidden).
function sameAddress(a: ScheduleItem, b: ScheduleItem): boolean {
  const na = norm(a.address), nb = norm(b.address)
  return na.length > 0 && na === nb
}

type TimeRelation = 'overlap' | 'travel' | 'clear'
function timeRelation(a: ScheduleItem, b: ScheduleItem): TimeRelation {
  // Unknown start time on either side → cannot schedule around it; treat as overlap.
  if (a.sortMinutes >= UNTIMED || b.sortMinutes >= UNTIMED) return 'overlap'
  const gap = Math.abs(a.sortMinutes - b.sortMinutes)
  if (gap < OVERLAP_WINDOW_MIN) return 'overlap'
  if (gap < OVERLAP_WINDOW_MIN + TRAVEL_BUFFER_MIN) return 'travel'
  return 'clear'
}

// Items that can hold a resource on a given day: real date, not cancelled, not
// already completed (a finished job no longer contends for a resource).
function liveScheduled(items: ScheduleItem[]): ScheduleItem[] {
  return items.filter(it => it.scheduled && !it.cancelled && !it.completed)
}

function groupByDay(items: ScheduleItem[]): Map<string, ScheduleItem[]> {
  const m = new Map<string, ScheduleItem[]>()
  for (const it of items) {
    const d = itemDay(it)
    if (!d) continue
    ;(m.get(d) ?? m.set(d, []).get(d)!).push(it)
  }
  return m
}

// Crew identity keys for an item — BOTH the roster id (routes) AND the normalized
// name, so the same person is caught across a route (staffId) and a booking
// (free-text name) when the names match.
function crewKeys(it: ScheduleItem): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  for (const c of it.crew) {
    if (c.staffId) out.push({ key: `sid:${c.staffId}`, label: c.name })
    const n = norm(c.name)
    if (n) out.push({ key: `nm:${n}`, label: c.name })
  }
  return out
}

// Generic same-resource overlap detector. `keysOf` yields (key,label) pairs for an
// item; two distinct items sharing a key on the same day are compared by time.
// `travelType` (crew only) emits a softer warning for a too-tight turnaround; for
// vehicles/equipment a later reuse is fine, so travel gaps are ignored there.
function resourceConflicts(
  byDay: Map<string, ScheduleItem[]>,
  keysOf: (it: ScheduleItem) => { key: string; label: string }[],
  overlapType: ConflictType,
  overlapNoun: string,
  travelType?: ConflictType,
): Conflict[] {
  const out: Conflict[] = []
  const seen = new Set<string>()
  for (const [day, dayItems] of byDay) {
    const buckets = new Map<string, { items: ScheduleItem[]; label: string }>()
    for (const it of dayItems) {
      for (const { key, label } of keysOf(it)) {
        const b = buckets.get(key) ?? buckets.set(key, { items: [], label }).get(key)!
        if (!b.items.includes(it)) b.items.push(it)
      }
    }
    for (const { items, label } of buckets.values()) {
      if (items.length < 2) continue
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i], b = items[j]
          if (sameAddress(a, b)) continue // same site → sequential use, not a clash
          const rel = timeRelation(a, b)
          const ids = [a.id, b.id].sort()
          if (rel === 'overlap') {
            const dedup = `${overlapType}|${day}|${label}|${ids.join(',')}`
            if (seen.has(dedup)) continue
            seen.add(dedup)
            out.push({
              type: overlapType, severity: 'error', day, resource: label,
              message: `${overlapNoun} "${label}" is double-booked on ${day} (${a.number} and ${b.number} overlap in time).`,
              itemIds: ids,
            })
          } else if (rel === 'travel' && travelType) {
            const dedup = `${travelType}|${day}|${label}|${ids.join(',')}`
            if (seen.has(dedup)) continue
            seen.add(dedup)
            out.push({
              type: travelType, severity: 'warning', day, resource: label,
              message: `${overlapNoun} "${label}" has a tight turnaround on ${day} between ${a.number} and ${b.number} at different addresses.`,
              itemIds: ids,
            })
          }
        }
      }
    }
  }
  return out
}

// ── Public API ───────────────────────────────────────────────────────────────
export function detectConflicts(items: ScheduleItem[]): Conflict[] {
  const out: Conflict[] = []
  const live = liveScheduled(items)
  const byDay = groupByDay(live)

  // Resource overlaps (crew / vehicle / equipment) + tight crew turnaround.
  out.push(...resourceConflicts(byDay, crewKeys, 'crew_overlap', 'Crew', 'travel_time'))
  out.push(...resourceConflicts(
    byDay,
    it => it.vehicle ? [{ key: `veh:${norm(it.vehicle)}`, label: it.vehicle }] : [],
    'vehicle_overlap', 'Vehicle',
  ))
  out.push(...resourceConflicts(
    byDay,
    it => it.equipmentId ? [{ key: `eq:${it.equipmentId}`, label: it.equipment[0] || it.equipmentId }] : [],
    'equipment_overlap', 'Equipment',
  ))

  // Per-item structural gaps.
  for (const it of items) {
    if (it.cancelled || it.completed) continue

    // Committed work with no crew assigned.
    if (it.lane === 'confirmed' && it.scheduled && !it.crewComplete) {
      out.push({
        type: 'missing_crew', severity: 'warning', day: it.date, resource: it.number,
        message: `${it.number} (${it.title}) is confirmed for ${it.date} with no crew assigned.`,
        itemIds: [it.id],
      })
    }

    // Confirmed work for a day with no vehicle/equipment picked. Routes always
    // qualify. A booking qualifies only once it is ROSTER-staffed (some crew member
    // carries a staffId) — that is what says the job is being run under the
    // assignment model and therefore has an equipment answer to give. Bookings
    // still crewed by hand-typed names are left alone, so turning this on adds no
    // warnings to work that predates the model.
    const equippable = it.kind === 'route' || it.crew.some(c => c.staffId)
    if (equippable && it.lane === 'confirmed' && it.scheduled && !it.vehicle && !it.equipmentId) {
      out.push({
        type: 'missing_vehicle', severity: 'warning', day: it.date, resource: it.number,
        message: `${it.number} (${it.title}) is confirmed for ${it.date} with no vehicle or equipment.`,
        itemIds: [it.id],
      })
    }

    // Accepted / paid / confirmed intent but no real service date.
    if (it.kind === 'booking' && !it.scheduled &&
        (it.status === 'payment_received' || it.status === 'confirmed' || it.status === 'time_verified')) {
      out.push({
        type: 'accepted_not_scheduled', severity: 'error', resource: it.number,
        message: `${it.number} (${it.title}) is accepted/paid but has no scheduled date.`,
        itemIds: [it.id],
      })
    }

    // A hard date on the calendar that isn't confirmed operational work yet.
    if (it.scheduled && it.lane === 'pending') {
      out.push({
        type: 'unlinked_schedule', severity: 'warning', day: it.date, resource: it.number,
        message: `${it.number} (${it.title}) has a service date (${it.date}) but is not confirmed work yet (${it.statusLabel}).`,
        itemIds: [it.id],
      })
    }
  }

  // Duplicate canonical jobs — same kind + customer/business + day + service.
  const dupKey = (it: ScheduleItem) => `${it.kind}|${norm(it.title)}|${itemDay(it)}|${norm(it.serviceLabel)}`
  const groups = new Map<string, ScheduleItem[]>()
  for (const it of items) {
    if (it.cancelled) continue
    if (!itemDay(it)) continue
    ;(groups.get(dupKey(it)) ?? groups.set(dupKey(it), []).get(dupKey(it))!).push(it)
  }
  for (const [, g] of groups) {
    const distinct = Array.from(new Map(g.map(it => [it.sourceRecordId, it])).values())
    if (distinct.length < 2) continue
    out.push({
      type: 'duplicate_job', severity: 'warning', day: itemDay(distinct[0]), resource: distinct[0].title,
      message: `Possible duplicate: ${distinct.length} ${distinct[0].serviceLabel} jobs for "${distinct[0].title}" on ${itemDay(distinct[0])} (${distinct.map(d => d.number).join(', ')}).`,
      itemIds: distinct.map(d => d.id).sort(),
    })
  }

  return out
}

// Attach the conflicts that reference each item back onto a lookup by item id —
// lets the schedule UI badge an individual row without re-scanning.
export function conflictsByItem(conflicts: Conflict[]): Map<string, Conflict[]> {
  const m = new Map<string, Conflict[]>()
  for (const c of conflicts) {
    for (const id of c.itemIds) {
      ;(m.get(id) ?? m.set(id, []).get(id)!).push(c)
    }
  }
  return m
}

export type ConflictSummary = { total: number; errors: number; warnings: number; byType: Record<string, number> }
export function summarizeConflicts(conflicts: Conflict[]): ConflictSummary {
  const byType: Record<string, number> = {}
  for (const c of conflicts) byType[c.type] = (byType[c.type] ?? 0) + 1
  return {
    total: conflicts.length,
    errors: conflicts.filter(c => c.severity === 'error').length,
    warnings: conflicts.filter(c => c.severity === 'warning').length,
    byType,
  }
}
