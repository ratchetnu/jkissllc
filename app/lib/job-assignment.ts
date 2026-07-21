// ─────────────────────────────────────────────────────────────────────────────
// Job assignment — the shared crew + equipment model for OPERATIONAL WORK.
//
// WHY THIS EXISTS. Operion runs two lanes of work: contract/recurring Routes
// (lib/routes) and customer Bookings (lib/bookings). The Routes lane has a full
// operational spine — staff-linked crew, per-person pay snapshots, equipment
// linkage, per-person confirmation links, clock in/out, completion proof. The
// Bookings lane — the customer revenue line — had two free-text strings:
//
//     assignedTo?: string        // "Marcus"
//     assignedHelper?: string    // "Dre"
//
// Names typed into a box. Not linked to a staff record. So the crew portal could
// not show a moving job, no one could clock into one, completion photos had
// nowhere to go, booking work never reached a pay statement, a damage claim could
// not be filed against it, and the unified schedule's vehicle/equipment conflict
// detection was structurally blind to every customer job.
//
// This module is the shared vocabulary that closes that gap. It defines ONE
// generic crew-assignment shape that BOTH lanes satisfy, so the downstream
// systems (portal, timeclock, pay, claims, schedule) can be written once against
// `JobAssignee` instead of twice against two near-identical types.
//
// PURE + DETERMINISTIC — no Redis, no AI, no clock, no I/O. Every input arrives
// as an argument (including tokens and resolved pay rates), so this module is
// trivially testable and safe to import anywhere, including from client code.
//
// COMPATIBILITY IS A HARD REQUIREMENT. `lib/routes.Assignee` is NOT changed and
// NOT re-typed — it structurally satisfies `JobAssignee` as-is, so the shipped
// Routes lane keeps working byte-identically. On the Bookings side the legacy
// `assignedTo` / `assignedHelper` strings are DERIVED from the assignee list by
// `deriveLegacyCrewNames()`, so the customer-facing confirmation page renders
// exactly what it renders today.
//
// PAY IS NEVER RESOLVED HERE. Rate resolution belongs to lib/finance
// (`resolveCrewPay`) — the one definition of what a crew member earns. Callers
// resolve there and hand the result to `applyPaySnapshot()`. This module owns the
// SNAPSHOT semantics (the amount is frozen at assign time and re-pricing a crew
// member later never rewrites work they already ran), not the rate policy.
// ─────────────────────────────────────────────────────────────────────────────

import type { PaySource } from './finance'

// ── Crew ─────────────────────────────────────────────────────────────────────
// One crew member on one job. Mirrors lib/routes.Assignee field-for-field on the
// generic subset: identity, pay snapshot, own link token, confirmation state, and
// timeclock. Route-specific automation stamps (reminderSentAt, morningOfSentAt…)
// stay on Assignee — they are route-cron concerns, not part of the shared shape.
export type JobAssignee = {
  staffId: string
  name: string
  phone?: string
  role?: string                 // e.g. Driver / Helper — free text, from staff.role

  // Pay snapshot. Frozen at assign time; editing a rate later never rewrites this.
  // `pay` is the display/legacy mirror of `payCents` (the canonical integer cents),
  // kept in sync exactly as lib/finance.snapshotCrewPay does for routes.
  pay?: string
  payCents?: number
  paySource?: PaySource

  token: string                 // this crew member's own job link (CSPRNG, caller-supplied)

  // ── Confirmation (per person) ──
  linkOpenedAt?: number
  confirmedAt?: number
  // How it was captured. 'link' = they tapped confirm themselves. 'verbal' = the
  // owner spoke to them and recorded it. Absent on legacy records ⇒ treat as 'link'.
  confirmedVia?: 'link' | 'verbal'
  verbalNote?: string
  declinedAt?: number
  declineReason?: string
  confirmIp?: string

  // ── Timeclock (per person) ──
  // Coordinates are best-effort: a crew member may deny location permission and
  // still clock in. Absence of coords is a fact to surface, never an error.
  clockInAt?: number
  clockInLat?: number
  clockInLng?: number
  clockInAccuracy?: number
  clockInLocationDenied?: boolean
  clockOutAt?: number
  clockOutLat?: number
  clockOutLng?: number
  clockOutAccuracy?: number
  clockOutLocationDenied?: boolean
}

