import type { PayCorrection } from './pay-corrections'
import type { PayStatement } from './pay-statements'

type StatementContext = Pick<PayStatement, 'staffId' | 'statementNumber' | 'periodStart' | 'periodEnd' | 'statementSource'>
type CorrectionContext = Pick<PayCorrection, 'id' | 'staffId' | 'statementNumber' | 'periodStart' | 'periodEnd' | 'message'>

export type HistoricalReplacementSeed = {
  staffId: string
  periodStart?: string
  periodEnd?: string
  periodUnit?: 'custom'
  note: string
}

/** The time editor opens already narrowed to the approved request's crew and period. */
export function payCorrectionTimesheetHref(correction: CorrectionContext, statement?: StatementContext): string {
  const params = new URLSearchParams({ staffId: correction.staffId })
  const start = correction.periodStart ?? statement?.periodStart
  const end = correction.periodEnd ?? statement?.periodEnd
  if (start) params.set('start', start)
  if (end) params.set('end', end)
  return `/admin/operations/timesheets?${params.toString()}`
}

/** Seed a manual replacement without copying the old amount the admin is correcting. */
export function historicalReplacementSeed(correction: CorrectionContext, statement?: StatementContext): HistoricalReplacementSeed {
  return {
    staffId: correction.staffId,
    periodStart: correction.periodStart ?? statement?.periodStart,
    periodEnd: correction.periodEnd ?? statement?.periodEnd,
    ...(statement?.statementSource === 'historical_manual' ? { periodUnit: 'custom' as const } : {}),
    note: `Replacement for ${statement?.statementNumber ?? correction.statementNumber ?? 'approved pay correction'} — ${correction.message}`,
  }
}
