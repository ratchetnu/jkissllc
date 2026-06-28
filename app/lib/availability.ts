import { redis } from './redis'
import { listBookings } from './bookings'

// Booking availability: closed days (blackout), daily job capacity, and the
// online-booking deposit — all admin-configurable, stored in Redis.

const K_BLACKOUT = 'cfg:blackout'
const K_CAPACITY = 'cfg:capacity'
const K_DEPOSIT = 'cfg:deposit'
const DEFAULT_CAPACITY = 2
const DEFAULT_DEPOSIT_CENTS = 5000 // $50

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

// Bookable dates: ≥24h out, not a closed/blackout day, and under daily capacity.
export async function getAvailability(daysAhead = 60): Promise<Availability> {
  const [blackout, capacity, depositCents, bookings] = await Promise.all([
    getBlackout(), getCapacity(), getDepositCents(), listBookings(1000),
  ])
  const blackoutSet = new Set(blackout)
  const counts = new Map<string, number>()
  for (const b of bookings) {
    if (b.status === 'cancelled') continue
    const d = b.selectedDate || (b.availableDates?.length === 1 ? b.availableDates[0] : '')
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  const now = Date.now()
  const todayStr = centralDate(now)
  const minStr = centralDate(now + 24 * 60 * 60 * 1000) // at least 24h out
  const dates: string[] = []
  for (let i = 0; i <= daysAhead; i++) {
    const d = addDaysStr(todayStr, i)
    if (d < minStr) continue
    if (blackoutSet.has(d)) continue
    if ((counts.get(d) ?? 0) >= capacity) continue
    dates.push(d)
  }
  return { dates, depositCents, capacity, blackout }
}

// Is a single date bookable right now? (re-checked server-side before booking)
export async function isDateBookable(date: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const { dates } = await getAvailability(120)
  return dates.includes(date)
}
