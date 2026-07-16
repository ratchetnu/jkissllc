// ── Premium pay-statement view model (PURE) ──────────────────────────────────
// Presentation logic for the redesigned Contractor Pay Statement. It reuses the existing
// PayStatement snapshot verbatim (no recompute, no new payroll math) and only DERIVES a
// nicer shape: earnings grouped by business, the summary rows that actually have values, and
// a reconciliation check. Optional future fields (bonuses, reimbursements, YTD…) render only
// when supplied — nothing is fabricated. No React, so it's unit-testable.

import type { PayStatement, StatementLine } from './pay-statements'

export type PayStatementMeta = {
  contractorId?: string
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

/** Group earning lines by business, preserving order, with a subtotal per group. */
export function groupEarnings(lines: StatementLine[]): { businessName: string; lines: StatementLine[]; subtotalCents: number }[] {
  const order: string[] = []
  const map = new Map<string, StatementLine[]>()
  for (const l of lines) {
    if (!map.has(l.businessName)) { map.set(l.businessName, []); order.push(l.businessName) }
    map.get(l.businessName)!.push(l)
  }
  return order.map(businessName => {
    const groupLines = map.get(businessName)!
    return { businessName, lines: groupLines, subtotalCents: groupLines.reduce((n, l) => n + l.amountCents, 0) }
  })
}

export type SummaryRow = { key: string; label: string; cents: number; negative?: boolean; emphasis?: boolean }

/** The pay-summary rows that actually have values (optional rows omitted when absent/zero). */
export function summaryRows(s: PayStatement, meta: PayStatementMeta = {}): SummaryRow[] {
  const rows: SummaryRow[] = [{ key: 'gross', label: 'Gross earnings', cents: s.grossCents }]
  if (meta.bonusCents) rows.push({ key: 'bonus', label: 'Bonuses', cents: meta.bonusCents })
  if (meta.reimbursementCents) rows.push({ key: 'reimb', label: 'Reimbursements', cents: meta.reimbursementCents })
  if (meta.adjustmentCents) rows.push({ key: 'adj', label: 'Adjustments', cents: meta.adjustmentCents, negative: meta.adjustmentCents < 0 })
  if (s.deductionCents) rows.push({ key: 'ded', label: 'Deductions', cents: s.deductionCents, negative: true })
  rows.push({ key: 'net', label: 'Net payment', cents: s.netCents, emphasis: true })
  return rows
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
