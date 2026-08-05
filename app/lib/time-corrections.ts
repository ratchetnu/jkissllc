// ── Time-punch corrections — append-only, original never rewritten ───────────
//
// AUDIT FINDING THAT SHAPES THIS MODULE: there is no punch ENTITY. A punch is two
// fields (`clockInAt` / `clockOutAt`) on a route or booking ASSIGNEE. There is no
// row to version and nothing to attach a correction to. So a punch is addressed by
// a derived, stable identity — `{type}:{jobToken}:{staffId}` — and corrections live
// in their own keyspace beside the job record. Nothing here ever writes to the
// route/booking: the ORIGINAL PUNCH IS PHYSICALLY IMMUTABLE because we never touch
// the field that holds it.
//
// Reading is therefore a projection: original punch + latest active correction =
// the EFFECTIVE punch. Every payable-time consumer reads the effective value
// through lib/timesheets, so there is exactly one effective-time model.
//
// Storage follows the repo's conventions: a record key, an append-only per-punch
// index (zset by createdAt), tenant scoping via the redis chokepoint, and writes
// serialized by the shared kv-lock primitive.
import { redis } from './redis'
import { readPunchLocation, syncPunchIndex } from './timeclock/open-punch-index'
import type { Role } from './rbac'

export type WorkType = 'route' | 'booking'
export type CorrectionStatus = 'active' | 'superseded' | 'reversed'

/** A punch has no id of its own — this is its stable derived identity. */
export function punchId(workType: WorkType, jobToken: string, staffId: string): string {
  const t = String(jobToken ?? '').trim()
  const s = String(staffId ?? '').trim()
  if (workType !== 'route' && workType !== 'booking') throw new Error('punchId: workType must be route|booking')
  if (!t) throw new Error('punchId: jobToken is required')
  if (!s) throw new Error('punchId: staffId is required')
  return `${workType}:${t}:${s}`
}

export function parsePunchId(id: string): { workType: WorkType; jobToken: string; staffId: string } | null {
  const m = /^(route|booking):([^:]+):(.+)$/.exec(String(id ?? ''))
  if (!m) return null
  return { workType: m[1] as WorkType, jobToken: m[2], staffId: m[3] }
}

export type TimeCorrection = {
  correctionId: string
  tenantId?: string                 // stamped from ambient context; absent pre-tenancy
  punchId: string
  staffId: string
  workType: WorkType
  jobToken: string                  // routeId or bookingId (the job this punch belongs to)
  jobNumber?: string
  serviceDate?: string
  /** The immutable original, copied at correction time so history is self-contained. */
  originalClockIn: number | null
  originalClockOut: number | null
  /** What the effective punch was immediately BEFORE this correction. */
  previousEffectiveClockIn: number | null
  previousEffectiveClockOut: number | null
  correctedClockIn: number
  correctedClockOut: number | null   // null = legitimately still on the clock
  correctionReason: string
  correctionNote?: string
  correctedByUserId: string
  correctedByRole: Role | string
  correctedAt: number
  supersedesCorrectionId?: string
  status: CorrectionStatus
  supersededAt?: number
  reversedAt?: number
  reversedBy?: string
  auditEventId?: string
  /** Concurrency metadata: 1 for the first correction, +1 per supersede. */
  version: number
}

const KEY = (id: string) => `tcorr:${id}`
const INDEX = (pid: string) => `tcorr:punch:${pid}`      // zset: correctionId by correctedAt
export const LOCK_KEY = (pid: string) => `tcorr:lock:${pid}`

export function newCorrectionId(): string {
  return `tc_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`
}

// ── Pure validation ──────────────────────────────────────────────────────────

export type CorrectionInput = {
  correctedClockIn: unknown
  correctedClockOut: unknown
  correctionReason: unknown
  correctionNote?: unknown
}
export type ValidatedCorrection = {
  correctedClockIn: number
  correctedClockOut: number | null
  correctionReason: string
  correctionNote?: string
}
export type ValidationError = { field: string; message: string }

/** A punch longer than this is not a shift; it is a forgotten clock-out being
 *  "corrected" into payable time. Matches the timesheet's own review policy. */
export const MAX_PUNCH_MINUTES = 24 * 60

const isMs = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0

/**
 * Validate a proposed correction against the punch it targets. Pure — no store, no
 * clock — so every rule is unit-testable. Returns the normalized values or the
 * complete list of problems (never a partial write).
 */
