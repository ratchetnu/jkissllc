// Contractor pay / settlement — aggregate completed routes into per-contractor
// payout sheets over a pay period. Derived entirely from route history + the crew
// roster; the completion proof lives on each route already. 1099 contractors, so
// this is a payout statement, not payroll withholding.
//
// Claim deductions are subtracted here to produce NET pay. They are read from the
// posted claim ledgers (lib/claim-payroll) — never derived — so nothing can
// silently reduce a statement: every deduction line names its claim, business,
// route, reason, amount and date.
import { addDaysStr, centralToday, isDateStr, mondayOf } from './dates'
import { punchId, listCorrectionsForPunches, effectivePunch } from './time-corrections'
import {
  assignmentId, listSnapshotsForAssignments, resolveCompensation, payableForAssignment,
  detectAmbiguousAllocations, type CompensationMode, type PayrollGapReason,
} from './crew-compensation'
import { listRoutes } from './routes'
import { effectiveServiceDate, listBookings } from './bookings'
import { listStaff } from './staff'
import { listClaims } from './claims'
import { isEnabled } from './platform/flags'
import { deductionLinesFor, sumDeductions, applyDeductions, type PayDeductionLine } from './claim-payroll'

export type PayLineRoute = {
  source?: 'route' | 'booking'
  routeNumber: string
  routeDate: string
  businessName: string
  amountCents: number | null   // null = payRate couldn't be parsed
  payRateRaw?: string
  hasProof: boolean
  completedBy?: 'contractor' | 'admin'
  workedMinutes?: number
}

export type ContractorPay = {
  staffId: string
  name: string
  routes: PayLineRoute[]
  count: number
  grossCents: number           // sum of priced routes only, before deductions
  unpricedCount: number

  // ── Claim recovery ──
  deductions: PayDeductionLine[]
  deductionCents: number       // what the claims ledger says is owed this period
  appliedCents: number         // what we can actually withhold (never exceeds gross)
  netCents: number             // grossCents - appliedCents
  // Owed more than they earned this period. The remainder stays on the claim
  // balance — it is NOT collected. Surfaced so the owner sees it rather than
  // wondering why a deduction "didn't happen".
  shortfallCents: number
}

export type PaySummary = {
  start: string
  end: string
  contractors: ContractorPay[]
  grandGrossCents: number
  grandDeductionCents: number  // applied, not merely scheduled
  grandNetCents: number
  routeCount: number
  deliveryRouteCount?: number
  bookingCount?: number
  payrollGaps?: Array<{ bookingNumber: string; staffIds: string[]; reason: 'missing_service_date' }>
  bookingWindowSaturated?: boolean
  unpricedCount: number
  /**
   * Assignments whose compensation could not be resolved into a payable amount —
   * ADDITIVE and visible, never silently $0. Legacy assignments with no pay set
   * keep their existing `unpriced` treatment (they are listed here too, so the
   * reason is visible, but the payable math is byte-identical to before).
   */
  compensationGaps?: CompensationGap[]
}

export type CompensationGap = {
  assignmentId: string
  staffId: string
  staffName: string
  workType: 'route' | 'booking'
  jobNumber: string
  serviceDate: string
  reason: PayrollGapReason
  mode?: CompensationMode
}

