// ── Premium pay-statement view model (PURE) ──────────────────────────────────
// Presentation logic for the redesigned Contractor Pay Statement. It reuses the existing
// PayStatement snapshot verbatim (no recompute, no new payroll math) and only DERIVES a
// nicer shape: earnings grouped by business, the summary rows that actually have values, and
// a reconciliation check. Optional future fields (bonuses, reimbursements, YTD…) render only
// when supplied — nothing is fabricated. No React, so it's unit-testable.

import type { PayStatement, StatementLine } from './pay-statements'
import { COMPANY } from './company'

export type DisplayStatementLine = Omit<StatementLine, 'businessName'> & { businessName?: string }

export type PayStatementMeta = {
  contractorId?: string
  contractorAddress?: string
  role?: string
  classification?: string          // defaults to "Independent Contractor (1099)"
  businessName?: string
  paymentMethodLabel?: string      // label only, e.g. "Zelle" / "Direct deposit" — never account digits
  paymentDate?: string             // YYYY-MM-DD
  version?: number                 // document version (default 1)
  bonusCents?: number
  reimbursementCents?: number
  adjustmentCents?: number         // signed (may be negative)
  ytd?: { grossCents?: number; deductionCents?: number; netCents?: number; paymentsCents?: number }
}

export const DEFAULT_CLASSIFICATION = 'Independent Contractor (1099)'

const money = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
const displayDate = (iso: string) => {
  const [year, month, date] = iso.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}
const weekdayCount = (start: string, end: string) => {
  const cursor = new Date(`${start}T00:00:00Z`)
  const last = new Date(`${end}T00:00:00Z`)
  let count = 0
  while (cursor <= last) {
    const day = cursor.getUTCDay()
    if (day >= 1 && day <= 5) count += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return count
}

/** Plain-language compensation basis suitable for a formal pay statement. */
export function compensationBasis(
  line: Pick<StatementLine, 'earningKind' | 'quantity' | 'rateCents'>,
  periodStart: string,
  periodEnd: string,
): string {
  const period = `${displayDate(periodStart)}–${displayDate(periodEnd)}`
  if (line.earningKind === 'fixed') return `Fixed compensation for ${period}`

  const rate = money(line.rateCents ?? 0)
  if (line.earningKind === 'hourly') {
    return `Services compensated for ${period} · Hourly rate: ${rate}`
  }
  if (line.earningKind === 'daily') {
    const schedule = line.quantity === weekdayCount(periodStart, periodEnd)
      ? 'Monday–Friday schedule'
      : 'Paid workdays'
    return `${schedule} · ${period} · ${COMPANY.paySchedule} · Daily rate: ${rate}`
  }
  return `Compensation for ${period}`
}

/** Group earning lines by business, preserving order, with a subtotal per group. */
export function groupEarnings(lines: DisplayStatementLine[]): { businessName: string; lines: DisplayStatementLine[]; subtotalCents: number }[] {
  const order: string[] = []
  const map = new Map<string, DisplayStatementLine[]>()
  for (const l of lines) {
    const businessName = l.businessName ?? 'Earnings'
    if (!map.has(businessName)) { map.set(businessName, []); order.push(businessName) }
    map.get(businessName)!.push(l)
  }
  return order.map(businessName => {
    const groupLines = map.get(businessName)!
    return { businessName, lines: groupLines, subtotalCents: groupLines.reduce((n, l) => n + l.amountCents, 0) }
  })
}

export type SummaryRow = { key: string; label: string; cents: number; negative?: boolean; emphasis?: boolean }
type StatementAmounts = Pick<PayStatement, 'grossCents' | 'deductionCents' | 'netCents'>

/** The pay-summary rows that actually have values (optional rows omitted when absent/zero). */
export function summaryRows(s: StatementAmounts, meta: PayStatementMeta = {}): SummaryRow[] {
  const rows: SummaryRow[] = [{ key: 'gross', label: 'Gross earnings', cents: s.grossCents }]
  if (meta.bonusCents) rows.push({ key: 'bonus', label: 'Bonuses', cents: meta.bonusCents })
  if (meta.reimbursementCents) rows.push({ key: 'reimb', label: 'Reimbursements', cents: meta.reimbursementCents })
  if (meta.adjustmentCents) rows.push({ key: 'adj', label: 'Adjustments', cents: meta.adjustmentCents, negative: meta.adjustmentCents < 0 })
  if (s.deductionCents) rows.push({ key: 'ded', label: 'Deductions', cents: s.deductionCents, negative: true })
  rows.push({ key: 'net', label: 'Net payment', cents: s.netCents, emphasis: true })
  return rows
}

// ── Public authenticity view (for the /verify page) ──────────────────────────
// Confirms a statement is GENUINE without exposing sensitive pay data. Amounts and the full
// contractor name stay OFF the public page — they're on the document the contractor shares.
export type PublicStatement = {
  statementNumber: string
  business: string
  periodStart: string
  periodEnd: string
  issuedAt: number
  status: 'issued' | 'void'
  contractorInitials: string
}
export function initialsOf(name: string): string {
  return name.trim().split(/\s+/).map(p => p[0]?.toUpperCase() ?? '').join('').slice(0, 3) || '—'
}
export function publicStatement(s: PayStatement, business: string): PublicStatement {
  return { statementNumber: s.statementNumber, business, periodStart: s.periodStart, periodEnd: s.periodEnd, issuedAt: s.issuedAt, status: s.status, contractorInitials: initialsOf(s.staffName) }
}

/** Deterministic reconciliation over the snapshot — surfaces any inconsistency without altering it. */
export function reconcile(s: PayStatement, meta: PayStatementMeta = {}): { ok: boolean; issues: string[] } {
  const issues: string[] = []
  const lineSum = s.lines.reduce((n, l) => n + l.amountCents, 0)
  if (lineSum !== s.grossCents) issues.push(`gross ${s.grossCents} ≠ earning lines ${lineSum}`)
  const dedSum = s.deductions.reduce((n, d) => n + Math.abs(d.amountCents), 0)
  if (dedSum !== s.deductionCents) issues.push(`deduction total ${s.deductionCents} ≠ deduction lines ${dedSum}`)
  const extras = (meta.bonusCents ?? 0) + (meta.reimbursementCents ?? 0) + (meta.adjustmentCents ?? 0)
  const expectedNet = s.grossCents + extras - s.deductionCents
  if (expectedNet !== s.netCents) issues.push(`net ${s.netCents} ≠ gross + extras − deductions ${expectedNet}`)
  if (s.deductionCents > s.grossCents + Math.max(0, extras)) issues.push('deductions exceed available pay')
  return { ok: issues.length === 0, issues }
}
