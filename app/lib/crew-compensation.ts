// ── Flexible crew compensation — hourly or flat-per-route, per assignment ────
//
// AUDIT FINDING THAT SHAPES THIS MODULE: compensation already existed, but it was
// AMOUNT-ONLY. `finance.resolveCrewPay` resolves a per-business override → a crew
// default, and `snapshotCrewPay` freezes the result onto the assignee as
// `payCents` + `paySource`. That is a flat amount for the whole route. There was no
// notion of an hourly rate anywhere, and no way for one crew member to be hourly on
// Wednesday and flat on Monday.
//
// This module adds the MODE without disturbing what exists:
//   • an assignment carries an immutable compensation SNAPSHOT (mode + amount +
//     source + provenance + version), stored beside the job, never on it;
//   • the legacy `payCents` on an assignee is still honoured — it is read as a
//     route_flat snapshot with source `crew_default`/`crew_business`/`manual`, so
//     every existing route keeps paying exactly what it pays today;
//   • payable amount is computed from ONE effective model: flat pays once,
//     hourly multiplies the EFFECTIVE (correction-aware) punch duration.
//
// Nothing here guesses. A missing or contradictory configuration resolves to a
// payroll GAP, never to $0 — the same safe-blocking behaviour the booking lane
// already uses for a missing service date.
import { redis } from './redis'
import type { Role } from './rbac'
import type { WorkType } from './time-corrections'

export type CompensationMode = 'hourly' | 'route_flat'
export type CompensationSource = 'assignment_override' | 'business_rule' | 'crew_default'

/** Sanity ceilings. Above these, the value is a data-entry error, not a wage. */
export const MAX_HOURLY_RATE_CENTS = 100_000      // $1,000/hour
export const MAX_FLAT_ROUTE_CENTS = 1_000_000     // $10,000 for one route

export type CompensationSnapshot = {
  compensationSnapshotId: string
  tenantId?: string
  staffId: string
  workType: WorkType
  /** routeId (route lane) or bookingId (booking lane) — the assignment's job. */
  jobToken: string
  jobNumber?: string
  businessId?: string
  serviceDate: string
  compensationMode: CompensationMode
  hourlyRateCents?: number
  flatRoutePayCents?: number
  compensationSource: CompensationSource
  configuredByUserId: string
  configuredByRole: Role | string
  configuredAt: number
  effectiveAt: number
  reason?: string
  note?: string
  snapshotVersion: number
  supersedesSnapshotId?: string
  auditEventId?: string
}

/** The assignment identity a snapshot belongs to. Mirrors the punch identity. */
export function assignmentId(workType: WorkType, jobToken: string, staffId: string): string {
  const t = String(jobToken ?? '').trim()
  const s = String(staffId ?? '').trim()
  if (workType !== 'route' && workType !== 'booking') throw new Error('assignmentId: workType must be route|booking')
  if (!t) throw new Error('assignmentId: jobToken is required')
  if (!s) throw new Error('assignmentId: staffId is required')
  return `${workType}:${t}:${s}`
}

const KEY = (id: string) => `comp:${id}`
const INDEX = (aid: string) => `comp:asg:${aid}`          // zset: snapshotId by configuredAt
export const COMP_LOCK_KEY = (aid: string) => `comp:lock:${aid}`

export function newSnapshotId(): string {
  return `cs_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`
}

// ── Money validation (pure) ──────────────────────────────────────────────────

export type CompensationInput = {
  compensationMode: unknown
  hourlyRateCents?: unknown
  flatRoutePayCents?: unknown
  compensationSource?: unknown
  reason?: unknown
  note?: unknown
}
export type ValidatedCompensation = {
  compensationMode: CompensationMode
  hourlyRateCents?: number
  flatRoutePayCents?: number
  compensationSource: CompensationSource
  reason?: string
  note?: string
}
export type CompValidationError = { field: string; message: string }

const isCents = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0

/**
 * Validate a proposed compensation configuration. The mode decides which amount is
 * required; supplying BOTH is an explicit error rather than a silent ignore, because
 * ignoring one would leave the operator believing a rate they never get paid.
 */