// ── Equipment ────────────────────────────────────────────────────────────────
// What the job rolls with. `equipmentId` links the Equipment roster (lib/equipment)
// when a specific asset was picked; `vehicle` is the snapshot display name, which
// is also how "Crew's own equipment" is represented (label, no roster id). Same
// two-field convention RouteRecord already uses, so the unified schedule reads
// both lanes with one code path.
export type JobEquipment = {
  equipmentId?: string
  vehicle?: string
}

// ── Roles ────────────────────────────────────────────────────────────────────
// Role matching is substring-based and case-insensitive, mirroring routes.crewGap:
// the roster stores free text ("Driver", "Lead Driver", "Helper / Loader"), so an
// exact-match enum would silently mis-classify real records.
export const isDriverRole = (role?: string): boolean =>
  (role || '').toLowerCase().includes('driver')

export const isHelperRole = (role?: string): boolean =>
  (role || '').toLowerCase().includes('helper')

// Crew who still count for this job. A crew member who DECLINED isn't working it
// and isn't paid for it, so they're excluded from the lead/helper derivation, the
// crew-gap check, and (via the same rule in lib/finance.payableCrew) from payout.
export const activeCrew = (assignees: readonly JobAssignee[] | undefined): JobAssignee[] =>
  (assignees ?? []).filter(a => !a.declinedAt)

// ── Legacy compatibility bridge ──────────────────────────────────────────────
// Derive the two free-text strings the Bookings lane has always carried, so every
// existing reader — the customer confirmation page, the admin list, the exports,
// the reminder templates — renders exactly what it renders today.
//
// Rules, in order:
//   • lead   = the first active DRIVER, else the first active crew member
//   • helper = the first active crew member who isn't the lead
//   • declined crew never appear (they aren't working the job)
//   • an empty crew list yields `undefined`, not '' — an unassigned booking must
//     stay indistinguishable from one that was never touched
//
// Names are trimmed and capped at 80 chars, matching the admin PATCH validator
// (`str(f.assignedTo, 80)`), so a derived value can never exceed what a typed one
// could. Only the first two crew are represented — that is the shape of the legacy
// fields, and it is exactly why they are being superseded rather than extended.
export function deriveLegacyCrewNames(
  assignees: readonly JobAssignee[] | undefined,
): { assignedTo?: string; assignedHelper?: string } {
  const crew = activeCrew(assignees).filter(a => a.name?.trim())
  if (!crew.length) return { assignedTo: undefined, assignedHelper: undefined }

  const lead = crew.find(a => isDriverRole(a.role)) ?? crew[0]
  const helper = crew.find(a => a !== lead)

  const clean = (s: string): string => s.trim().slice(0, 80)
  return {
    assignedTo: clean(lead.name),
    assignedHelper: helper ? clean(helper.name) : undefined,
  }
}

// ── Construction ─────────────────────────────────────────────────────────────
// Build a crew assignment from a roster entry. The token is caller-supplied so
// this module stays pure — callers pass lib/bookings.generateToken() (or
// lib/routes.generateToken(), the same CSPRNG 64-hex).
//
// Pay is NOT resolved here. Callers resolve via lib/finance.resolveCrewPay and
// apply the result with applyPaySnapshot(), keeping one definition of a rate.
export function makeJobAssignee(
  staff: { id: string; name: string; phone?: string; role?: string },
  token: string,
  overrides?: { role?: string },
): JobAssignee {
  return {
    staffId: staff.id,
    name: staff.name,
    phone: staff.phone,
    role: overrides?.role ?? staff.role,
    token,
  }
}

// Freeze a resolved rate onto an assignment. `resolved` comes from
// lib/finance.resolveCrewPay (rate policy) or from an explicit manual amount.
// Passing null leaves the assignment UNPRICED rather than zeroing it — an unpriced
// crew member is a visible gap the owner must fill, while $0 reads as settled.
export function applyPaySnapshot(
  a: JobAssignee,
  resolved: { cents: number; source: PaySource } | null,
  fmt: (cents: number) => string,
): void {
  if (!resolved) return
  a.payCents = resolved.cents
  a.paySource = resolved.source
  a.pay = fmt(resolved.cents)
}