export function validateCorrection(
  input: CorrectionInput,
  current: { effectiveClockIn: number | null; effectiveClockOut: number | null },
): { ok: true; value: ValidatedCorrection } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = []

  const reason = typeof input.correctionReason === 'string' ? input.correctionReason.trim() : ''
  if (!reason) errors.push({ field: 'correctionReason', message: 'A correction reason is required.' })
  else if (reason.length > 200) errors.push({ field: 'correctionReason', message: 'Reason must be 200 characters or fewer.' })

  const note = typeof input.correctionNote === 'string' ? input.correctionNote.trim() : ''
  if (note.length > 1000) errors.push({ field: 'correctionNote', message: 'Note must be 1000 characters or fewer.' })

  const cin = input.correctedClockIn
  if (!isMs(cin)) {
    errors.push({ field: 'correctedClockIn', message: 'A valid corrected clock-in is required.' })
  }
  const rawOut = input.correctedClockOut
  const outProvided = rawOut !== null && rawOut !== undefined && rawOut !== ''
  let cout: number | null = null
  if (outProvided) {
    if (!isMs(rawOut)) errors.push({ field: 'correctedClockOut', message: 'Clock-out is not a valid timestamp.' })
    else cout = rawOut
  }

  if (isMs(cin) && cout != null) {
    if (cout < cin) {
      errors.push({ field: 'correctedClockOut', message: 'Clock-out cannot precede clock-in.' })
    } else if (Math.round((cout - cin) / 60_000) > MAX_PUNCH_MINUTES) {
      errors.push({ field: 'correctedClockOut', message: `A punch cannot exceed ${MAX_PUNCH_MINUTES / 60} hours — review the entry instead.` })
    }
  }

  // A no-op correction is rejected: it would add history that changed nothing.
  if (isMs(cin) && errors.length === 0) {
    const sameIn = current.effectiveClockIn === cin
    const sameOut = (current.effectiveClockOut ?? null) === cout
    if (sameIn && sameOut) {
      errors.push({ field: 'correctedClockIn', message: 'This correction matches the current effective time — nothing to change.' })
    }
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    value: {
      correctedClockIn: cin as number,
      correctedClockOut: cout,
      correctionReason: reason,
      ...(note ? { correctionNote: note } : {}),
    },
  }
}

// ── Effective-time projection (pure) ─────────────────────────────────────────

export type EffectivePunch = {
  clockInAt: number | null
  clockOutAt: number | null
  corrected: boolean
  correctionId?: string
  correctedAt?: number
  correctionCount: number
}

/** The one rule: latest ACTIVE correction wins; otherwise the original punch. */
export function effectivePunch(
  original: { clockInAt: number | null; clockOutAt: number | null },
  corrections: readonly TimeCorrection[],
): EffectivePunch {
  const active = corrections
    .filter(c => c.status === 'active')
    .sort((a, b) => b.correctedAt - a.correctedAt || b.version - a.version)[0]
  if (!active) {
    return { clockInAt: original.clockInAt, clockOutAt: original.clockOutAt, corrected: false, correctionCount: corrections.length }
  }
  return {
    clockInAt: active.correctedClockIn,
    clockOutAt: active.correctedClockOut,
    corrected: true,
    correctionId: active.correctionId,
    correctedAt: active.correctedAt,
    correctionCount: corrections.length,
  }
}

// ── Storage (append-only) ────────────────────────────────────────────────────

export async function getCorrection(id: string): Promise<TimeCorrection | null> {
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as TimeCorrection } catch { return null }
}

