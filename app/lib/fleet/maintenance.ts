// ── Fleet maintenance — PURE model + status engine ───────────────────────────
//
// Additive over lib/equipment: an OPTIONAL `maintenance` sub-object on an Equipment
// record. Legacy equipment (no maintenance field) stays valid and reads as status
// 'unknown' — nothing is backfilled. Every calculation here is pure + deterministic
// (no Redis, no ambient clock — `now` is injected) so thresholds are explicit and
// unit-tested, and derived status is kept separate from the immutable service history.

export type ServiceEventKind = 'service' | 'inspection' | 'repair' | 'note'

export type ServiceEvent = {
  id: string          // client-supplied so a replayed request is idempotent
  at: number
  kind: ServiceEventKind
  note?: string
  odometer?: number
  actor?: string      // Principal.sub — who recorded it
}

export type EquipmentMaintenance = {
  intervalDays?: number
  intervalMiles?: number
  lastServiceAt?: number
  lastOdometer?: number
  nextDueAt?: number
  nextDueMiles?: number
  inspectionDueAt?: number
  outOfService?: boolean
  outOfServiceReason?: string
  notes?: string
  history?: ServiceEvent[]
  updatedAt?: number
  updatedBy?: string
}

export type MaintenanceStatus =
  | 'current' | 'due_soon' | 'overdue' | 'inspection_required' | 'out_of_service' | 'unknown'

// Explicit, code-visible thresholds.
export const DUE_SOON_DAYS = 14
export const DUE_SOON_MILES = 500
const MAX_HISTORY = 200

// A finite, non-negative number, else undefined — guards against negative mileage /
// NaN dates flowing into the schedule.
const nonNeg = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined

// Derive the next service due-date from the last service + interval, when not set
// explicitly. Pure; returns undefined when there's nothing to derive from.
export function computeNextDueAt(m: EquipmentMaintenance): number | undefined {
  if (m.nextDueAt != null) return m.nextDueAt
  const last = nonNeg(m.lastServiceAt)
  const days = nonNeg(m.intervalDays)
  return last != null && days != null && days > 0 ? last + days * 86_400_000 : undefined
}

export function computeNextDueMiles(m: EquipmentMaintenance): number | undefined {
  if (m.nextDueMiles != null) return m.nextDueMiles
  const last = nonNeg(m.lastOdometer)
  const miles = nonNeg(m.intervalMiles)
  return last != null && miles != null && miles > 0 ? last + miles : undefined
}

// The single source of derived status. Out-of-service ALWAYS wins — equipment
// explicitly benched is never reported operational. Then overdue, then inspection,
// then due-soon, then current. No schedule data at all → 'unknown'.
export function deriveMaintenanceStatus(
  e: { maintenance?: EquipmentMaintenance }, now: number,
): MaintenanceStatus {
  const m = e.maintenance
  if (m?.outOfService) return 'out_of_service'
  if (!m) return 'unknown'

  const dueAt = computeNextDueAt(m)
  const dueMiles = computeNextDueMiles(m)
  const odo = nonNeg(m.lastOdometer)
  const inspAt = nonNeg(m.inspectionDueAt)
  if (dueAt == null && dueMiles == null && inspAt == null) return 'unknown'

  const dateOverdue = dueAt != null && dueAt <= now
  const mileOverdue = dueMiles != null && odo != null && odo >= dueMiles
  if (dateOverdue || mileOverdue) return 'overdue'

  const soonMs = DUE_SOON_DAYS * 86_400_000
  if (inspAt != null && inspAt <= now) return 'inspection_required'

  const dateSoon = dueAt != null && dueAt - now <= soonMs
  const mileSoon = dueMiles != null && odo != null && dueMiles - odo <= DUE_SOON_MILES
  const inspSoon = inspAt != null && inspAt - now <= soonMs
  if (dateSoon || mileSoon || inspSoon) return 'due_soon'

  return 'current'
}

