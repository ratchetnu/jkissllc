import { redis } from './redis'

export type ShipmentStatus = 'created' | 'dispatched' | 'out-for-delivery' | 'delivered'

export type Shipment = {
  bol: string                 // BOL or PO number — primary lookup key
  status: ShipmentStatus
  customerName?: string       // optional, shown in admin only
  pickupCity?: string
  deliveryCity?: string
  notes?: string              // public-facing message ("ETA 2-4pm", etc.)
  createdAt: number           // unix ms
  updatedAt: number
  dispatchedAt?: number
  deliveredAt?: number
}

const KEY_INDEX = 'ship:index'
const KEY_PREFIX = 'ship:'

export function normalizeBol(bol: string): string {
  return bol.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '')
}

export async function getShipment(bol: string): Promise<Shipment | null> {
  const norm = normalizeBol(bol)
  if (!norm) return null
  const raw = await redis.get(`${KEY_PREFIX}${norm}`)
  if (!raw) return null
  try { return JSON.parse(raw) as Shipment } catch { return null }
}

export async function saveShipment(s: Shipment): Promise<void> {
  s.updatedAt = Date.now()
  await redis.set(`${KEY_PREFIX}${s.bol}`, JSON.stringify(s))
  await redis.zadd(KEY_INDEX, s.updatedAt, s.bol)
}

export async function deleteShipment(bol: string): Promise<void> {
  const norm = normalizeBol(bol)
  await redis.del(`${KEY_PREFIX}${norm}`)
  await redis.zrem(KEY_INDEX, norm)
}

export async function listShipments(limit = 100): Promise<Shipment[]> {
  const bols = await redis.zrevrange(KEY_INDEX, 0, limit - 1)
  if (!bols.length) return []
  const raws = await Promise.all(bols.map(b => redis.get(`${KEY_PREFIX}${b}`)))
  return raws.filter(Boolean).map(r => JSON.parse(r as string) as Shipment)
}

export const STATUS_LABEL: Record<ShipmentStatus, string> = {
  'created': 'Scheduled',
  'dispatched': 'On The Way',
  'out-for-delivery': 'Crew On Site',
  'delivered': 'Complete',
}

export const STATUS_DESC: Record<ShipmentStatus, string> = {
  'created': 'Your pickup is booked and on the schedule. We\'ll confirm your arrival window before the crew heads out.',
  'dispatched': 'Crew is loaded up and on the way to your location.',
  'out-for-delivery': 'Crew is on site loading and hauling your items away.',
  'delivered': 'All done — everything\'s hauled off and disposed of responsibly. Thanks for choosing J Kiss.',
}
