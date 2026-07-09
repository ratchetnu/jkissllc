import { redis } from './redis'

// A lightweight registry of the equipment the operation runs — box trucks,
// trailers, dollies, and whatever a contractor brings to the job. Standalone
// roster, modelled on lib/staff: it records what's available and who owns it;
// it is not (yet) tied to a specific route.

// Who the equipment belongs to. 'contractor' means a crew member brings their
// own — track it, but it isn't a company asset.
export type Ownership = 'company' | 'contractor'

export type Equipment = {
  id: string
  name: string             // what it is — "26ft Box Truck #1", "Appliance Dolly"
  truckType?: string       // free text — "26ft box truck w/ liftgate", "F-350 dually"
  ownership: Ownership
  contractorName?: string  // when contractor-owned, whose it is (optional)
  notes?: string
  active: boolean
  createdAt: number
  updatedAt: number
}

const KEY = (id: string) => `equipment:${id}`
const INDEX = 'equipment:index'

export async function listEquipment(limit = 200): Promise<Equipment[]> {
  const ids = await redis.zrevrange(INDEX, 0, limit - 1)
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  return raws
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r as string) as Equipment } catch { return null } })
    .filter((x): x is Equipment => x !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function getEquipment(id: string): Promise<Equipment | null> {
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as Equipment } catch { return null }
}

export async function saveEquipment(e: Equipment): Promise<void> {
  e.updatedAt = Date.now()
  await redis.set(KEY(e.id), JSON.stringify(e))
  await redis.zadd(INDEX, e.createdAt, e.id)
}

export async function deleteEquipment(id: string): Promise<void> {
  await redis.del(KEY(id))
  await redis.zrem(INDEX, id)
}
