import { redis } from './redis'

// Lightweight crew/staff roster. Names here populate the booking "Assigned To"
// picker; assignment itself is stored on the booking (assignedTo).
export type Staff = {
  id: string
  name: string
  phone?: string
  role?: string
  active: boolean
  createdAt: number
  updatedAt: number
}

const KEY = (id: string) => `staff:${id}`
const INDEX = 'staff:index'

export async function listStaff(limit = 200): Promise<Staff[]> {
  const ids = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  return raws
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r as string) as Staff } catch { return null } })
    .filter((x): x is Staff => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function saveStaff(s: Staff): Promise<void> {
  s.updatedAt = Date.now()
  await redis.set(KEY(s.id), JSON.stringify(s))
  await redis.zadd(INDEX, s.createdAt, s.id)
}

export async function deleteStaff(id: string): Promise<void> {
  await redis.del(KEY(id))
  await redis.zrem(INDEX, id)
}
