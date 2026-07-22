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

import { generateToken, pushBookingEvent, updateBooking, type Booking } from './bookings'
import type { UpdateOutcome } from './booking-concurrency'
import { applyPunch, type ClockAction, type Gps, type PunchResult } from './crew-timeclock'
import { fmtCents, resolveCrewPay } from './finance'
import { getEquipment } from './equipment'
import { isEnabled } from './platform/flags'
import { getStaff } from './staff'
import {
  type CompletionPhotoPolicy, type JobAssignee,
  applyPaySnapshot, clearJobPay, deriveLegacyCrewNames,
  makeJobAssignee, mergeCompletionPhotos, validateAssignees,
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
    pushBookingEvent(b, { actor: opts.actor || 'system', action: 'assignment.crew_added', result: staff.id, meta: { staffId: staff.id, role: a.role, payCents: a.payCents, paySource: a.paySource } })
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
  opts: { actor?: string } = {},
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }

  return persist(token, (b) => {
    const before = b.assignees ?? []
    if (!before.some(a => a.staffId === staffId)) return { abort: 'not_assigned' as const }
    // Keep the array even when it empties. It is the marker that this booking is
    // roster-managed, which is what tells persist() to re-derive (and therefore
    // CLEAR) the customer-facing names. Dropping the field here would make an
    // emptied booking look like one that was never assigned, stranding a derived
    // name on the customer's confirmation page.
    const removed = before.find(a => a.staffId === staffId)!
    b.assignees = before.filter(a => a.staffId !== staffId)
    pushBookingEvent(b, { actor: opts.actor || 'system', action: 'assignment.crew_removed', result: staffId, meta: { staffId, name: removed.name } })
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
  opts: { actor?: string } = {},
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }
  if (cents !== null && (!Number.isFinite(cents) || cents < 0)) return { ok: false, error: 'invalid' }

  return persist(token, (b) => {
    const a = (b.assignees ?? []).find(x => x.staffId === staffId)
    if (!a) return { abort: 'not_assigned' as const }
    const before = a.payCents
    const alreadyClear = cents === null
      && a.payCents === undefined && a.pay === undefined && a.paySource === undefined
    if (alreadyClear || (cents !== null && before === cents && a.paySource === 'manual')) return null
    if (cents === null) clearJobPay(a)
    else applyPaySnapshot(a, { cents, source: 'manual' }, fmtCents)
    pushBookingEvent(b, { actor: opts.actor || 'system', action: 'assignment.pay_changed', result: staffId, meta: { staffId, fromCents: before, toCents: cents } })
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
  opts: { actor?: string } = {},
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }

  let snapshot: string | undefined
  if (input.equipmentId) {
    const eq = await getEquipment(input.equipmentId)
    if (!eq) return { ok: false, error: 'unknown_equipment' }
    snapshot = eq.name
  }

  return persist(token, (b) => {
    const before = { equipmentId: b.equipmentId, vehicle: b.vehicle }
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
    if (before.equipmentId !== b.equipmentId || before.vehicle !== b.vehicle) {
      pushBookingEvent(b, { actor: opts.actor || 'system', action: 'assignment.equipment_changed', result: b.equipmentId || b.vehicle || 'cleared', meta: { from: before, to: { equipmentId: b.equipmentId, vehicle: b.vehicle } } })
    }
    return null
  })
}

// ── Completion proof ─────────────────────────────────────────────────────────
// The Blob store THIS deployment is bound to. Read at call time (not module load)
// so a test or a redeploy sees the current binding. When it is absent the photo
// policy still requires a Vercel Blob host — the floor is never removed, only
// narrowed to a single store when we know which store that is.
const photoPolicy = (): CompletionPhotoPolicy => ({ storeId: process.env.BLOB_STORE_ID?.trim() || undefined })

// WHO is recording the proof. A discriminated union rather than a bare
// `by: 'crew' | 'admin'` string, because the crew path REQUIRES an identity to
// authorize against and the admin path does not — making that a type error rather
// than a convention is the point. An admin reached this through
// `requirePermission(routes:manage)`; a crew member must prove they are on the job.
export type CompletionActor =
  | { by: 'crew'; staffId: string }
  | { by: 'admin'; actor?: string }

// On-site proof from the crew or the admin. Deliberately does NOT touch
// BookingStatus: recording arrival photos must never silently close out a job's
// money. The owner still decides when a booking is 'completed'.
//
// AUTHORIZATION. For the crew path this re-resolves the caller's OWN assignment on
// the freshly-loaded booking and refuses with `not_assigned` when they are not on
// it — the same rule accept/decline/punch already enforce. It was missing here,
// which meant a crew principal holding a booking token (one they had been removed
// from, or declined) could stamp completion proof on a job that was not theirs.
// The booking token is the CUSTOMER's link key and is not a crew credential.
export async function recordBookingCompletion(
  token: string,
  input: { note?: string; photos?: unknown; at?: number } & CompletionActor,
): Promise<AssignmentResult> {
  if (!enabled()) return { ok: false, error: 'disabled' }

  const policy = photoPolicy()
  const note = input.note?.trim().slice(0, 2000)
  const at = input.at ?? Date.now()

  return persist(token, (b) => {
    if (input.by === 'crew') {
      const me = (b.assignees ?? []).find(a => a.staffId === input.staffId)
      // A DECLINED crew member is not working this job, so they may not file proof
      // for it — the same exclusion activeCrew() applies everywhere else.
      if (!me || me.declinedAt) return { abort: 'not_assigned' as const }
    }

    // Photos ACCUMULATE — a second upload from the field adds to the set rather
    // than replacing what the first crew member already sent. Existing entries are
    // preserved as stored; only NEW ones must satisfy the current store policy.
    const photos = mergeCompletionPhotos(b.completionPhotos, input.photos, policy)
    if (photos.length) b.completionPhotos = photos
    if (note) b.completionNote = note
    b.jobCompletedAt = at
    b.jobCompletedBy = input.by
    pushBookingEvent(b, { actor: input.by === 'crew' ? `crew:${input.staffId}` : (input.actor || 'admin'), action: 'assignment.completion_recorded', result: input.by, meta: { photoCount: photos.length, hasNote: !!note } })
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
    pushBookingEvent(b, { actor: `crew:${staffId}`, action: 'assignment.accepted', result: staffId, meta: { staffId } })
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
    pushBookingEvent(b, { actor: `crew:${staffId}`, action: 'assignment.declined', result: staffId, meta: { staffId, reason: a.declineReason } })
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
    if (punch.ok && !punch.already) {
      pushBookingEvent(b, { actor: `crew:${staffId}`, action: `assignment.${action}`, result: staffId, meta: { staffId, locationDenied: punch.denied } })
    }
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
    //
    // The condition is `assignees !== undefined`, NOT `assignees?.length`. The
    // PRESENCE of the array — even empty — is what marks this booking as
    // roster-managed, and for a roster-managed booking the legacy names are a
    // projection, so emptying the crew must clear them too.
    //
    // Getting this wrong is a customer-visible bug, and it was: an earlier version
    // skipped the derivation when the list was empty, on the theory that it was
    // protecting a name the owner had typed by hand. But on a roster-managed
    // booking that name was DERIVED, so removing the last crew member left the
    // customer's confirmation page naming someone who was no longer on the job —
    // and left a phantom name-matched crew conflict on the schedule. Caught by the
    // Sprint 1 Preview validation; see OPERION-V1-SPRINT-1-VALIDATION.md.
    //
    // A booking that was NEVER roster-managed has `assignees === undefined`, so its
    // hand-typed names are still never touched.
    if (b.assignees !== undefined) {
      const legacy = deriveLegacyCrewNames(b.assignees)
      b.assignedTo = legacy.assignedTo
      b.assignedHelper = legacy.assignedHelper
    }
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