/** Every correction for a punch, oldest first. History is never filtered here. */
export async function listCorrections(pid: string): Promise<TimeCorrection[]> {
  const ids = await redis.zrange(INDEX(pid), 0, -1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  return raws
    .map(r => { try { return r ? JSON.parse(r as string) as TimeCorrection : null } catch { return null } })
    .filter((c): c is TimeCorrection => c !== null)
}

/** Corrections for many punches in one pass — the timesheet's read path. */
export async function listCorrectionsForPunches(pids: readonly string[]): Promise<Map<string, TimeCorrection[]>> {
  const out = new Map<string, TimeCorrection[]>()
  if (!pids.length) return out
  const unique = [...new Set(pids)]
  const lists = await Promise.all(unique.map(p => listCorrections(p)))
  unique.forEach((p, i) => { if (lists[i].length) out.set(p, lists[i]) })
  return out
}

export type PunchAssignee = {
  staffId: string
  name?: string
  clockInAt?: number | null
  clockOutAt?: number | null
}

export type EffectiveOpenPunch = {
  punchId: string
  staffId: string
  name?: string
  clockInAt: number
  correctionId?: string
}

/**
 * Find assignees whose EFFECTIVE punch is open. Completion gates use this shared
 * projection so a correction cannot make Timesheets say "open" while a route or
 * booking is allowed to say "completed".
 *
 * Store failures intentionally propagate. A completion decision made without the
 * correction ledger would be a guess, and completion must fail closed on a guess.
 */
export async function listEffectiveOpenPunches(
  workType: WorkType,
  jobToken: string,
  assignees: readonly PunchAssignee[],
): Promise<EffectiveOpenPunch[]> {
  const ids = assignees.map(a => punchId(workType, jobToken, a.staffId))
  const corrections = await listCorrectionsForPunches(ids)
  const open: EffectiveOpenPunch[] = []

  assignees.forEach((assignee, index) => {
    const id = ids[index]
    const effective = effectivePunch(
      {
        clockInAt: assignee.clockInAt ?? null,
        clockOutAt: assignee.clockOutAt ?? null,
      },
      corrections.get(id) ?? [],
    )
    if (effective.clockInAt != null && effective.clockOutAt == null) {
      open.push({
        punchId: id,
        staffId: assignee.staffId,
        name: assignee.name,
        clockInAt: effective.clockInAt,
        correctionId: effective.correctionId,
      })
    }
  })

  return open
}

/** The currently active correction for a punch, if any. */
export async function activeCorrection(pid: string): Promise<TimeCorrection | null> {
  const all = await listCorrections(pid)
  const active = all.filter(c => c.status === 'active').sort((a, b) => b.correctedAt - a.correctedAt)
  return active[0] ?? null
}

async function persist(c: TimeCorrection): Promise<void> {
  await redis.set(KEY(c.correctionId), JSON.stringify(c))
  await redis.zadd(INDEX(c.punchId), c.correctedAt, c.correctionId)
}

/**
 * Append a correction, superseding the previous active one.
 *
 * ORDER: the new record is written and indexed FIRST, then the prior record is
 * marked superseded. The reverse order could leave a punch with NO active
 * correction if the second write failed — silently reverting a corrected time.
 * This order's only failure window leaves two records marked active, and
 * `effectivePunch` resolves that deterministically (latest wins), so the projection
 * is correct either way and the next successful supersede repairs the flag. The KV
 * store has no multi-key transaction; this is ordering safety, not atomicity.
 *
 * Callers MUST hold the punch lock (see LOCK_KEY) — `expectedVersion` is the
 * optimistic check that makes a stale editor fail loudly rather than clobber.
 */
export async function appendCorrection(input: {
  punchId: string
  staffId: string
  workType: WorkType
  jobToken: string
  jobNumber?: string
  serviceDate?: string
  original: { clockInAt: number | null; clockOutAt: number | null }
  value: ValidatedCorrection
  actor: { sub: string; role: Role | string }
  now: number
  expectedVersion?: number
}): Promise<{ ok: true; correction: TimeCorrection } | { ok: false; code: 'stale'; currentVersion: number }> {
  const existing = await listCorrections(input.punchId)
  const prior = existing.filter(c => c.status === 'active').sort((a, b) => b.correctedAt - a.correctedAt)[0] ?? null
  const currentVersion = prior?.version ?? 0

  // Optimistic concurrency: the editor must have been looking at the current state.
  if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
    return { ok: false, code: 'stale', currentVersion }
  }

  const previousEffective = effectivePunch(input.original, existing)
  const correction: TimeCorrection = {
    correctionId: newCorrectionId(),
    punchId: input.punchId,
    staffId: input.staffId,
    workType: input.workType,
    jobToken: input.jobToken,
    ...(input.jobNumber ? { jobNumber: input.jobNumber } : {}),
    ...(input.serviceDate ? { serviceDate: input.serviceDate } : {}),
    originalClockIn: input.original.clockInAt,
    originalClockOut: input.original.clockOutAt,
    previousEffectiveClockIn: previousEffective.clockInAt,
    previousEffectiveClockOut: previousEffective.clockOutAt,
    correctedClockIn: input.value.correctedClockIn,
    correctedClockOut: input.value.correctedClockOut,
    correctionReason: input.value.correctionReason,
    ...(input.value.correctionNote ? { correctionNote: input.value.correctionNote } : {}),
    correctedByUserId: input.actor.sub,
    correctedByRole: input.actor.role,
    correctedAt: input.now,
    ...(prior ? { supersedesCorrectionId: prior.correctionId } : {}),
    status: 'active',
    version: currentVersion + 1,
  }

  await persist(correction)
  if (prior) {
    // Append-only: the prior record is KEPT, only its status flag moves.
    await persist({ ...prior, status: 'superseded', supersededAt: input.now })
  }

  // A correction IS a change of effective open-punch state — it can close a shift
  // the raw record shows open, or reopen one the raw record shows closed — so the
  // open-punch index has to move with it. The record just appended is the active
  // one by construction (latest wins in `effectivePunch`), so its corrected times
  // ARE the new effective state and no re-read is needed.
  //
  // With no serviceDate supplied we fall back to wherever the punch is already
  // filed, so a correction can never silently relocate a punch into the undated
  // bucket — where it would block every other clock-in for that crew member. With
  // neither available the entry is left for reconciliation rather than guessed at.
  const bucket = input.serviceDate?.trim() || (await readPunchLocation(input.punchId).catch(() => null))
  if (bucket) {
    await syncPunchIndex({
      punchId: input.punchId,
      staffId: input.staffId,
      serviceDate: bucket,
      open: correction.correctedClockIn != null && correction.correctedClockOut == null,
      clockInAt: correction.correctedClockIn,
    })
  }

  return { ok: true, correction }
}

/** Stamp the audit event id onto a correction after the fact (best-effort). */
export async function attachAuditEventId(correctionId: string, auditEventId: string): Promise<void> {
  const c = await getCorrection(correctionId)
  if (!c || c.auditEventId) return
  await persist({ ...c, auditEventId })
}
