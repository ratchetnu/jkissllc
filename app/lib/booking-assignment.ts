// ─────────────────────────────────────────────────────────────────────────────
// Booking crew + equipment assignment — the SERVER orchestration.
//
// lib/job-assignment holds the pure shared shape and its rules. This module is the
// impure half: it reads the staff roster and the equipment roster, resolves each
// crew member's rate through lib/finance (the one definition of what someone
// earns), snapshots it, and persists the result through the booking's CAS write
// path so a concurrent writer can never be clobbered.
//
// THREE INVARIANTS THIS MODULE EXISTS TO HOLD:
//
//  1. The customer sees no change. `assignedTo` / `assignedHelper` are re-derived
//     from the crew list on every write, so the confirmation page, exports, and
//     reminder templates render exactly what they rendered before.
//
//  2. Pay is a SNAPSHOT. A rate is frozen onto the assignment when the crew member
//     is added. Re-pricing them later never rewrites work they already ran — the
//     same rule RouteFinancials and pay statements follow.
//
//  3. Off means off. Every entry point checks BOOKING_ASSIGNMENT_ENABLED first and
//     refuses with a typed reason. With the flag off nothing here can write.
//
// It sends nothing. Assignment does not text the crew, does not touch the
// customer, and does not change booking status — those are separate, explicit
// actions, exactly as they are on the Routes side.
// ─────────────────────────────────────────────────────────────────────────────

import { generateToken, updateBooking, type Booking } from './bookings'
import type { UpdateOutcome } from './booking-concurrency'
import { applyPunch, type ClockAction, type Gps, type PunchResult } from './crew-timeclock'
import { fmtCents, resolveCrewPay } from './finance'
import { getEquipment } from './equipment'
import { isEnabled } from './platform/flags'
import { getStaff } from './staff'
import {
  type JobAssignee,
  applyPaySnapshot, clearJobPay, deriveLegacyCrewNames,
  makeJobAssignee, sanitizeCompletionPhotos, validateAssignees,
} from './job-assignment'

// Why an assignment write was refused. Callers map these to HTTP + copy; they are
// never raw error strings, so the API layer can't leak internals by accident.
export type AssignmentError =
  | 'disabled'            // BOOKING_ASSIGNMENT_ENABLED is off
  | 'not_found'           // no such booking
  | 'unknown_staff'       // staffId isn't on the roster
  | 'inactive_staff'      // on the roster but deactivated
  | 'unknown_equipment'   // equipmentId isn't on the roster
  | 'duplicate_staff'     // the same person twice on one job
  | 'not_assigned'        // that crew member isn't on this job
  | 'conflict'            // CAS lost after retries — caller should retry
  | 'invalid'             // failed the shared validation rules

export type AssignmentResult =
  | { ok: true; booking: Booking }
  | { ok: false; error: AssignmentError }

// A booking's crew is never priced against a contracting business — there isn't
// one; it's a direct customer job. Passing an empty business name makes
// resolveCrewPay fall through its per-business override to the crew member's
// default rate, which is the correct policy here and keeps rate resolution in the
// single place that owns it rather than forking a second pay rule.
const NO_CONTRACT_BUSINESS = ''

const enabled = (): boolean => isEnabled('BOOKING_ASSIGNMENT_ENABLED')

// ── Add crew ─────────────────────────────────────────────────────────────────
// Put a roster crew member on a booking. Idempotent by staffId: adding someone
// already on the job is refused rather than silently duplicating their pay and
// their job link.
export async function assignCrewToBooking(
  token: string,
  staffId: string,
  opts: { role?: string; manualPayCents?: number | null; actor?: string } = {},
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }

  const staff = await getStaff(staffId)
  if (!staff) return { ok: false, error: 'unknown_staff' }
  if (staff.active === false) return { ok: false, error: 'inactive_staff' }

  // Resolve the rate BEFORE the CAS loop: it's a pure read of roster data, and the
  // mutate callback may re-run on a version conflict. Re-resolving inside would be
  // wasted work and could snapshot two different rates across retries.
  const resolved = typeof opts.manualPayCents === 'number'
    ? { cents: opts.manualPayCents, source: 'manual' as const }
    : resolveCrewPay(staff, NO_CONTRACT_BUSINESS)

  return persist(token, (b) => {
    if ((b.assignees ?? []).some(a => a.staffId === staffId)) return { abort: 'duplicate_staff' as const }

    const a = makeJobAssignee(
      { id: staff.id, name: staff.name, phone: staff.phone, role: staff.role },
      generateToken(),
      { role: opts.role },
    )
    applyPaySnapshot(a, resolved, fmtCents)
    b.assignees = [...(b.assignees ?? []), a]
    return null
  })
}

