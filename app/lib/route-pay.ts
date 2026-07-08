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
import { listStaff } from './staff'
import { listClaims } from './claims'
import { deductionLinesFor, sumDeductions, applyDeductions, type PayDeductionLine } from './claim-payroll'

export type PayLineRoute = {
  routeNumber: string
  routeDate: string
  businessName: string
  amountCents: number | null   // null = payRate couldn't be parsed
  payRateRaw?: string
  hasProof: boolean
  completedBy?: 'contractor' | 'admin'
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

  const [routes, staff, claims] = await Promise.all([listRoutes(2000), listStaff(), listClaims(1000)])
  const nameOf = new Map(staff.map(s => [s.id, s.name]))
  const byStaff = new Map<string, ContractorPay>()
  let unpriced = 0, routeCount = 0

  for (const r of routes) {
    if (r.status !== 'completed') continue
    if (r.routeDate < start || r.routeDate > end) continue
    routeCount++
    const hasProof = Boolean((r.completionPhotos && r.completionPhotos.length) || r.completionNote)
    // Each crew member who didn't decline earns their OWN pay for the route.
    const crew = (r.assignees ?? []).filter(a => !a.declinedAt)
    const lines = crew.length
      ? crew.map(a => ({ id: a.staffId, name: a.name, pay: a.pay }))
      : (r.assignedStaffId ? [{ id: r.assignedStaffId, name: r.assignedStaffName || '', pay: r.payRate }] : [])
    for (const l of lines) {
      const id = l.id || 'unassigned'
      let cp = byStaff.get(id)
      if (!cp) {
        cp = {
          staffId: id, name: nameOf.get(id) || l.name || 'Unassigned', routes: [], count: 0,
          grossCents: 0, unpricedCount: 0,
          deductions: [], deductionCents: 0, appliedCents: 0, netCents: 0, shortfallCents: 0,
        }
        byStaff.set(id, cp)
      }
      const cents = parsePayCents(l.pay)
      cp.routes.push({ routeNumber: r.routeNumber, routeDate: r.routeDate, businessName: r.businessName, amountCents: cents, payRateRaw: l.pay, hasProof, completedBy: r.completedBy })
      cp.count++
      if (cents == null) { cp.unpricedCount++; unpriced++ }
      else cp.grossCents += cents
    }
  }

  // Attach posted claim deductions. A contractor with deductions but no routes this
  // period still gets a statement — otherwise the deduction would vanish from view.
  const deductions = deductionLinesFor(claims, start, end)
  for (const [staffId, lines] of deductions) {
    let cp = byStaff.get(staffId)
    if (!cp) {
      cp = {
        staffId, name: nameOf.get(staffId) || 'Unassigned', routes: [], count: 0,
        grossCents: 0, unpricedCount: 0,
        deductions: [], deductionCents: 0, appliedCents: 0, netCents: 0, shortfallCents: 0,
      }
      byStaff.set(staffId, cp)
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
  }
}
