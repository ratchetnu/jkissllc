import { addDaysStr, centralToday, weekdayOf } from './dates'

/** Latest Friday whose weekly pay is available. Friday itself is available. */
export function payAvailableThrough(today: string = centralToday()): string {
  const daysSinceFriday = (weekdayOf(today) + 2) % 7
  return addDaysStr(today, -daysSinceFriday)
}

/** Friday on which a period ending on `periodEnd` becomes payable. */
export function scheduledPayDate(periodEnd: string): string {
  const daysUntilFriday = (5 - weekdayOf(periodEnd) + 7) % 7
  return addDaysStr(periodEnd, daysUntilFriday)
}

export function isPayPeriodAvailable(periodEnd: string, today: string = centralToday()): boolean {
  return scheduledPayDate(periodEnd) <= today
}
