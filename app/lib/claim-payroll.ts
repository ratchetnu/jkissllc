// Claim deductions → the pay run. Pure functions over ClaimRecord[]; lib/route-pay
// loads the records and calls these.
//
// RULE: nothing silently reduces a contractor's pay. A deduction only appears on a
// pay statement because it was POSTED to a claim's ledger on a real date, by the
// cron or by an admin. This module reads posted history — it never derives, infers,
// or recomputes a deduction. Every line names the claim, business, route, reason,
// amount, and date it came from.
import type { ClaimRecord, LedgerEntry } from './claims'

export type PayDeductionLine = {
  claimId: string
  claimNumber: string
  businessName: string
  routeNumber?: string
  reason: string
  amountCents: number    // signed: positive reduces pay, negative gives it back
  date: string           // YYYY-MM-DD (the ledger entry's period)
  kind: LedgerEntry['kind']
}

/** Only money that moves through payroll. Cash payments and waivers don't. */
const PAYROLL_KINDS: LedgerEntry['kind'][] = ['scheduled', 'adjustment']

/**
 * Every posted deduction landing in [start, end], grouped by contractor.
 * An 'adjustment' debit (money handed back) shows as a negative line, so a pay
 * statement can never hide a correction.
 */
export function deductionLinesFor(
  claims: ClaimRecord[], start: string, end: string,
): Map<string, PayDeductionLine[]> {
  const byStaff = new Map<string, PayDeductionLine[]>()

  for (const c of claims) {
    for (const a of c.assignments) {
      for (const e of a.ledger) {
        if (!PAYROLL_KINDS.includes(e.kind)) continue
        if (e.periodDate < start || e.periodDate > end) continue

        // A credit takes money off their pay; a debit is a reversal that adds it back.
        const signed = e.direction === 'credit' ? e.amountCents : -e.amountCents
        const reason = e.kind === 'scheduled'
          ? `Claim deduction — ${c.claimNumber}`
          : `Claim adjustment — ${e.note || c.claimNumber}`

        const list = byStaff.get(a.staffId) ?? []
        list.push({
          claimId: c.id, claimNumber: c.claimNumber, businessName: c.businessName,
          routeNumber: c.routeNumber, reason, amountCents: signed, date: e.periodDate, kind: e.kind,
        })
        byStaff.set(a.staffId, list)
      }
    }
  }

  for (const list of byStaff.values()) list.sort((x, y) => x.date.localeCompare(y.date))
  return byStaff
}

export const sumDeductions = (lines: PayDeductionLine[]): number =>
  lines.reduce((s, l) => s + l.amountCents, 0)

/**
 * Net pay. Deductions never push a statement negative: we withhold at most what
 * the contractor earned this period, and the shortfall stays on their claim
 * balance for next week rather than becoming a debt we've already "collected".
 */
export function applyDeductions(grossCents: number, deductionCents: number): {
  appliedCents: number; netCents: number; shortfallCents: number
} {
  const applied = Math.max(0, Math.min(deductionCents, grossCents))
  return {
    appliedCents: applied,
    netCents: grossCents - applied,
    shortfallCents: Math.max(0, deductionCents - applied),
  }
}