// Return a crew member to "unpriced". Unlike applyPaySnapshot(null) — which
// no-ops so a failed rate lookup can't silently wipe a good snapshot — this
// unconditionally clears, so the owner can un-set a pay entered by mistake.
// Mirrors lib/finance.clearCrewPay.
export function clearJobPay(a: JobAssignee): void {
  a.payCents = undefined
  a.paySource = undefined
  a.pay = undefined
}

// ── Gaps ─────────────────────────────────────────────────────────────────────
// What this job is still missing operationally. Reported, never auto-filled —
// same contract as lib/schedule/conflicts: the owner resolves, the system tells.
//
// `crewSize` is the job's own requirement (Booking.crewSize); when it's absent we
// only assert that SOMEONE is assigned. A job needing 2+ people is treated as
// needing a driver and at least one other body, matching routes.crewGap's
// driver/helper reasoning without inventing a second policy.
export type JobCrewGap = {
  assigned: number
  required: number
  needsCrew: boolean       // nobody is on it
  needsDriver: boolean     // 2+ crew needed and none of them is a driver
  short: boolean           // fewer active crew than the job requires
  incomplete: boolean      // any of the above
}

export function jobCrewGap(
  assignees: readonly JobAssignee[] | undefined,
  crewSize?: number,
): JobCrewGap {
  const crew = activeCrew(assignees)
  const assigned = crew.length
  const required = Number.isFinite(crewSize) && (crewSize as number) > 0 ? Math.floor(crewSize as number) : 1

  const needsCrew = assigned === 0
  const needsDriver = required >= 2 && assigned > 0 && !crew.some(a => isDriverRole(a.role))
  const short = assigned < required

  return { assigned, required, needsCrew, needsDriver, short, incomplete: needsCrew || needsDriver || short }
}

// Does this job have the equipment it needs? "Crew's own equipment" counts — it is
// recorded as a `vehicle` label with no roster id, exactly as routes do it.
export const hasEquipment = (e: JobEquipment | undefined): boolean =>
  !!(e?.equipmentId || e?.vehicle?.trim())

// ── Validation ───────────────────────────────────────────────────────────────
// Guard against the two ways an assignment list goes wrong in practice: the same
// person added twice (double pay, duplicate texts, a broken portal feed), and a
// crew member with no roster link (the exact free-text problem this replaces).
export type AssignmentProblem = 'duplicate_staff' | 'missing_staff_id' | 'missing_token' | 'duplicate_token'

export function validateAssignees(assignees: readonly JobAssignee[] | undefined): AssignmentProblem[] {
  const list = assignees ?? []
  const out = new Set<AssignmentProblem>()
  const staffIds = new Set<string>()
  const tokens = new Set<string>()

  for (const a of list) {
    if (!a.staffId?.trim()) { out.add('missing_staff_id'); continue }
    if (staffIds.has(a.staffId)) out.add('duplicate_staff')
    staffIds.add(a.staffId)

    if (!a.token?.trim()) { out.add('missing_token'); continue }
    if (tokens.has(a.token)) out.add('duplicate_token')
    tokens.add(a.token)
  }
  return [...out]
}

// ── Completion ───────────────────────────────────────────────────────────────
// On-site proof, captured by the crew or recorded by an admin. Identical shape to
// RouteRecord's completion fields so one portal upload path serves both lanes.
export type JobCompletion = {
  completedAt?: number
  completedBy?: 'crew' | 'admin'
  completionNote?: string
  completionPhotos?: string[]   // Vercel Blob URLs
}

// Accept only http(s) URLs, deduped and capped — the same defensive posture as
// lib/bookings.sanitizePhotos, which this deliberately mirrors rather than
// re-invents. Blob URLs are the only thing that should ever land here.
export function sanitizeCompletionPhotos(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    if (typeof item !== 'string') continue
    const url = item.trim()
    if (!/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    out.push(url)
    if (out.length >= max) break
  }
  return out
}
