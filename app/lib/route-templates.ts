// Recurring route templates — standing contracts that regenerate on a weekly
// schedule. A template holds the fixed route details plus which weekdays it runs;
// materializeTemplate() creates the actual RouteRecords for an upcoming window,
// skipping any date already generated (so it's safe to run repeatedly / from cron).
import { redis } from './redis'
import {
  generateToken, nextRouteNumber, saveRoute, listRoutes, pushAudit, type RouteRecord,
} from './routes'
import { assignAndNotify } from './route-notify'
import { listStaff } from './staff'

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
  defaultStaffId?: string       // pre-assign generated routes to this contractor
  autoNotify: boolean           // if true + defaultStaffId, generated routes are assigned & texted
  active: boolean
  createdAt: number
  updatedAt: number
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

// ── Date helpers (calendar dates, no timezone drift) ─────────────────────────
export function addDaysStr(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}
export function weekdayOf(s: string): number {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

// Create routes for every matching weekday in [todayStr, todayStr+horizonDays]
// that doesn't already have a route from this template. Returns the new route
// numbers. Safe to call repeatedly — existing dates are skipped.
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

  const staff = tpl.autoNotify && tpl.defaultStaffId
    ? (await listStaff()).find(s => s.id === tpl.defaultStaffId)
    : undefined

  const created: string[] = []
  for (let i = 0; i <= horizonDays; i++) {
    const day = addDaysStr(todayStr, i)
    if (!tpl.weekdays.includes(weekdayOf(day)) || existing.has(day)) continue

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
      events: [],
      audit: [],
      createdAt: now,
      updatedAt: now,
      createdBy: 'template',
    }
    pushAudit(route, 'system', `Generated from template “${tpl.label}”`)

    // Optionally assign + text the default contractor right away.
    if (staff) { try { await assignAndNotify(route, staff) } catch { /* leave as draft */ } }

    try { await saveRoute(route); created.push(route.routeNumber); existing.add(day) }
    catch { /* skip this one, keep going */ }
  }
  return { created }
}