export const isOperational = (e: { active?: boolean; maintenance?: EquipmentMaintenance }): boolean =>
  e.active !== false && !e.maintenance?.outOfService

// ── Pure mutators (return a NEW maintenance object; caller persists) ───────────

// Idempotent by event id: replaying the same service event is a no-op. Appends to
// the immutable history, advances lastServiceAt/lastOdometer, and recomputes the
// next-due targets from the (possibly new) interval baseline.
export function addServiceEvent(m: EquipmentMaintenance | undefined, ev: ServiceEvent): EquipmentMaintenance {
  const base: EquipmentMaintenance = { ...(m ?? {}) }
  const history = base.history ?? []
  if (history.some((h) => h.id === ev.id)) return base // replay → unchanged
  const odo = nonNeg(ev.odometer)
  const next: EquipmentMaintenance = {
    ...base,
    history: [...history, ev].slice(-MAX_HISTORY),
  }
  if (ev.kind === 'service' || ev.kind === 'repair') {
    next.lastServiceAt = ev.at
    if (odo != null) next.lastOdometer = odo
    next.nextDueAt = undefined   // clear explicit override so it re-derives from the new baseline
    next.nextDueMiles = undefined
  }
  if (ev.kind === 'inspection') next.inspectionDueAt = undefined
  next.updatedAt = ev.at
  next.updatedBy = ev.actor
  return next
}

export function setSchedule(
  m: EquipmentMaintenance | undefined,
  patch: { intervalDays?: number; intervalMiles?: number; inspectionDueAt?: number; notes?: string },
  actor: string, now: number,
): EquipmentMaintenance {
  const next: EquipmentMaintenance = { ...(m ?? {}) }
  if ('intervalDays' in patch) next.intervalDays = nonNeg(patch.intervalDays)
  if ('intervalMiles' in patch) next.intervalMiles = nonNeg(patch.intervalMiles)
  if ('inspectionDueAt' in patch) next.inspectionDueAt = nonNeg(patch.inspectionDueAt)
  if ('notes' in patch) next.notes = patch.notes?.slice(0, 500)
  next.updatedAt = now
  next.updatedBy = actor
  return next
}

export function setOutOfService(m: EquipmentMaintenance | undefined, reason: string | undefined, actor: string, now: number): EquipmentMaintenance {
  return { ...(m ?? {}), outOfService: true, outOfServiceReason: reason?.slice(0, 300), updatedAt: now, updatedBy: actor }
}
export function returnToService(m: EquipmentMaintenance | undefined, actor: string, now: number): EquipmentMaintenance {
  return { ...(m ?? {}), outOfService: false, outOfServiceReason: undefined, updatedAt: now, updatedBy: actor }
}

// ── Fleet-level summary + flag evaluation ─────────────────────────────────────

export type FleetSummary = Record<MaintenanceStatus, number>
export function fleetSummary(equipments: Array<{ maintenance?: EquipmentMaintenance }>, now: number): FleetSummary {
  const out: FleetSummary = { current: 0, due_soon: 0, overdue: 0, inspection_required: 0, out_of_service: 0, unknown: 0 }
  for (const e of equipments) out[deriveMaintenanceStatus(e, now)]++
  return out
}

// The maintenance.flag executor's PURE core: which equipment needs attention now.
// A flag exists for overdue / inspection-required / out-of-service items only.
export type FleetFlag = { equipmentId: string; name: string; status: MaintenanceStatus }
const FLAGGABLE: ReadonlySet<MaintenanceStatus> = new Set(['overdue', 'inspection_required', 'out_of_service'])
export function evaluateFleetFlags(equipments: Array<{ id: string; name: string; maintenance?: EquipmentMaintenance }>, now: number): FleetFlag[] {
  return equipments
    .map((e) => ({ equipmentId: e.id, name: e.name, status: deriveMaintenanceStatus(e, now) }))
    .filter((f) => FLAGGABLE.has(f.status))
}
