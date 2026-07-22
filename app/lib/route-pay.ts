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
import { listRoutes } from './routes'
import { listBookings } from './bookings'
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
  unpricedCount: number
}

// Pull a dollar figure out of free-text payRate: "$175/route", "175", "$1,250.00".
export function parsePayCents(pay?: string): number | null {
  if (!pay) return null
  const m = pay.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? Math.round(n * 100) : null
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
  const nameOf = new Map(staff.map(s => [s.id, s.name]))
  const byStaff = new Map<string, ContractorPay>()
  let unpriced = 0, routeCount = 0, deliveryRouteCount = 0, bookingCount = 0

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
    cp.routes.push({
      source: input.source,
      routeNumber: input.number,
      routeDate: input.date,
      businessName: input.businessName,
      amountCents: input.amountCents,
      payRateRaw: input.payRateRaw,
      hasProof: input.hasProof,
      completedBy: input.completedBy,
      workedMinutes: input.workedMinutes,
    })
    cp.count++
    if (input.amountCents == null) { cp.unpricedCount++; unpriced++ }
    else cp.grossCents += input.amountCents
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
      const cents = parsePayCents(l.pay)
      addEarning({ source: 'route', number: r.routeNumber, date: r.routeDate, businessName: r.businessName, staffId: l.id, staffName: l.name, amountCents: cents, payRateRaw: l.pay, hasProof, completedBy: r.completedBy, workedMinutes: workedMinutes(l.clockInAt, l.clockOutAt) })
    }
  }

  // Booking assignments are deliberately read only while the assignment feature
  // is enabled. Production remains byte-identical while the flag is OFF.
  for (const b of bookings) {
    if (b.archived || b.isTest) continue
    if (!b.jobCompletedAt || !b.selectedDate) continue
    if (b.selectedDate < start || b.selectedDate > end) continue
    const crew = (b.assignees ?? []).filter(a => !a.declinedAt)
    if (!crew.length) continue
    routeCount++
    bookingCount++
    const hasProof = Boolean(b.jobCompletedAt || b.completionNote || b.completionPhotos?.length)
    for (const a of crew) {
      addEarning({
        source: 'booking',
        number: b.bookingNumber,
        date: b.selectedDate,
        businessName: b.customerName,
        staffId: a.staffId,
        staffName: a.name,
        amountCents: a.payCents ?? parsePayCents(a.pay),
        payRateRaw: a.pay,
        hasProof,
        completedBy: b.jobCompletedBy === 'crew' ? 'contractor' : b.jobCompletedBy,
        workedMinutes: workedMinutes(a.clockInAt, a.clockOutAt),
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
    routeCount, deliveryRouteCount, bookingCount, unpricedCount: unpriced,
  }
}
