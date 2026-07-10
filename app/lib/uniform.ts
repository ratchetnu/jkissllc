import { redis } from './redis'
import { centralToday } from './dates'

// Daily uniform-photo check-in (request "Uniform Photo"). A crew member uploads
// today's uniform photo before starting their route; the reminder engine suppresses
// the uniform reminder once it exists, and the crew directory surfaces "missing
// uniform photo" for anyone who hasn't. One record per crew member per Central day.
//
// Photo bytes live in Vercel Blob (public URL); this stores the pointer + timestamp,
// mirroring how route.completionPhotos are handled.

export type UniformPhoto = {
  staffId: string
  date: string          // YYYY-MM-DD Central
  url: string           // Vercel Blob URL
  uploadedAt: number
}

const KEY = (staffId: string, date: string) => `uniform:${staffId}:${date}`
const INDEX = (staffId: string) => `uniform:idx:${staffId}`
const scoreOf = (date: string) => Number(date.replace(/-/g, ''))

export async function saveUniformPhoto(staffId: string, url: string, date = centralToday()): Promise<UniformPhoto> {
  const rec: UniformPhoto = { staffId, date, url, uploadedAt: Date.now() }
  await redis.set(KEY(staffId, date), JSON.stringify(rec))
  await redis.zadd(INDEX(staffId), scoreOf(date), date)
  return rec
}

export async function getUniformPhoto(staffId: string, date = centralToday()): Promise<UniformPhoto | null> {
  const raw = await redis.get(KEY(staffId, date))
  if (!raw) return null
  try { return JSON.parse(raw as string) as UniformPhoto } catch { return null }
}

// The suppression signal: has this crew member uploaded today's uniform photo?
export async function hasUniformToday(staffId: string, date = centralToday()): Promise<boolean> {
  return !!(await getUniformPhoto(staffId, date))
}

// Recent uploads for a crew profile (most recent first).
export async function listUniformPhotos(staffId: string, limit = 14): Promise<UniformPhoto[]> {
  const dates = await redis.zrevrange(INDEX(staffId), 0, limit - 1)
  if (!dates.length) return []
  const raws = await Promise.all(dates.map(d => redis.get(KEY(staffId, d))))
  return raws
    .map(r => { try { return r ? JSON.parse(r as string) as UniformPhoto : null } catch { return null } })
    .filter((x): x is UniformPhoto => x !== null)
}