// Pull a dollar figure out of free-text payRate: "$175/route", "175", "$1,250.00".
export function parsePayCents(pay?: string): number | null {
  if (!pay) return null
  const m = pay.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

// A pay-snapshot amount may only enter payable totals when it is a finite, non-negative
// number of cents. The routes lane already flows through parsePayCents (null or a ≥0
// rounded int), so this is byte-identical there; it hardens the bookings lane, whose
// frozen snapshot `payCents` is read directly (`a.payCents ?? …`) and — from malformed
// data — could be negative, NaN, or Infinity. `??` only guards null/undefined, so those
// would otherwise be summed straight into gross (a negative silently shrinks it; NaN/
// Infinity poisons the crew member's whole statement AND the grand totals). A rejected
// amount collapses to null → surfaced as UNPRICED (visible in the pay review, excluded
// from the issued statement), never silently folded into payable pay. Earning lines are
// never negative by design: claim recovery is a separate deduction, not a negative line.
export function payableCents(amount: number | null | undefined): number | null {
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null
}

export function fmtMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export function workedMinutes(clockInAt?: number, clockOutAt?: number): number | undefined {
  if (!clockInAt || !clockOutAt || clockOutAt <= clockInAt) return undefined
  return Math.floor((clockOutAt - clockInAt) / 60_000)
}

// ── Default period (current Mon–Sun week, Central) ────────────────────────────
// addDaysStr is re-exported: lib/dates is the definition, but callers already
// import it from here.
export { addDaysStr } from './dates'

export function defaultPayPeriod(): { start: string; end: string } {
  const start = mondayOf(centralToday())
  return { start, end: addDaysStr(start, 6) }                     // Sunday
}
const isDate = isDateStr

export async function computePay(startIn: string, endIn: string): Promise<PaySummary> {
  const start = isDate(startIn) ? startIn : defaultPayPeriod().start
  const end = isDate(endIn) ? endIn : defaultPayPeriod().end

  const includeBookings = isEnabled('BOOKING_ASSIGNMENT_ENABLED')
  const [routes, bookings, staff, claims] = await Promise.all([
    listRoutes(2000),
    includeBookings ? listBookings(2000) : Promise.resolve([]),
    listStaff(),
    listClaims(1000),
  ])
  // ── Effective models (corrections + compensation snapshots) ────────────────
  // Loaded once for every assignment in the window. With neither present this is a
  // no-op: resolveCompensation falls back to the legacy flat `payCents`, so an
  // untouched deployment computes byte-identical pay.
  const punchIds: string[] = []
  const assignmentIds: string[] = []
  for (const r of routes) for (const a of r.assignees ?? []) {
    punchIds.push(punchId('route', r.token, a.staffId)); assignmentIds.push(assignmentId('route', r.token, a.staffId))
  }
  for (const b of bookings) for (const a of b.assignees ?? []) {
    punchIds.push(punchId('booking', b.token, a.staffId)); assignmentIds.push(assignmentId('booking', b.token, a.staffId))
  }
  const [corrections, snapshots] = await Promise.all([
    listCorrectionsForPunches(punchIds),
    listSnapshotsForAssignments(assignmentIds),
  ])
  const compensationGaps: CompensationGap[] = []

  // The effective punch + payable amount for ONE assignment — the single seam every
  // lane below goes through, so hourly/flat and corrected/uncorrected are decided
  // in exactly one place.
  type Resolved = { amountCents: number | null; minutes?: number; mode?: CompensationMode; corrected: boolean }
  const resolveAssignment = (
    workType: 'route' | 'booking', jobToken: string, jobNumber: string, serviceDate: string,
    a: { staffId: string; name: string; clockInAt?: number; clockOutAt?: number; payCents?: number; paySource?: string },
    legacyCents: number | null,
    ambiguous: ReadonlySet<string>,
  ): Resolved => {
    const aid = assignmentId(workType, jobToken, a.staffId)
    const eff = effectivePunch(
      { clockInAt: a.clockInAt ?? null, clockOutAt: a.clockOutAt ?? null },
      corrections.get(punchId(workType, jobToken, a.staffId)) ?? [],
    )
    const complete = eff.clockInAt != null && eff.clockOutAt != null && eff.clockOutAt >= eff.clockInAt
    const minutes = complete ? Math.round(((eff.clockOutAt as number) - (eff.clockInAt as number)) / 60_000) : null

    const resolved = resolveCompensation(
      snapshots.get(aid),
      { payCents: legacyCents ?? undefined, paySource: a.paySource },
      { staffId: a.staffId, workType, jobToken, serviceDate },
    )
    const payable = payableForAssignment({
      compensation: resolved,
      effectiveMinutes: minutes,
      punchComplete: complete,
      ambiguousAllocation: ambiguous.has(aid),
    })
    if (!payable.ok) {
      compensationGaps.push({
        assignmentId: aid, staffId: a.staffId, staffName: a.name, workType,
        jobNumber, serviceDate, reason: payable.gap, ...(payable.mode ? { mode: payable.mode } : {}),
      })
      // Unresolved compensation stays UNPRICED (null), exactly as an unpriced crew
      // member behaves today — visible in the pay review, never paid as $0.
      return { amountCents: null, ...(minutes != null ? { minutes } : {}), mode: payable.mode, corrected: eff.corrected }
    }
    return {
      amountCents: payable.amountCents,
      // Recorded hours always reflect the EFFECTIVE punch — including for flat
      // assignments, where the correction changes attendance but not the amount.
      ...(minutes != null ? { minutes } : {}),
      mode: payable.mode,
      corrected: eff.corrected,
    }
  }

  // Overlapping hourly assignments for one crew member are never split by guess.
  const ambiguous = detectAmbiguousAllocations([
    ...routes.flatMap(r => (r.assignees ?? []).map(a => ({
      assignmentId: assignmentId('route', r.token, a.staffId), staffId: a.staffId, serviceDate: r.routeDate,
      mode: (snapshots.get(assignmentId('route', r.token, a.staffId))?.compensationMode ?? 'route_flat') as CompensationMode,
      clockInAt: a.clockInAt ?? null, clockOutAt: a.clockOutAt ?? null,
    }))),
    ...bookings.flatMap(b => (b.assignees ?? []).map(a => ({
      assignmentId: assignmentId('booking', b.token, a.staffId), staffId: a.staffId, serviceDate: effectiveServiceDate(b) ?? '',
      mode: (snapshots.get(assignmentId('booking', b.token, a.staffId))?.compensationMode ?? 'route_flat') as CompensationMode,
      clockInAt: a.clockInAt ?? null, clockOutAt: a.clockOutAt ?? null,
    }))),
  ])

  const nameOf = new Map(staff.map(s => [s.id, s.name]))
  const byStaff = new Map<string, ContractorPay>()
  let unpriced = 0, routeCount = 0, deliveryRouteCount = 0, bookingCount = 0
  const payrollGaps: NonNullable<PaySummary['payrollGaps']> = []

  const contractor = (id: string, fallbackName: string): ContractorPay => {
    let cp = byStaff.get(id)
    if (!cp) {
      cp = {
        staffId: id, name: nameOf.get(id) || fallbackName || 'Unassigned', routes: [], count: 0,
        grossCents: 0, unpricedCount: 0,
        deductions: [], deductionCents: 0, appliedCents: 0, netCents: 0, shortfallCents: 0,
      }
      byStaff.set(id, cp)
    }
    return cp
  }

  const addEarning = (input: {
    source: 'route' | 'booking'
    number: string
    date: string
    businessName: string
    staffId?: string
    staffName?: string
    amountCents: number | null
    payRateRaw?: string
    hasProof: boolean
    completedBy?: 'contractor' | 'admin'
    workedMinutes?: number
  }) => {
    const id = input.staffId || 'unassigned'
    const cp = contractor(id, input.staffName || '')
    // Guard the snapshot amount before it can reach any payable total: a negative or
    // non-finite snapshot collapses to null (unpriced) rather than silently entering gross.
    const amountCents = payableCents(input.amountCents)
    cp.routes.push({
      source: includeBookings ? input.source : undefined,
      routeNumber: input.number,
      routeDate: input.date,
      businessName: input.businessName,
      amountCents,
      payRateRaw: input.payRateRaw,
      hasProof: input.hasProof,
      completedBy: input.completedBy,
      workedMinutes: includeBookings ? input.workedMinutes : undefined,
    })
    cp.count++
    if (amountCents == null) { cp.unpricedCount++; unpriced++ }
    else cp.grossCents += amountCents
  }

  for (const r of routes) {
    if (r.status !== 'completed') continue
    if (r.routeDate < start || r.routeDate > end) continue
    routeCount++
    deliveryRouteCount++
    const hasProof = Boolean((r.completionPhotos && r.completionPhotos.length) || r.completionNote)
    // Each crew member who didn't decline earns their OWN pay for the route.
    const crew = (r.assignees ?? []).filter(a => !a.declinedAt)
    const lines = crew.length
      ? crew.map(a => ({ id: a.staffId, name: a.name, pay: a.pay, clockInAt: a.clockInAt, clockOutAt: a.clockOutAt }))
      : (r.assignedStaffId ? [{ id: r.assignedStaffId, name: r.assignedStaffName || '', pay: r.payRate, clockInAt: undefined, clockOutAt: undefined }] : [])
    for (const l of lines) {
      const legacyCents = parsePayCents(l.pay)
      const assignee = (r.assignees ?? []).find(x => x.staffId === l.id)
      const res = resolveAssignment('route', r.token, r.routeNumber, r.routeDate,
        { staffId: l.id, name: l.name, clockInAt: l.clockInAt, clockOutAt: l.clockOutAt, payCents: assignee?.payCents, paySource: assignee?.paySource },
        legacyCents, ambiguous)
      addEarning({ source: 'route', number: r.routeNumber, date: r.routeDate, businessName: r.businessName, staffId: l.id, staffName: l.name, amountCents: res.amountCents, payRateRaw: l.pay, hasProof, completedBy: r.completedBy, workedMinutes: res.minutes ?? workedMinutes(l.clockInAt, l.clockOutAt) })
    }
  }

  // Booking assignments are deliberately read only while the assignment feature
  // is enabled. Production remains byte-identical while the flag is OFF.
  for (const b of bookings) {
    if (b.archived || b.isTest) continue
    if (!b.jobCompletedAt) continue
    const crew = (b.assignees ?? []).filter(a => !a.declinedAt)
    if (!crew.length) continue
    // Owner-controlled lifecycle is the pay authorization. Operational proof is
    // necessary but cannot make cancelled/refunded/failed work payable by itself.
    if (b.status !== 'completed' && b.status !== 'partially_completed') continue
    const serviceDate = effectiveServiceDate(b)
    if (!serviceDate) {
      payrollGaps.push({ bookingNumber: b.bookingNumber, staffIds: crew.map(a => a.staffId), reason: 'missing_service_date' })
      continue
    }
    if (serviceDate < start || serviceDate > end) continue
    routeCount++
    bookingCount++
    const hasProof = Boolean(b.completionNote || b.completionPhotos?.length)
    for (const a of crew) {
      const legacyCents = a.payCents ?? parsePayCents(a.pay)
      const res = resolveAssignment('booking', b.token, b.bookingNumber, serviceDate, a, legacyCents, ambiguous)
      addEarning({
        source: 'booking',
        number: b.bookingNumber,
        date: serviceDate,
        businessName: 'Customer booking',
        staffId: a.staffId,
        staffName: a.name,
        amountCents: res.amountCents,
        payRateRaw: a.pay,
        hasProof,
        completedBy: b.jobCompletedBy === 'crew' ? 'contractor' : b.jobCompletedBy,
        workedMinutes: res.minutes ?? workedMinutes(a.clockInAt, a.clockOutAt),
      })
    }
  }

  // Attach posted claim deductions. A contractor with deductions but no routes this
  // period still gets a statement — otherwise the deduction would vanish from view.
  const deductions = deductionLinesFor(claims, start, end)
  for (const [staffId, lines] of deductions) {
    let cp = byStaff.get(staffId)
    if (!cp) {
      cp = contractor(staffId, '')
    }
    cp.deductions = lines
    cp.deductionCents = sumDeductions(lines)
  }

  let grandGross = 0, grandDeduction = 0, grandNet = 0
  for (const cp of byStaff.values()) {
    const { appliedCents, netCents, shortfallCents } = applyDeductions(cp.grossCents, cp.deductionCents)
    cp.appliedCents = appliedCents
    cp.netCents = netCents
    cp.shortfallCents = shortfallCents
    grandGross += cp.grossCents
    grandDeduction += appliedCents
    grandNet += netCents
  }

  const contractors = [...byStaff.values()].sort((a, b) => b.netCents - a.netCents || a.name.localeCompare(b.name))
  contractors.forEach(c => c.routes.sort((a, b) => a.routeDate.localeCompare(b.routeDate) || a.routeNumber.localeCompare(b.routeNumber)))
  return {
    start, end, contractors,
    grandGrossCents: grandGross, grandDeductionCents: grandDeduction, grandNetCents: grandNet,
    routeCount, unpricedCount: unpriced,
    ...(compensationGaps.length ? { compensationGaps } : {}),
    ...(includeBookings ? {
      deliveryRouteCount,
      bookingCount,
      payrollGaps,
      bookingWindowSaturated: bookings.length >= 2000,
    } : {}),
  }
}
