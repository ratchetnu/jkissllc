import { redis } from './redis'
import { listBookings, effectiveServiceDate, type Booking } from './bookings'

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

// An abandoned online deposit-hold: a self-service booking where the deposit was
// never paid, no invoice exists, a deposit was required, it isn't already
// cancelled/completed, and it was created over 2h ago. Admin/manual bookings
// (source !== 'online') and anything with a payment or invoice are excluded.
export function isAbandonedOnlineHold(b: Booking, now: number): boolean {
  return b.source === 'online'
    && b.amountPaidCents === 0
    && b.invoiceAmountCents === 0
    && (b.depositAmountCents ?? 0) > 0
    && b.status !== 'cancelled'
    && b.status !== 'completed'
    && b.status !== 'in_progress'
    && b.status !== 'continued'
    && !b.continuation
    && now - b.createdAt > TWO_HOURS_MS
}

// Booking availability: closed days (blackout), daily job capacity, and the
// online-booking deposit — all admin-configurable, stored in Redis.

const K_BLACKOUT = 'cfg:blackout'
const K_CAPACITY = 'cfg:capacity'
const K_DEPOSIT = 'cfg:deposit'
const DEFAULT_CAPACITY = 4               // work-units bookable per day
const DEFAULT_DEPOSIT_CENTS = 5000       // $50

// Load size → scheduling "work units": bigger jobs take more of the day.
const LOAD_UNITS: Record<string, number> = {
  'few-items': 1, quarter: 1, half: 2, 'three-quarter': 2, full: 3, multiple: 4,
}
export function unitsForLoad(loadSize?: string): number {
  return (loadSize && LOAD_UNITS[loadSize]) || 1
}
// Units a booking consumes on the calendar (explicit jobUnits, else 1).
function bookingUnits(b: Booking): number {
  return Math.max(1, Math.min(8, b.jobUnits ?? 1))
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
const centralDate = (ts: number) => dayFmt.format(new Date(ts))
function addDaysStr(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

export async function getBlackout(): Promise<string[]> {
  const raw = await redis.get(K_BLACKOUT)
  if (!raw) return []
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}
export async function setBlackout(dates: string[]): Promise<void> {
  const clean = [...new Set(dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort()
  await redis.set(K_BLACKOUT, JSON.stringify(clean))
}
export async function getCapacity(): Promise<number> {
  const n = parseInt(String(await redis.get(K_CAPACITY)), 10)
  return isFinite(n) && n > 0 ? n : DEFAULT_CAPACITY
}
export async function setCapacity(n: number): Promise<void> {
  await redis.set(K_CAPACITY, String(Math.max(1, Math.min(50, Math.round(n)))))
}
export async function getDepositCents(): Promise<number> {
  const n = parseInt(String(await redis.get(K_DEPOSIT)), 10)
  return isFinite(n) && n >= 0 ? n : DEFAULT_DEPOSIT_CENTS
}
export async function setDepositCents(c: number): Promise<void> {
  await redis.set(K_DEPOSIT, String(Math.max(0, Math.round(c))))
}

export type Availability = { dates: string[]; depositCents: number; capacity: number; blackout: string[] }

// Bookable dates: ≥24h out, not a closed/blackout day, and with enough remaining
// work-units for a job of `requiredUnits` size (bigger jobs need more open room).
export async function getAvailability(daysAhead = 60, requiredUnits = 1): Promise<Availability> {
  const [blackout, capacity, depositCents, bookings] = await Promise.all([
    getBlackout(), getCapacity(), getDepositCents(), listBookings(1000),
  ])
  const blackoutSet = new Set(blackout)
  const counts = new Map<string, number>()
  const now = Date.now()
  const need = Math.max(1, Math.min(capacity, Math.round(requiredUnits) || 1))
  for (const b of bookings) {
    if (b.status === 'cancelled') continue
    // An abandoned online hold shouldn't keep a slot forever — release it after 2h.
    if (isAbandonedOnlineHold(b, now)) continue
    // Count the effective date (a continued job's RETURN date blocks that slot),
    // weighted by the job's size in work-units.
    const d = effectiveServiceDate(b)
    if (d) counts.set(d, (counts.get(d) ?? 0) + bookingUnits(b))
  }
  const todayStr = centralDate(now)
  const minStr = centralDate(now + 24 * 60 * 60 * 1000) // at least 24h out
  const dates: string[] = []
  for (let i = 0; i <= daysAhead; i++) {
    const d = addDaysStr(todayStr, i)
    if (d < minStr) continue
    if (blackoutSet.has(d)) continue
    // Enough room left for this job's size?
    if ((counts.get(d) ?? 0) + need > capacity) continue
    dates.push(d)
  }
  return { dates, depositCents, capacity, blackout }
}

// Is a single date bookable right now for a job of `requiredUnits` size?
// (re-checked server-side before booking)
export async function isDateBookable(date: string, requiredUnits = 1): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const { dates } = await getAvailability(120, requiredUnits)
  return dates.includes(date)
}