export function validateCompensation(input: CompensationInput): { ok: true; value: ValidatedCompensation } | { ok: false; errors: CompValidationError[] } {
  const errors: CompValidationError[] = []
  const mode = input.compensationMode
  if (mode !== 'hourly' && mode !== 'route_flat') {
    return { ok: false, errors: [{ field: 'compensationMode', message: 'Pay method must be hourly or route_flat.' }] }
  }

  const hourlyGiven = input.hourlyRateCents !== undefined && input.hourlyRateCents !== null && input.hourlyRateCents !== ''
  const flatGiven = input.flatRoutePayCents !== undefined && input.flatRoutePayCents !== null && input.flatRoutePayCents !== ''

  if (hourlyGiven && flatGiven) {
    errors.push({ field: 'compensationMode', message: 'Set either an hourly rate or a flat route amount — never both.' })
  }

  let hourlyRateCents: number | undefined
  let flatRoutePayCents: number | undefined

  if (mode === 'hourly') {
    if (!hourlyGiven) errors.push({ field: 'hourlyRateCents', message: 'An hourly rate is required for hourly pay.' })
    else if (!isCents(input.hourlyRateCents)) errors.push({ field: 'hourlyRateCents', message: 'Hourly rate must be a whole number of cents, zero or more.' })
    else if (input.hourlyRateCents > MAX_HOURLY_RATE_CENTS) errors.push({ field: 'hourlyRateCents', message: `Hourly rate cannot exceed $${MAX_HOURLY_RATE_CENTS / 100}/hour.` })
    else hourlyRateCents = input.hourlyRateCents
  } else {
    if (!flatGiven) errors.push({ field: 'flatRoutePayCents', message: 'A flat route amount is required for flat pay.' })
    else if (!isCents(input.flatRoutePayCents)) errors.push({ field: 'flatRoutePayCents', message: 'Flat route amount must be a whole number of cents, zero or more.' })
    else if (input.flatRoutePayCents > MAX_FLAT_ROUTE_CENTS) errors.push({ field: 'flatRoutePayCents', message: `Flat route amount cannot exceed $${MAX_FLAT_ROUTE_CENTS / 100}.` })
    else flatRoutePayCents = input.flatRoutePayCents
  }

  const src = input.compensationSource ?? 'assignment_override'
  if (src !== 'assignment_override' && src !== 'business_rule' && src !== 'crew_default') {
    errors.push({ field: 'compensationSource', message: 'Unknown compensation source.' })
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length > 200) errors.push({ field: 'reason', message: 'Reason must be 200 characters or fewer.' })
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note.length > 1000) errors.push({ field: 'note', message: 'Note must be 1000 characters or fewer.' })

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    value: {
      compensationMode: mode,
      ...(hourlyRateCents !== undefined ? { hourlyRateCents } : {}),
      ...(flatRoutePayCents !== undefined ? { flatRoutePayCents } : {}),
      compensationSource: src as CompensationSource,
      ...(reason ? { reason } : {}),
      ...(note ? { note } : {}),
    },
  }
}

// ── Precedence + resolution (pure) ───────────────────────────────────────────

export type PayrollGapReason =
  | 'no_compensation_configured'
  | 'hourly_missing_rate'
  | 'flat_missing_amount'
  | 'hourly_punch_incomplete'
  | 'ambiguous_time_allocation'

export type ResolvedCompensation =
  | { ok: true; snapshot: CompensationSnapshot }
  | { ok: false; gap: PayrollGapReason }

/** A legacy assignee: flat `payCents` frozen by finance.snapshotCrewPay. */
export type LegacyAssignmentPay = { payCents?: number; paySource?: string }

/**
 * PRECEDENCE (explicit, never guessed):
 *   1. assignment snapshot (the immutable per-assignment record) — highest
 *   2. business rule            ┐ expressed as a snapshot whose compensationSource
 *   3. crew default             ┘ says where the amount came from
 *   4. legacy assignee payCents — read as route_flat so existing routes are unchanged
 *   5. payroll gap
 *
 * Steps 2–3 are materialized INTO a snapshot at assignment time (that is what makes
 * the assignment immutable against later default/rule changes), so at read time the
 * snapshot is authoritative and this function only decides snapshot → legacy → gap.
 */
export function resolveCompensation(
  snapshot: CompensationSnapshot | null | undefined,
  legacy: LegacyAssignmentPay | null | undefined,
  ctx: { staffId: string; workType: WorkType; jobToken: string; serviceDate: string },
): ResolvedCompensation {
  if (snapshot) {
    if (snapshot.compensationMode === 'hourly') {
      if (!isCents(snapshot.hourlyRateCents)) return { ok: false, gap: 'hourly_missing_rate' }
      return { ok: true, snapshot }
    }
    if (!isCents(snapshot.flatRoutePayCents)) return { ok: false, gap: 'flat_missing_amount' }
    return { ok: true, snapshot }
  }

  // Backward compatibility: every route that exists today has a flat payCents and
  // no snapshot. It must keep paying exactly what it pays now.
  if (legacy && isCents(legacy.payCents)) {
    const source: CompensationSource =
      legacy.paySource === 'crew_business' ? 'business_rule'
      : legacy.paySource === 'manual' ? 'assignment_override'
      : 'crew_default'
    return {
      ok: true,
      snapshot: {
        compensationSnapshotId: `legacy:${ctx.workType}:${ctx.jobToken}:${ctx.staffId}`,
        staffId: ctx.staffId,
        workType: ctx.workType,
        jobToken: ctx.jobToken,
        serviceDate: ctx.serviceDate,
        compensationMode: 'route_flat',
        flatRoutePayCents: legacy.payCents,
        compensationSource: source,
        configuredByUserId: 'legacy',
        configuredByRole: 'system',
        configuredAt: 0,
        effectiveAt: 0,
        snapshotVersion: 0,
      },
    }
  }

  return { ok: false, gap: 'no_compensation_configured' }
}

