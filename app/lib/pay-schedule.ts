import { addDaysStr, centralToday, weekdayOf } from './dates'

/** Latest Friday whose weekly pay is available. Friday itself is available. */
export function payAvailableThrough(today: string = centralToday()): string {
  const daysSinceFriday = (weekdayOf(today) + 2) % 7
  return addDaysStr(today, -daysSinceFriday)
}

export function isPayPeriodAvailable(periodEnd: string, today: string = centralToday()): boolean {
  return periodEnd <= payAvailableThrough(today)
}
