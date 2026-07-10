import { redis } from './redis'
import { mondayOf, weekdayOf, addDaysStr, isDateStr } from './dates'

// Weekly crew availability (Part 7). Distinct from lib/availability.ts, which is
// the PUBLIC BOOKING calendar (blackout dates / capacity). This is per-crew,
// per-week Mon–Sun availability the crew submit themselves and managers consult
// while scheduling. Availability never guarantees work — it's an input, not a
// promise (the UI says so).

export const DOW_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type DowKey = (typeof DOW_KEYS)[number]

// weekdayOf: 0=Sun..6=Sat. Map to our Mon-first keys.
const WEEKDAY_TO_KEY: Record<number, DowKey> = { 0: 'sun', 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat' }

export type DayAvailability = {
  available: boolean
  start?: string // "HH:MM" 24h, only meaningful when available
  end?: string
}

export type WeekAvailability = {
  staffId: string
  weekStart: string // Monday YYYY-MM-DD
  days: Record<DowKey, DayAvailability>
  status: 'draft' | 'submitted'
  submittedAt?: number
  createdAt: number
  updatedAt: number
}

const KEY = (staffId: string, weekStart: string) => `crewavail:${staffId}:${weekStart}`
const INDEX = (staffId: string) => `crewavail:idx:${staffId}`
const scoreOf = (weekStart: string) => Number(weekStart.replace(/-/g, ''))

const DEFAULT_START = '08:00'
const DEFAULT_END = '17:00'

export function emptyDays(): Record<DowKey, DayAvailability> {
  return DOW_KEYS.reduce((acc, k) => { acc[k] = { available: false }; return acc }, {} as Record<DowKey, DayAvailability>)
}

// Normalize a submitted days object: coerce to booleans, keep times only when
// available, and fill sensible defaults so a day marked available always has a
// window. Rejects an end that isn't after start (falls back to defaults).
function normalizeDays(input: unknown): Record<DowKey, DayAvailability> {
  const src = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const out = emptyDays()
  for (const k of DOW_KEYS) {
    const raw = src[k] as Record<string, unknown> | undefined
    if (!raw || !raw.available) { out[k] = { available: false }; continue }
    let start = typeof raw.start === 'string' && /^\d{2}:\d{2}$/.test(raw.start) ? raw.start : DEFAULT_START
    let end = typeof raw.end === 'string' && /^\d{2}:\d{2}$/.test(raw.end) ? raw.end : DEFAULT_END
    if (end <= start) { start = DEFAULT_START; end = DEFAULT_END }
    out[k] = { available: true, start, end }
  }
  return out
}

export function normalizeWeekStart(day: string): string {
  return mondayOf(isDateStr(day) ? day : mondayOf(day))
}

export async function getWeek(staffId: string, weekStart: string): Promise<WeekAvailability | null> {
  const raw = await redis.get(KEY(staffId, weekStart))
  if (!raw) return null
  try { return JSON.parse(raw as string) as WeekAvailability } catch { return null }
}

// Read-or-scaffold: never persists — returns an empty draft when nothing is saved
// so the UI always has a full Mon–Sun shape to render.
export async function getOrInitWeek(staffId: string, weekStart: string): Promise<WeekAvailability> {
  const existing = await getWeek(staffId, weekStart)
  if (existing) return existing
  const now = Date.now()
  return { staffId, weekStart, days: emptyDays(), status: 'draft', createdAt: now, updatedAt: now }
}

export async function saveWeek(
  staffId: string,
  weekStart: string,
  days: unknown,
  submit: boolean,
): Promise<WeekAvailability> {
  const ws = normalizeWeekStart(weekStart)
  const existing = await getWeek(staffId, ws)
  const now = Date.now()
  const record: WeekAvailability = {
    staffId,
    weekStart: ws,
    days: normalizeDays(days),
    status: submit ? 'submitted' : 'draft',
    submittedAt: submit ? now : existing?.submittedAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  await redis.set(KEY(staffId, ws), JSON.stringify(record))
  await redis.zadd(INDEX(staffId), scoreOf(ws), ws)
  return record
}

export async function listWeeks(staffId: string, limit = 8): Promise<WeekAvailability[]> {
  const weeks = await redis.zrevrange(INDEX(staffId), 0, limit - 1)
  if (!weeks.length) return []
  const raws = await Promise.all(weeks.map(w => redis.get(KEY(staffId, w))))
  return raws
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r as string) as WeekAvailability } catch { return null } })
    .filter((x): x is WeekAvailability => x !== null)
}

// The scheduling signal (Part 7: "warn if assigning outside availability").
// Returns true/false when the crew member has SUBMITTED that week, or null when
// they haven't (unknown ≠ unavailable — the UI shows "no availability on file").
export async function isAvailableOn(staffId: string, dateYmd: string): Promise<boolean | null> {
  if (!isDateStr(dateYmd)) return null
  const ws = mondayOf(dateYmd)
  const week = await getWeek(staffId, ws)
  if (!week || week.status !== 'submitted') return null
  const key = WEEKDAY_TO_KEY[weekdayOf(dateYmd)]
  return week.days[key]?.available ?? false
}

// Convenience for the seven Monday-anchored dates of a week (for labels).
export function weekDates(weekStart: string): Record<DowKey, string> {
  return DOW_KEYS.reduce((acc, k, i) => { acc[k] = addDaysStr(weekStart, i); return acc }, {} as Record<DowKey, string>)
}

// How many of the next `weeks` weeks (starting this Monday) the crew member has
// SUBMITTED availability for. Feeds the Crew Score's availability factor.
export async function countSubmittedUpcoming(staffId: string, fromWeekStart: string, weeks = 4): Promise<number> {
  const starts = Array.from({ length: weeks }, (_, i) => addDaysStr(fromWeekStart, i * 7))
  const records = await Promise.all(starts.map(ws => getWeek(staffId, ws)))
  return records.filter(w => w?.status === 'submitted').length
}
