import { redis } from './redis'

// Pay Correction requests (Part 5). Crew can't edit pay — they raise a correction
// request that management reviews. Purely a communication/review record; approving
// it does NOT move money on its own (the admin then adjusts via the claims ledger /
// re-issues the statement). Mirrors the time-off request pattern.

export type PayCorrectionStatus = 'pending' | 'approved' | 'denied'

export type PayCorrection = {
  id: string
  staffId: string
  staffName?: string
  statementNumber?: string     // the statement they're questioning, if any
  periodStart?: string
  periodEnd?: string
  message: string
  status: PayCorrectionStatus
  decidedBy?: string
  decidedAt?: number
  decisionNote?: string
  createdAt: number
  updatedAt: number
}

const KEY = (id: string) => `paycorr:${id}`
const INDEX = 'paycorr:index'
const STAFF_INDEX = (staffId: string) => `paycorr:staff:${staffId}`

export function newCorrectionId(): string {
  return `pc_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`
}

export async function getCorrection(id: string): Promise<PayCorrection | null> {
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as PayCorrection } catch { return null }
}

async function persist(c: PayCorrection): Promise<void> {
  c.updatedAt = Date.now()
  await redis.set(KEY(c.id), JSON.stringify(c))
  await redis.zadd(INDEX, c.createdAt, c.id)
  await redis.zadd(STAFF_INDEX(c.staffId), c.createdAt, c.id)
}

export async function createCorrection(input: {
  staffId: string; staffName?: string; statementNumber?: string
  periodStart?: string; periodEnd?: string; message: string
}): Promise<PayCorrection> {
  const now = Date.now()
  const c: PayCorrection = {
    id: newCorrectionId(),
    staffId: input.staffId,
    staffName: input.staffName,
    statementNumber: input.statementNumber,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    message: input.message.trim(),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }
  await persist(c)
  return c
}

export async function listForStaff(staffId: string, limit = 50): Promise<PayCorrection[]> {
  return hydrate(await redis.zrevrange(STAFF_INDEX(staffId), 0, limit - 1))
}

export async function listAll(limit = 200): Promise<PayCorrection[]> {
  return hydrate(await redis.zrevrange(INDEX, 0, limit - 1))
}

async function hydrate(ids: string[]): Promise<PayCorrection[]> {
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  return raws
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r as string) as PayCorrection } catch { return null } })
    .filter((x): x is PayCorrection => x !== null)
}

export async function decideCorrection(id: string, approve: boolean, by: string, note?: string): Promise<PayCorrection | null> {
  const c = await getCorrection(id)
  if (!c) return null
  if (c.status !== 'pending') return c
  c.status = approve ? 'approved' : 'denied'
  c.decidedBy = by
  c.decidedAt = Date.now()
  c.decisionNote = note?.trim() || undefined
  await persist(c)
  return c
}