// ── Payable amount (pure) ────────────────────────────────────────────────────

export type PayableInput = {
  compensation: ResolvedCompensation
  /** EFFECTIVE (correction-aware) duration for this assignment; null = not payable. */
  effectiveMinutes: number | null
  /** True when the punch is complete + well-ordered. Open punches never pay hourly. */
  punchComplete: boolean
  /** Set when the same minutes are claimed by more than one hourly assignment. */
  ambiguousAllocation?: boolean
}

export type PayableResult =
  | { ok: true; amountCents: number; mode: CompensationMode; source: CompensationSource; rateCents?: number; minutes?: number }
  | { ok: false; gap: PayrollGapReason; mode?: CompensationMode }

/**
 * The ONE payable-amount rule for an assignment.
 *
 * route_flat — the amount, exactly once. Hours never multiply it, so a time
 *   correction changes the recorded hours and leaves the pay alone.
 * hourly     — effective payable minutes × rate. An open or invalid punch produces
 *   a GAP, never $0, so "we owe them something but don't know how much" is visible
 *   rather than silently paid as nothing.
 *
 * Rounding follows the repo's integer-cents policy: compute in cents and round
 * half-up once, at the end (Math.round), never per-minute.
 */
export function payableForAssignment(input: PayableInput): PayableResult {
  const c = input.compensation
  if (!c.ok) return { ok: false, gap: c.gap }
  const snap = c.snapshot

  if (snap.compensationMode === 'route_flat') {
    // Flat pays once for the assignment regardless of hours, punches, or corrections.
    return {
      ok: true,
      amountCents: snap.flatRoutePayCents as number,
      mode: 'route_flat',
      source: snap.compensationSource,
    }
  }

  if (input.ambiguousAllocation) return { ok: false, gap: 'ambiguous_time_allocation', mode: 'hourly' }
  if (!input.punchComplete || input.effectiveMinutes == null || input.effectiveMinutes < 0) {
    return { ok: false, gap: 'hourly_punch_incomplete', mode: 'hourly' }
  }
  const rate = snap.hourlyRateCents as number
  return {
    ok: true,
    amountCents: Math.round((input.effectiveMinutes / 60) * rate),
    mode: 'hourly',
    source: snap.compensationSource,
    rateCents: rate,
    minutes: input.effectiveMinutes,
  }
}

/**
 * Detect minutes claimed by more than one HOURLY assignment for one crew member on
 * one day. We never split a punch by guessing — the affected assignments become a
 * payroll gap until an operator resolves the allocation.
 */
export function detectAmbiguousAllocations(
  assignments: readonly { assignmentId: string; staffId: string; serviceDate: string; mode: CompensationMode; clockInAt: number | null; clockOutAt: number | null }[],
): Set<string> {
  const flagged = new Set<string>()
  const hourly = assignments.filter(a => a.mode === 'hourly' && a.clockInAt != null && a.clockOutAt != null)
  for (let i = 0; i < hourly.length; i++) {
    for (let j = i + 1; j < hourly.length; j++) {
      const a = hourly[i], b = hourly[j]
      if (a.staffId !== b.staffId) continue
      const aIn = a.clockInAt as number, aOut = a.clockOutAt as number
      const bIn = b.clockInAt as number, bOut = b.clockOutAt as number
      if (aIn < bOut && bIn < aOut) { flagged.add(a.assignmentId); flagged.add(b.assignmentId) }   // overlap
    }
  }
  return flagged
}

// ── Storage (append-only snapshots) ──────────────────────────────────────────

export async function getSnapshot(id: string): Promise<CompensationSnapshot | null> {
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as CompensationSnapshot } catch { return null }
}

