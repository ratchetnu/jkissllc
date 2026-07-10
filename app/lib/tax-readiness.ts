import type { Staff } from './staff'

// Year-End 1099 Readiness (Part 6). A READ-ONLY assessment — we never generate a
// tax form. It answers: will this contractor need a 1099-NEC, and do we have what
// we'd need to file one? Pure; the caller supplies YTD gross earnings (from the pay
// engine) and the crew member's W-9 status.

// IRS 1099-NEC reporting threshold for nonemployee compensation.
export const THRESHOLD_1099_CENTS = 600_00

export type TaxReadiness = {
  ytdEarningsCents: number
  estimated1099Cents: number
  reachesThreshold: boolean
  w9Status: NonNullable<Staff['w9']>['status']
  missing: string[]
  ready: boolean       // true = nothing blocks a 1099 for this contractor (or none needed)
}

export function computeTaxReadiness(w9: Staff['w9'], ytdGrossCents: number): TaxReadiness {
  const reaches = ytdGrossCents >= THRESHOLD_1099_CENTS
  const status = w9?.status ?? 'not_collected'

  const missing: string[] = []
  if (status === 'not_collected') missing.push('W-9 not collected')
  if (!w9?.tinLast4) missing.push('TIN not on file')
  if (!w9?.addressComplete) missing.push('Address incomplete')

  // If they won't reach the threshold, no 1099 is needed → ready regardless.
  const ready = !reaches || (status !== 'not_collected' && !!w9?.tinLast4 && !!w9?.addressComplete)

  return {
    ytdEarningsCents: ytdGrossCents,
    estimated1099Cents: reaches ? ytdGrossCents : 0,
    reachesThreshold: reaches,
    w9Status: status,
    missing,
    ready,
  }
}

export const w9StatusLabel: Record<NonNullable<Staff['w9']>['status'], string> = {
  not_collected: 'Not collected',
  on_file: 'On file',
  verified: 'Verified',
}