// ── Remove crew ──────────────────────────────────────────────────────────────
// Take someone off the job entirely. Their pay snapshot goes with them — an
// un-assignment is a correction, not history, and nothing downstream has billed
// against it yet (pay statements snapshot at ISSUE time, not at assign time).
export async function unassignCrewFromBooking(
  token: string,
  staffId: string,
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }

  return persist(token, (b) => {
    const before = b.assignees ?? []
    if (!before.some(a => a.staffId === staffId)) return { abort: 'not_assigned' as const }
    const after = before.filter(a => a.staffId !== staffId)
    // Empty list → drop the field, so an un-crewed booking is indistinguishable
    // from one never assigned. Leaving `[]` behind would read as "assigned to
    // nobody" everywhere downstream.
    b.assignees = after.length ? after : undefined
    return null
  })
}

// ── Re-price one crew member ─────────────────────────────────────────────────
// Override or clear a snapshot. Passing null returns them to UNPRICED (a visible
// gap the owner must fill) rather than to $0 (which reads as settled).
export async function setBookingCrewPay(
  token: string,
  staffId: string,
  cents: number | null,
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }
  if (cents !== null && (!Number.isFinite(cents) || cents < 0)) return { ok: false, error: 'invalid' }

  return persist(token, (b) => {
    const a = (b.assignees ?? []).find(x => x.staffId === staffId)
    if (!a) return { abort: 'not_assigned' as const }
    if (cents === null) clearJobPay(a)
    else applyPaySnapshot(a, { cents, source: 'manual' }, fmtCents)
    return null
  })
}

// ── Equipment ────────────────────────────────────────────────────────────────
// Link a roster asset, or record crew-supplied equipment as a bare label. Passing
// null for both clears the assignment. The display name is SNAPSHOTTED from the
// roster at link time, so renaming a truck later doesn't rewrite finished jobs.
export async function setBookingEquipment(
  token: string,
  input: { equipmentId?: string | null; vehicleLabel?: string | null },
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }

  let snapshot: string | undefined
  if (input.equipmentId) {
    const eq = await getEquipment(input.equipmentId)
    if (!eq) return { ok: false, error: 'unknown_equipment' }
    snapshot = eq.name
  }

  return persist(token, (b) => {
    if (input.equipmentId) {
      b.equipmentId = input.equipmentId
      b.vehicle = snapshot
    } else if (input.vehicleLabel?.trim()) {
      // Crew's own equipment: a label with no roster link, exactly as routes do it.
      b.equipmentId = undefined
      b.vehicle = input.vehicleLabel.trim().slice(0, 120)
    } else {
      b.equipmentId = undefined
      b.vehicle = undefined
    }
    return null
  })
}

// ── Completion proof ─────────────────────────────────────────────────────────
// On-site proof from the crew or the admin. Deliberately does NOT touch
// BookingStatus: recording arrival photos must never silently close out a job's
// money. The owner still decides when a booking is 'completed'.
export async function recordBookingCompletion(
  token: string,
  input: { note?: string; photos?: unknown; by: 'crew' | 'admin'; at?: number },
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }

  const photos = sanitizeCompletionPhotos(input.photos)
  const note = input.note?.trim().slice(0, 2000)
  const at = input.at ?? Date.now()

  return persist(token, (b) => {
    // Photos ACCUMULATE — a second upload from the field adds to the set rather
    // than replacing what the first crew member already sent.
    if (photos.length) {
      b.completionPhotos = sanitizeCompletionPhotos([...(b.completionPhotos ?? []), ...photos])
    }
    if (note) b.completionNote = note
    b.jobCompletedAt = at
    b.jobCompletedBy = input.by
    return null
  })
}

// ── Crew-side actions ────────────────────────────────────────────────────────
// These are performed BY the assigned crew member from the portal, scoped by the
// caller to their own session staffId. Each is idempotent, so a double-tap on a
// phone in a truck can never produce a second record.

