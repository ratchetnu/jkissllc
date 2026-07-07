// Client portal — a read-only per-business link where a contract client sees who
// is scheduled and confirmed for their upcoming routes. The token is the whole
// credential. The projection is heavily scrubbed: no pay, no contractor last name
// or phone, no internal churn states (declines / no-response / drafts) — just a
// clean schedule of assigned/confirmed routes plus recent completions.
import { redis } from './redis'
import { listRoutes } from './routes'

export type ClientPortal = {
  token: string
  businessName: string       // matched against route.businessName (case-insensitive)
  label?: string             // display name for the client, if different
  createdAt: number
  updatedAt: number
}

export type ClientRoute = {
  routeNumber: string
  routeDate: string
  reportTime: string
  reportAddress: string
  status: 'scheduled' | 'confirmed' | 'completed'
  crewFirstName?: string
}

const KEY = (t: string) => `rt:client:${t}`
const KEY_INDEX = 'rt:client:index'   // zset, score = updatedAt, member = token
const TOKEN_RE = /^[a-f0-9]{16,}$/i

export function generateClientToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
}

export async function getClientPortal(token: string): Promise<ClientPortal | null> {
  if (!token || !TOKEN_RE.test(token)) return null
  const raw = await redis.get(KEY(token))
  if (!raw) return null
  try { return JSON.parse(raw) as ClientPortal } catch { return null }
}

export async function saveClientPortal(p: ClientPortal): Promise<void> {
  p.updatedAt = Date.now()
  await redis.set(KEY(p.token), JSON.stringify(p))
  await redis.zadd(KEY_INDEX, p.updatedAt, p.token)
}

export async function deleteClientPortal(token: string): Promise<void> {
  await redis.del(KEY(token))
  await redis.zrem(KEY_INDEX, token)
}

export async function listClientPortals(limit = 200): Promise<ClientPortal[]> {
  const toks = await redis.zrevrange(KEY_INDEX, 0, limit - 1)
  if (!toks.length) return []
  const raws = await Promise.all(toks.map(t => redis.get(KEY(t))))
  return raws
    .map(r => { try { return r ? JSON.parse(r) as ClientPortal : null } catch { return null } })
    .filter((p): p is ClientPortal => p !== null)
}

const centralToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
function addDaysStr(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

// Only surface committed work: assigned / texted / confirmed / completed, from a
// week back (to show recent completions) onward. Everything else stays internal.
const VISIBLE = new Set(['assigned', 'text_sent', 'confirmed', 'completed'])

export async function getClientRoutes(businessName: string): Promise<ClientRoute[]> {
  const today = centralToday()
  const floor = addDaysStr(today, -7)
  const target = businessName.trim().toLowerCase()

  return (await listRoutes(1000))
    .filter(r => r.businessName.trim().toLowerCase() === target && VISIBLE.has(r.status) && r.routeDate >= floor)
    .sort((a, b) => a.routeDate.localeCompare(b.routeDate) || a.reportTime.localeCompare(b.reportTime))
    .map(r => ({
      routeNumber: r.routeNumber,
      routeDate: r.routeDate,
      reportTime: r.reportTime,
      reportAddress: r.reportAddress,
      status: r.status === 'completed' ? 'completed' : r.status === 'confirmed' ? 'confirmed' : 'scheduled',
      crewFirstName: r.assignedStaffName ? r.assignedStaffName.trim().split(/\s+/)[0] : undefined,
    }))
}
