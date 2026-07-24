// ── Report catalog + CSV contract ────────────────────────────────────────────
// The supported reports are defined here ONCE — id, domain, columns, source engine,
// and whether a date filter applies — so the page, the export endpoint, and the tests
// all agree. Reports are backed only by the two existing production engines
// (computeBookingAnalytics revenue + computeClaimsReport). There is deliberately NO
// company P&L report: net profit needs the `expenses` capability, which is `planned`.

import { csvCell } from '../validators'

export type ColumnKind = 'text' | 'date' | 'cents' | 'number'
export type ReportColumn = { key: string; label: string; kind: ColumnKind }
export type ReportId = 'revenue-daily' | 'claims-by-business' | 'claims-by-crew'
export type ReportRow = Record<string, string | number | null | undefined>

export type ReportDef = {
  id: ReportId
  title: string
  domain: string          // grouping for the reports surface
  source: 'revenue' | 'claims'
  dateFilterable: boolean  // whether from/to bound the rows
  dateKey?: string
  columns: ReportColumn[]
}

export const REPORT_CATALOG: ReportDef[] = [
  {
    id: 'revenue-daily', title: 'Revenue by day (last 30 days)', domain: 'Revenue', source: 'revenue',
    dateFilterable: true, dateKey: 'date',
    columns: [{ key: 'date', label: 'Date', kind: 'date' }, { key: 'amountCents', label: 'Revenue', kind: 'cents' }],
  },
  {
    id: 'claims-by-business', title: 'Claims by business', domain: 'Claims', source: 'claims', dateFilterable: false,
    columns: [
      { key: 'label', label: 'Business', kind: 'text' },
      { key: 'claimCount', label: 'Claims', kind: 'number' },
      { key: 'totalCents', label: 'Gross', kind: 'cents' },
      { key: 'recoveredCents', label: 'Recovered', kind: 'cents' },
      { key: 'outstandingCents', label: 'Outstanding', kind: 'cents' },
    ],
  },
  {
    id: 'claims-by-crew', title: 'Claims by crew', domain: 'Claims', source: 'claims', dateFilterable: false,
    columns: [
      { key: 'label', label: 'Crew', kind: 'text' },
      { key: 'claimCount', label: 'Claims', kind: 'number' },
      { key: 'totalCents', label: 'Gross', kind: 'cents' },
      { key: 'recoveredCents', label: 'Recovered', kind: 'cents' },
      { key: 'outstandingCents', label: 'Outstanding', kind: 'cents' },
    ],
  },
]

export function getReportDef(id: string): ReportDef | undefined {
  return REPORT_CATALOG.find((r) => r.id === id)
}

// Hard cap so an export can never stream an unbounded dataset. The engines already
// cap their source reads (1000 records), so this is a belt-and-suspenders guard.
export const MAX_EXPORT_ROWS = 10_000

function cell(kind: ColumnKind, v: unknown): string {
  if (kind === 'cents') return (Number(v ?? 0) / 100).toFixed(2)
  return v == null ? '' : String(v)
}

// Serialize rows to RFC-4180 CSV. Every cell goes through csvCell, which neutralizes
// spreadsheet-formula injection (=,+,-,@,tab,CR prefixes) AND escapes delimiters —
// business/crew names are user-influenced. Returns an error sentinel when oversized so
// the caller can refuse rather than stream an unbounded body.
export function toCsv(columns: ReportColumn[], rows: ReportRow[]): { csv: string; rowCount: number } | { error: 'too_large' } {
  if (rows.length > MAX_EXPORT_ROWS) return { error: 'too_large' }
  const lines = [columns.map((c) => csvCell(c.label)).join(',')]
  for (const row of rows) lines.push(columns.map((c) => csvCell(cell(c.kind, row[c.key]))).join(','))
  return { csv: lines.join('\n'), rowCount: rows.length }
}
