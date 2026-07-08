// Calendar-day helpers. Every date in the OS is a YYYY-MM-DD string in America/
// Chicago (where J KISS runs), never a Date — a route on "2026-07-09" is that day
// regardless of the server's timezone.
//
// These were copy-pasted into half a dozen modules; new code imports them here.

export const isDateStr = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Today in Central, as YYYY-MM-DD. */
export const centralToday = (now: number = Date.now()): string => dayFmt.format(new Date(now))

/** Shift a YYYY-MM-DD by n days (may be negative). Pure string→string. */
export function addDaysStr(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/** Day of week for a YYYY-MM-DD. 0 = Sunday. */
export function weekdayOf(s: string): number {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** The Monday of the week containing `day`. */
export const mondayOf = (day: string): string => addDaysStr(day, -((weekdayOf(day) + 6) % 7))

/** Whole days from `a` to `b` (b - a). Negative when b precedes a. */
export function daysBetween(a: string, b: string): number {
  const t = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  return Math.round((t(b) - t(a)) / 86_400_000)
}