/** Every snapshot for an assignment, oldest first. History is never filtered here. */
export async function listSnapshots(aid: string): Promise<CompensationSnapshot[]> {
  const ids = await redis.zrange(INDEX(aid), 0, -1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  return raws
    .map(r => { try { return r ? JSON.parse(r as string) as CompensationSnapshot : null } catch { return null } })
    .filter((s): s is CompensationSnapshot => s !== null)
}

/** The current snapshot for an assignment — the newest by version. */
export function currentSnapshot(history: readonly CompensationSnapshot[]): CompensationSnapshot | null {
  if (!history.length) return null
  return [...history].sort((a, b) => b.snapshotVersion - a.snapshotVersion || b.configuredAt - a.configuredAt)[0]
}

export async function getCurrentSnapshot(aid: string): Promise<CompensationSnapshot | null> {
  return currentSnapshot(await listSnapshots(aid))
}

/** Snapshots for many assignments in one pass — the payroll read path. */
export async function listSnapshotsForAssignments(aids: readonly string[]): Promise<Map<string, CompensationSnapshot>> {
  const out = new Map<string, CompensationSnapshot>()
  if (!aids.length) return out
  const unique = [...new Set(aids)]
  const lists = await Promise.all(unique.map(a => listSnapshots(a)))
  unique.forEach((a, i) => { const cur = currentSnapshot(lists[i]); if (cur) out.set(a, cur) })
  return out
}

async function persistSnapshot(s: CompensationSnapshot): Promise<void> {
  await redis.set(KEY(s.compensationSnapshotId), JSON.stringify(s))
  await redis.zadd(INDEX(assignmentId(s.workType, s.jobToken, s.staffId)), s.configuredAt, s.compensationSnapshotId)
}

/**
 * Append a new compensation snapshot for an assignment. Append-only: the prior
 * snapshot is KEPT and referenced by `supersedesSnapshotId`, so the terms an
 * assignment was worked under remain readable forever.
 *
 * Callers MUST hold the assignment lock (COMP_LOCK_KEY). `expectedVersion` makes a
 * stale editor fail loudly (409) instead of clobbering a newer configuration.
 */
export async function appendSnapshot(input: {
  staffId: string
  workType: WorkType
  jobToken: string
  jobNumber?: string
  businessId?: string
  serviceDate: string
  value: ValidatedCompensation
  actor: { sub: string; role: Role | string }
  now: number
  expectedVersion?: number
}): Promise<{ ok: true; snapshot: CompensationSnapshot } | { ok: false; code: 'stale'; currentVersion: number }> {
  const aid = assignmentId(input.workType, input.jobToken, input.staffId)
  const history = await listSnapshots(aid)
  const prior = currentSnapshot(history)
  const currentVersion = prior?.snapshotVersion ?? 0

  if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
    return { ok: false, code: 'stale', currentVersion }
  }

  const snapshot: CompensationSnapshot = {
    compensationSnapshotId: newSnapshotId(),
    staffId: input.staffId,
    workType: input.workType,
    jobToken: input.jobToken,
    ...(input.jobNumber ? { jobNumber: input.jobNumber } : {}),
    ...(input.businessId ? { businessId: input.businessId } : {}),
    serviceDate: input.serviceDate,
    compensationMode: input.value.compensationMode,
    ...(input.value.hourlyRateCents !== undefined ? { hourlyRateCents: input.value.hourlyRateCents } : {}),
    ...(input.value.flatRoutePayCents !== undefined ? { flatRoutePayCents: input.value.flatRoutePayCents } : {}),
    compensationSource: input.value.compensationSource,
    configuredByUserId: input.actor.sub,
    configuredByRole: input.actor.role,
    configuredAt: input.now,
    effectiveAt: input.now,
    ...(input.value.reason ? { reason: input.value.reason } : {}),
    ...(input.value.note ? { note: input.value.note } : {}),
    snapshotVersion: currentVersion + 1,
    ...(prior ? { supersedesSnapshotId: prior.compensationSnapshotId } : {}),
  }
  await persistSnapshot(snapshot)
  return { ok: true, snapshot }
}

export async function attachCompAuditEventId(snapshotId: string, auditEventId: string): Promise<void> {
  const s = await getSnapshot(snapshotId)
  if (!s || s.auditEventId) return
  await persistSnapshot({ ...s, auditEventId })
}

/** Crew-safe projection: what a crew member may see about their OWN pay. */
export function crewVisibleCompensation(s: CompensationSnapshot | null): {
  mode: CompensationMode; hourlyRateCents?: number; flatRoutePayCents?: number
} | null {
  if (!s) return null
  return {
    mode: s.compensationMode,
    ...(s.hourlyRateCents !== undefined ? { hourlyRateCents: s.hourlyRateCents } : {}),
    ...(s.flatRoutePayCents !== undefined ? { flatRoutePayCents: s.flatRoutePayCents } : {}),
  }
  // Deliberately omits reason/note/configuredBy — internal management reasoning.
}