// Accept the job. This is the booking analogue of confirming a route link, and it
// is what makes the assignment clockable — applyPunch refuses to start a shift on
// work nobody accepted, and that invariant is deliberately preserved rather than
// bypassed for bookings.
export async function acceptBookingAssignment(
  token: string,
  staffId: string,
  ctx: { ip?: string; at?: number } = {},
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }

  return persist(token, (b) => {
    const a = (b.assignees ?? []).find(x => x.staffId === staffId)
    if (!a) return { abort: 'not_assigned' as const }
    if (a.confirmedAt) return null            // idempotent — keep the FIRST acceptance
    a.confirmedAt = ctx.at ?? Date.now()
    a.confirmedVia = 'link'
    a.confirmIp = ctx.ip
    a.declinedAt = undefined                  // accepting supersedes an earlier decline
    a.declineReason = undefined
    return null
  })
}

// Turn the job down. Recorded, never destructive: the assignment stays on the
// booking so the owner sees WHO declined and why, exactly as a declined route
// assignee does. Declined crew are excluded from the customer-facing names, the
// crew-gap math, and (downstream) pay.
export async function declineBookingAssignment(
  token: string,
  staffId: string,
  reason?: string,
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }

  return persist(token, (b) => {
    const a = (b.assignees ?? []).find(x => x.staffId === staffId)
    if (!a) return { abort: 'not_assigned' as const }
    if (a.declinedAt) return null             // idempotent
    a.declinedAt = Date.now()
    a.declineReason = reason?.trim().slice(0, 500) || undefined
    return null
  })
}

// Punch in/out on a booking. The punch itself is lib/crew-timeclock.applyPunch —
// the SAME already-proven logic the Routes lane uses, not a second copy — so the
// idempotency, the GPS-best-effort rule, and the "confirm before you clock in"
// guard all behave identically across both lanes.
export type BookingPunch =
  | { ok: true; booking: Booking; already: boolean; denied: boolean }
  | { ok: false; error: AssignmentError | 'not_confirmed' | 'not_clocked_in' }

export async function punchBookingClock(
  token: string,
  staffId: string,
  action: ClockAction,
  gps: Gps,
): Promise<BookingPunch> {
  if (!enabled()) return { ok: false, error: 'disabled' }

  let punch: PunchResult | undefined
  const res = await persist(token, (b) => {
    const a = (b.assignees ?? []).find(x => x.staffId === staffId)
    if (!a) return { abort: 'not_assigned' as const }
    punch = applyPunch(a, action, gps, Date.now())
    return null
  })

  if (!res.ok) return { ok: false, error: res.error }
  if (!punch) return { ok: false, error: 'invalid' }
  if (!punch.ok) return { ok: false, error: punch.code }
  return { ok: true, booking: res.booking, already: punch.already, denied: punch.denied }
}

// ── Shared write path ────────────────────────────────────────────────────────
// Every mutator above funnels through here, so the legacy-name derivation and the
// validation sweep cannot be forgotten by a future caller. `mutate` returns an
// `{ abort }` sentinel to stop non-retryably, or null to proceed — matching the
// contract lib/booking-concurrency defines for a CAS mutate.
async function persist(
  token: string,
  mutate: (b: Booking) => { abort: AssignmentError } | null,
): Promise<AssignmentResult> {
  const outcome: UpdateOutcome<Booking> = await updateBooking(token, (b) => {
    const stop = mutate(b)
    if (stop) return { abort: stop.abort }

    const problems = validateAssignees(b.assignees)
    if (problems.length) return { abort: 'invalid' satisfies AssignmentError }

    // THE compatibility guarantee, applied on every single write. Re-derived from
    // the crew list rather than edited in place, so the two views can never drift.
    const legacy = deriveLegacyCrewNames(b.assignees)
    if (b.assignees?.length) {
      b.assignedTo = legacy.assignedTo
      b.assignedHelper = legacy.assignedHelper
    }
    // With no roster crew we leave the hand-typed names alone — removing the last
    // roster assignee must not erase a name the owner typed before any of this
    // existed. (`assignees` is already undefined by then, so the legacy fields are
    // once again the only record, exactly as they were.)
  })

  if (outcome.ok) return { ok: true, booking: outcome.value }
  if (outcome.reason === 'not_found') return { ok: false, error: 'not_found' }
  if (outcome.reason === 'conflict') return { ok: false, error: 'conflict' }
  // 'aborted' — the mutate's own typed reason, round-tripped through `error`.
  return { ok: false, error: (outcome.error as AssignmentError) ?? 'invalid' }
}

// ── Read helper ──────────────────────────────────────────────────────────────
// The crew a booking is actually staffed with, for the portal/pay/claims layers.
// Returns [] when the flag is off, so no downstream surface can start reading the
// new model before it's turned on.
export function bookingCrew(b: Pick<Booking, 'assignees'>): JobAssignee[] {
  if (!enabled()) return []
  return b.assignees ?? []
}
