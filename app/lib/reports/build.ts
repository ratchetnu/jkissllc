// ── Pure report builders ─────────────────────────────────────────────────────
// Adapt the two existing engines' outputs into the catalog's flat row shape. Pure so
// the page + export + tests share one definition and no financial math is duplicated
// in a UI component — the engines remain the single source of the numbers.

import type { ReportRow } from './catalog'

// One YYYY-MM-DD field, else undefined (ignored). from/to bound the day-series report.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export function parseReportDate(v: string | null | undefined): string | undefined {
  return v && ISO_DATE.test(v) ? v : undefined
}

type RevenueShape = { revenue: { series: Array<{ date: string; amountCents: number }> } }
export function revenueDailyRows(analytics: RevenueShape): ReportRow[] {
  return analytics.revenue.series.map((p) => ({ date: p.date, amountCents: p.amountCents }))
}

type ClaimGroupShape = { label: string; claimCount: number; totalCents: number; recoveredCents: number; outstandingCents: number }
export function claimsGroupRows(groups: ClaimGroupShape[]): ReportRow[] {
  return groups.map((g) => ({
    label: g.label, claimCount: g.claimCount, totalCents: g.totalCents,
    recoveredCents: g.recoveredCents, outstandingCents: g.outstandingCents,
  }))
}

// Inclusive string-date window (dates are lexicographically ordered as YYYY-MM-DD).
export function filterRowsByDate(rows: ReportRow[], dateKey: string, from?: string, to?: string): ReportRow[] {
  if (!from && !to) return rows
  return rows.filter((r) => {
    const d = String(r[dateKey] ?? '')
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  })
}
