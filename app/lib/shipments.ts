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
  'created': 'Booked',
  'dispatched': 'Dispatched',
  'out-for-delivery': 'Out for Delivery',
  'delivered': 'Delivered',
}

export const STATUS_DESC: Record<ShipmentStatus, string> = {
  'created': 'Your shipment is booked and assigned. Driver dispatch will follow.',
  'dispatched': 'Driver has picked up your shipment and is en route.',
  'out-for-delivery': 'On the truck. Delivery in progress today.',
  'delivered': 'Delivered. Proof of delivery is on file with our ops team.',
}
