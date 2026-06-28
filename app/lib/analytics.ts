// Executive booking/revenue analytics — derived entirely from existing Booking +
// Payment records (no new data collection). Pure functions so they're trivially
// testable and can run server-side over listBookings().

import { balanceDueCents, paymentSummaryStatus, type Booking, type PaymentSummaryStatus } from './bookings'

// Bucket a timestamp into a YYYY-MM-DD calendar date in the business's timezone
// (Central). Comparing these strings lexicographically also orders them by date.
const TZ = 'America/Chicago'
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
function centralDate(ts: number): string {
  return dayFmt.format(new Date(ts))
}
function ymdToUTC(s: string): number {
  const [y, m, d] = s.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}
function addDaysStr(s: string, n: number): string {
  const d = new Date(ymdToUTC(s) + n * 86_400_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

// Best-effort city/ZIP extraction from the most relevant address on a booking.
function parseLocation(b: Booking): { city?: string; zip?: string } {
  const addr = b.jobSiteAddress || b.pickupAddress || b.dropoffAddress || ''
  const zip = (addr.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1]
  const cityMatch = addr.match(/([A-Za-z][A-Za-z .'-]{1,40}),\s*([A-Za-z]{2})\b/)
  const city = cityMatch ? `${cityMatch[1].trim()}, ${cityMatch[2].toUpperCase()}` : undefined
  return { city, zip }
}

export type NamedTotal = { key: string; amountCents: number; count: number }
export type DayPoint = { date: string; amountCents: number }

export type BookingAnalytics = {
  generatedAt: number
  revenue: {
    today: number; week: number; month: number; year: number; allTime: number
    feesAllTime: number
    series: DayPoint[]            // last 30 days, collected per day
    forecastMonth: number        // projected total collected this month
    avgDaily30: number
  }
  jobs: {
    total: number; active: number; completed: number; cancelled: number
    bookedThisMonth: number; completedThisMonth: number
  }
  averageTicketCents: number
  outstandingCents: number
  outstanding: Array<{ token: string; bookingNumber: string; customerName: string; balanceCents: number; status: string }>
  byService: NamedTotal[]
  byCity: NamedTotal[]
  byZip: NamedTotal[]
  paymentStatus: Record<PaymentSummaryStatus, number>
  disposal: { totalCents: number; actualCents: number; estimateCents: number; netAfterDisposalCents: number; actualEnteredCount: number }
  reviews?: { count: number; rating: number }
}

export function computeBookingAnalytics(
  bookings: Booking[],
  now: number,
  reviews?: { count: number; rating: number },
): BookingAnalytics {
  const todayStr = centralDate(now)
  const [ty, tm, td] = todayStr.split('-').map(Number)
  const dow = new Date(Date.UTC(ty, tm - 1, td)).getUTCDay() // 0 = Sunday
  const weekStart = addDaysStr(todayStr, -dow)
  const monthStart = `${ty}-${String(tm).padStart(2, '0')}-01`
  const yearStart = `${ty}-01-01`
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate()

  let today = 0, week = 0, month = 0, year = 0, allTime = 0, feesAllTime = 0
  const seriesStart = addDaysStr(todayStr, -29)
  const seriesMap = new Map<string, number>()

  const svc = new Map<string, NamedTotal>()
  const city = new Map<string, NamedTotal>()
  const zip = new Map<string, NamedTotal>()
  const bump = (m: Map<string, NamedTotal>, key: string, cents: number) => {
    const e = m.get(key) ?? { key, amountCents: 0, count: 0 }
    e.amountCents += cents; e.count += 1; m.set(key, e)
  }

  const paymentStatus: Record<PaymentSummaryStatus, number> = { unpaid: 0, deposit_paid: 0, partially_paid: 0, paid_in_full: 0 }
  let ticketSum = 0, ticketCount = 0, outstandingCents = 0
  const outstanding: BookingAnalytics['outstanding'] = []
  let total = 0, active = 0, completed = 0, cancelled = 0, bookedThisMonth = 0, completedThisMonth = 0
  let disposalActualCents = 0, disposalEstimateCents = 0, disposalActualEnteredCount = 0

  const loc = parseLocation
  for (const b of bookings) {
    const isCancelled = b.status === 'cancelled'
    // Job counters
    if (isCancelled) cancelled++
    else {
      total++
      if (b.status === 'completed') completed++; else active++
    }
    // Disposal cost (actual where entered, else estimate) — non-cancelled jobs.
    if (!isCancelled) {
      if (b.disposalActualCents) { disposalActualCents += b.disposalActualCents; disposalActualEnteredCount++ }
      else if (b.disposalEstimateCents) disposalEstimateCents += b.disposalEstimateCents
    }
    const createdStr = centralDate(b.createdAt)
    if (!isCancelled && createdStr >= monthStart) bookedThisMonth++
    if (b.status === 'completed' && b.completedAt && centralDate(b.completedAt) >= monthStart) completedThisMonth++

    // Average ticket + payment-status mix + A/R (non-cancelled, real invoices)
    if (!isCancelled && b.invoiceAmountCents > 0) {
      ticketSum += b.invoiceAmountCents; ticketCount++
      paymentStatus[paymentSummaryStatus(b)]++
      const bal = balanceDueCents(b)
      if (bal > 0) {
        outstandingCents += bal
        outstanding.push({ token: b.token, bookingNumber: b.bookingNumber, customerName: b.customerName, balanceCents: bal, status: b.status })
      }
    }

    // Collected revenue from confirmed payments
    const { city: cityName, zip: zipCode } = loc(b)
    for (const p of b.payments) {
      if (p.status !== 'confirmed') continue
      const cents = p.amountCents
      const when = centralDate(p.confirmedAt ?? p.createdAt)
      allTime += cents
      feesAllTime += p.feeCents || 0
      if (when === todayStr) today += cents
      if (when >= weekStart) week += cents
      if (when >= monthStart) month += cents
      if (when >= yearStart) year += cents
      if (when >= seriesStart) seriesMap.set(when, (seriesMap.get(when) ?? 0) + cents)
      bump(svc, b.serviceType, cents)
      if (cityName) bump(city, cityName, cents)
      if (zipCode) bump(zip, zipCode, cents)
    }
  }

  // Build the 30-day series (fill gaps with 0)
  const series: DayPoint[] = []
  for (let i = 0; i < 30; i++) {
    const date = addDaysStr(seriesStart, i)
    series.push({ date, amountCents: seriesMap.get(date) ?? 0 })
  }
  const sum30 = series.reduce((s, p) => s + p.amountCents, 0)
  const avgDaily30 = Math.round(sum30 / 30)
  const daysRemaining = Math.max(0, daysInMonth - td)
  const forecastMonth = month + avgDaily30 * daysRemaining

  const sortDesc = (m: Map<string, NamedTotal>) => [...m.values()].sort((a, b) => b.amountCents - a.amountCents)
  outstanding.sort((a, b) => b.balanceCents - a.balanceCents)

  return {
    generatedAt: now,
    revenue: { today, week, month, year, allTime, feesAllTime, series, forecastMonth, avgDaily30 },
    jobs: { total, active, completed, cancelled, bookedThisMonth, completedThisMonth },
    averageTicketCents: ticketCount ? Math.round(ticketSum / ticketCount) : 0,
    outstandingCents,
    outstanding: outstanding.slice(0, 12),
    byService: sortDesc(svc),
    byCity: sortDesc(city).slice(0, 8),
    byZip: sortDesc(zip).slice(0, 8),
    paymentStatus,
    disposal: {
      totalCents: disposalActualCents + disposalEstimateCents,
      actualCents: disposalActualCents,
      estimateCents: disposalEstimateCents,
      netAfterDisposalCents: allTime - (disposalActualCents + disposalEstimateCents),
      actualEnteredCount: disposalActualEnteredCount,
    },
    reviews,
  }
}
