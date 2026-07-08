// Recurring route templates — standing contracts that regenerate on a weekly
// schedule. A template holds the fixed route details plus which weekdays it runs;
// materializeTemplate() creates the actual RouteRecords for an upcoming window,
// skipping any date already generated (so it's safe to run repeatedly / from cron).
import { redis } from './redis'
import { addDaysStr, weekdayOf } from './dates'
import {
  generateToken, nextRouteNumber, saveRoute, listRoutes, pushAudit, type RouteRecord,
} from './routes'
import { addCrew } from './route-notify'
import { getBusiness, bizKey } from './businesses'
import { listStaff } from './staff'
import { snapshotBusinessPrice } from './finance'

// The standing crew for one weekday, e.g. Monday always runs Marcus + Dee.
// Keyed by weekday number as a STRING because this round-trips through JSON.
export type CrewByWeekday = Record<string, string[]>   // "1" → [staffId, staffId]

export type RouteTemplate = {
  id: string
  label: string                 // internal name, e.g. "Acme — M/W/F morning"
  businessName: string
  reportAddress: string
  reportTime: string
  contactPerson?: string
  contactPhone?: string
  vehicle?: string
  payRate?: string
  description?: string
  specialNotes?: string
  weekdays: number[]            // 0=Sun … 6=Sat

  // Who normally runs each day. A generated route is crewed from this; the owner
  // can still change crew on any single date afterwards without touching the rule.
  crewByWeekday?: CrewByWeekday

  defaultStaffId?: string       // LEGACY: single contractor for every day. Falls back to
                                // this when crewByWeekday has no entry for that weekday.
  autoNotify?: boolean          // LEGACY: read-only. Generation never texts — see materializeTemplate.
  active: boolean
  createdAt: number
  updatedAt: number
}

// Which crew should run this weekday: the per-day rule, else the legacy single
// contractor, else nobody (the route generates as an unassigned draft).
export function crewForWeekday(tpl: RouteTemplate, weekday: number): string[] {
  const perDay = tpl.crewByWeekday?.[String(weekday)]
  if (Array.isArray(perDay) && perDay.length) return perDay
  return tpl.defaultStaffId ? [tpl.defaultStaffId] : []
}

// ── Input validation (shared by both template API routes) ────────────────────
export const parseWeekdays = (v: unknown): number[] =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b) : []

// { "1": ["staff_a","staff_b"] } — only weekdays the schedule actually runs, only
// non-empty crews. Anything malformed is dropped rather than half-trusted.
export function parseCrewByWeekday(v: unknown, weekdays: number[]): CrewByWeekday | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: CrewByWeekday = {}
  for (const [k, ids] of Object.entries(v as Record<string, unknown>)) {
    const day = Number(k)
    if (!Number.isInteger(day) || !weekdays.includes(day)) continue
    if (!Array.isArray(ids)) continue
    const clean = [...new Set(ids.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim().slice(0, 80)))]
    if (clean.length) out[String(day)] = clean
  }
  return Object.keys(out).length ? out : undefined
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function autoLabel(businessName: string, weekdays: number[]): string {
  const s = [...weekdays].sort((a, b) => a - b).join(',')
  const days = s === '1,2,3,4,5' ? 'Mon–Fri'
    : s === '1,2,3,4,5,6' ? 'Mon–Sat'
      : s === '0,1,2,3,4,5,6' ? 'Every day'
        : [...weekdays].sort((a, b) => a - b).map(d => DOW_SHORT[d]).join('/')
  return `${businessName} — ${days}`.slice(0, 120)
}

const KEY = (id: string) => `rt:tpl:${id}`
const KEY_INDEX = 'rt:tpl:index'   // zset, score = updatedAt, member = id

export function generateTemplateId(): string {
  return 'tpl_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

export async function getTemplate(id: string): Promise<RouteTemplate | null> {
  if (!id) return null
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw) as RouteTemplate } catch { return null }
}

export async function saveTemplate(t: RouteTemplate): Promise<void> {
  t.updatedAt = Date.now()
  await redis.set(KEY(t.id), JSON.stringify(t))
  await redis.zadd(KEY_INDEX, t.updatedAt, t.id)
}

export async function deleteTemplate(id: string): Promise<void> {
  await redis.del(KEY(id))
  await redis.zrem(KEY_INDEX, id)
}

export async function listTemplates(limit = 200): Promise<RouteTemplate[]> {
  const ids = await redis.zrevrange(KEY_INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(i => redis.get(KEY(i))))
  return raws
    .map(r => { try { return r ? JSON.parse(r) as RouteTemplate : null } catch { return null } })
    .filter((t): t is RouteTemplate => t !== null)
}

// Calendar dates, no timezone drift. Defined in lib/dates; re-exported because
// callers already import them from here.
export { addDaysStr, weekdayOf }

// Create routes for every matching weekday in [todayStr, todayStr+horizonDays]
// that doesn't already have a route from this template. Returns the new route
// numbers. Safe to call repeatedly — existing dates are skipped.
//
// Crew are ASSIGNED but never TEXTED. Nothing in this OS sends a contractor a
// message without the owner pressing send — a cron that texted people up to two
// weeks ahead of a route was the old behaviour, and it was wrong.
export async function materializeTemplate(
  tpl: RouteTemplate, todayStr: string, horizonDays: number,
): Promise<{ created: string[] }> {
  if (!tpl.active || !tpl.weekdays.length) return { created: [] }

  // Which dates already exist for this template?
  const existing = new Set(
    (await listRoutes(1000))
      .filter(r => r.templateId === tpl.id)
      .map(r => r.routeDate),
  )

  // Only load the roster if some weekday actually has a standing crew.
  const needsCrew = tpl.weekdays.some(d => crewForWeekday(tpl, d).length > 0)
  const roster = needsCrew ? await listStaff() : []

  const biz = await getBusiness(bizKey(tpl.businessName)).catch(() => null)
  const created: string[] = []
  for (let i = 0; i <= horizonDays; i++) {
    const day = addDaysStr(todayStr, i)
    const dow = weekdayOf(day)
    if (!tpl.weekdays.includes(dow) || existing.has(day)) continue

    const now = Date.now()
    const route: RouteRecord = {
      token: generateToken(),
      routeNumber: await nextRouteNumber(),
      status: 'draft',
      businessName: tpl.businessName,
      contactPerson: tpl.contactPerson,
      contactPhone: tpl.contactPhone,
      reportAddress: tpl.reportAddress,
      reportTime: tpl.reportTime,
      routeDate: day,
      description: tpl.description,
      payRate: tpl.payRate,
      vehicle: tpl.vehicle,
      specialNotes: tpl.specialNotes,
      templateId: tpl.id,
      requiresHelper: biz?.requiresHelper || undefined,
      events: [],
      audit: [],
      createdAt: now,
      updatedAt: now,
      createdBy: 'template',
    }
    pushAudit(route, 'system', `Generated from template “${tpl.label}”`)

    // Each generated route snapshots the client's contract rate as it stands at
    // generation time — before crew are added, so the assign path sees the price.
    snapshotBusinessPrice(route, biz)

    // Crew this weekday's standing team. addCrew snapshots each person's configured
    // pay for this business and sends NOTHING; the owner texts them when ready.
    for (const staffId of crewForWeekday(tpl, dow)) {
      const staff = roster.find(s => s.id === staffId)
      if (staff) addCrew(route, staff)
    }

    try { await saveRoute(route); created.push(route.routeNumber); existing.add(day) }
    catch { /* skip this one, keep going */ }
  }
  return { created }
}
