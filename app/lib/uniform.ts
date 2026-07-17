import { redis } from './redis'
import { centralToday } from './dates'

// Daily uniform-photo check-in (request "Uniform Photo"). A crew member uploads
// today's uniform photo before starting their route; the reminder engine suppresses
// the uniform reminder once it exists, and the crew directory surfaces "missing
// uniform photo" for anyone who hasn't. One record per crew member per Central day.
//
// Photo bytes live in Vercel Blob (public URL); this stores the pointer + timestamp,
// mirroring how route.completionPhotos are handled.
//
// A photo carries a review status so a manager can approve or bounce it back: a
// rejected photo prompts the crew member to resubmit (a fresh upload overwrites the
// day's record and resets the status). Legacy records predate `status` — treat a
// missing status as 'submitted' (uploaded, not yet reviewed).

export type UniformStatus = 'submitted' | 'approved' | 'rejected'

export type UniformPhoto = {
  staffId: string
  date: string          // YYYY-MM-DD Central
  url: string           // Vercel Blob URL
  uploadedAt: number
  status?: UniformStatus // absent on legacy records → 'submitted'
  reviewedAt?: number
  reviewedBy?: string   // admin/manager sub who reviewed it
  reviewNote?: string   // e.g. why it was rejected — shown to the crew member
}

const KEY = (staffId: string, date: string) => `uniform:${staffId}:${date}`
const INDEX = (staffId: string) => `uniform:idx:${staffId}`
const scoreOf = (date: string) => Number(date.replace(/-/g, ''))

// The effective status of a record (default 'submitted' for legacy rows).
export const uniformStatus = (p: Pick<UniformPhoto, 'status'> | null | undefined): UniformStatus =>
  p?.status ?? 'submitted'

// A rejected photo is the only state that asks the crew member to act again.
export const uniformNeedsResubmit = (p: UniformPhoto | null | undefined): boolean =>
  !!p && uniformStatus(p) === 'rejected'

async function writeUniformPhoto(rec: UniformPhoto): Promise<UniformPhoto> {
  await redis.set(KEY(rec.staffId, rec.date), JSON.stringify(rec))
  await redis.zadd(INDEX(rec.staffId), scoreOf(rec.date), rec.date)
  return rec
}

// A new upload (or resubmit) — always lands as a fresh 'submitted' photo, clearing
// any prior review so a bounced photo starts its review over.
export async function saveUniformPhoto(staffId: string, url: string, date = centralToday()): Promise<UniformPhoto> {
  return writeUniformPhoto({ staffId, date, url, uploadedAt: Date.now(), status: 'submitted' })
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

// Manager review — approve or reject an existing photo (does not change the photo
// itself). Returns null if there's no photo for that day.
export async function reviewUniformPhoto(
  staffId: string,
  date: string,
  decision: 'approved' | 'rejected',
  reviewedBy: string,
  note?: string,
): Promise<UniformPhoto | null> {
  const existing = await getUniformPhoto(staffId, date)
  if (!existing) return null
  existing.status = decision
  existing.reviewedAt = Date.now()
  existing.reviewedBy = reviewedBy
  existing.reviewNote = note?.trim() || undefined
  return writeUniformPhoto(existing)
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
