// Contractor pay / settlement — aggregate completed routes into per-contractor
// payout sheets over a pay period. Derived entirely from route history + the crew
// roster; the completion proof lives on each route already. 1099 contractors, so
// this is a payout statement, not payroll withholding.
import { listRoutes } from './routes'
import { listStaff } from './staff'

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
  totalCents: number           // sum of priced routes only
  unpricedCount: number
}

export type PaySummary = {
  start: string
  end: string
  contractors: ContractorPay[]
  grandTotalCents: number
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

// ── Date helpers + default period (current Mon–Sun week, Central) ─────────────
const centralToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
function weekdayOf(s: string): number {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
export function addDaysStr(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}
export function defaultPayPeriod(): { start: string; end: string } {
  const today = centralToday()
  const start = addDaysStr(today, -((weekdayOf(today) + 6) % 7))  // Monday
  return { start, end: addDaysStr(start, 6) }                     // Sunday
}
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)

export async function computePay(startIn: string, endIn: string): Promise<PaySummary> {
  const start = isDate(startIn) ? startIn : defaultPayPeriod().start
  const end = isDate(endIn) ? endIn : defaultPayPeriod().end

  const [routes, staff] = await Promise.all([listRoutes(2000), listStaff()])
  const nameOf = new Map(staff.map(s => [s.id, s.name]))
  const byStaff = new Map<string, ContractorPay>()
  let grand = 0, unpriced = 0, routeCount = 0

  for (const r of routes) {
    if (r.status !== 'completed') continue
    if (r.routeDate < start || r.routeDate > end) continue
    routeCount++
    const id = r.assignedStaffId || 'unassigned'
    let cp = byStaff.get(id)
    if (!cp) { cp = { staffId: id, name: nameOf.get(id) || r.assignedStaffName || 'Unassigned', routes: [], count: 0, totalCents: 0, unpricedCount: 0 }; byStaff.set(id, cp) }

    const cents = parsePayCents(r.payRate)
    cp.routes.push({
      routeNumber: r.routeNumber, routeDate: r.routeDate, businessName: r.businessName,
      amountCents: cents, payRateRaw: r.payRate,
      hasProof: Boolean((r.completionPhotos && r.completionPhotos.length) || r.completionNote),
      completedBy: r.completedBy,
    })
    cp.count++
    if (cents == null) { cp.unpricedCount++; unpriced++ }
    else { cp.totalCents += cents; grand += cents }
  }

  const contractors = [...byStaff.values()].sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name))
  contractors.forEach(c => c.routes.sort((a, b) => a.routeDate.localeCompare(b.routeDate) || a.routeNumber.localeCompare(b.routeNumber)))
  return { start, end, contractors, grandTotalCents: grand, routeCount, unpricedCount: unpriced }
}
