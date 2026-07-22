import { redis } from './redis'

// Contractor Pay Statements (Part 5). A statement is an ISSUED, immutable snapshot
// of one crew member's pay for a period — gross, claim-recovery deductions, and net
// — captured from the deterministic pay engine (lib/route-pay.computePay) at issue
// time. We never recompute a statement after issuing it (rates/routes can change);
// the snapshot is the record. Duplicate prevention is keyed on crew + exact period.

export type StatementLine = {
  source?: 'route' | 'booking'
  routeNumber: string
  routeDate: string
  businessName: string
  amountCents: number
  workedMinutes?: number
}

export type StatementDeduction = {
  label: string
  amountCents: number
}

export type PayStatement = {
  id: string
  statementNumber: string      // JK-PS-1001
  staffId: string
  staffName: string
  periodStart: string          // YYYY-MM-DD
  periodEnd: string            // YYYY-MM-DD
  grossCents: number
  deductionCents: number       // applied (never exceeds gross)
  netCents: number
  routeCount: number
  lines: StatementLine[]
  deductions: StatementDeduction[]
  status: 'issued' | 'void'
  issuedBy: string
  issuedAt: number
  emailedAt?: number
  updatedAt: number
}

const KEY = (id: string) => `paystmt:${id}`
const INDEX = 'paystmt:index'
const STAFF_INDEX = (staffId: string) => `paystmt:staff:${staffId}`
const PERIOD_KEY = (staffId: string, start: string, end: string) => `paystmt:period:${staffId}:${start}:${end}`
const COUNTER = 'paystmt:counter'

export function newStatementId(): string {
  return `ps_${crypto.randomUUID().replace(/-/g, '').slice(0, 18)}`
}

export async function nextStatementNumber(): Promise<string> {
  const n = await redis.incr(COUNTER)
  return `JK-PS-${1000 + n}`
}

export async function getStatement(id: string): Promise<PayStatement | null> {
  const raw = await redis.get(KEY(id))
  if (!raw) return null
  try { return JSON.parse(raw as string) as PayStatement } catch { return null }
}

// Duplicate guard: the live (non-void) statement for this exact crew+period, if any.
export async function findByPeriod(staffId: string, start: string, end: string): Promise<PayStatement | null> {
  const id = await redis.get(PERIOD_KEY(staffId, start, end))
  if (!id) return null
  const s = await getStatement(id)
  return s && s.status !== 'void' ? s : null
}

async function persist(s: PayStatement): Promise<void> {
  s.updatedAt = Date.now()
  await redis.set(KEY(s.id), JSON.stringify(s))
  await redis.zadd(INDEX, s.issuedAt, s.id)
  await redis.zadd(STAFF_INDEX(s.staffId), s.issuedAt, s.id)
  if (s.status !== 'void') await redis.set(PERIOD_KEY(s.staffId, s.periodStart, s.periodEnd), s.id)
}

export async function saveStatement(s: PayStatement): Promise<void> {
  await persist(s)
}

export async function listStatements(limit = 500): Promise<PayStatement[]> {
  const ids = await redis.zrevrange(INDEX, 0, limit - 1)
  return hydrate(ids)
}

export async function listForStaff(staffId: string, limit = 100): Promise<PayStatement[]> {
  const ids = await redis.zrevrange(STAFF_INDEX(staffId), 0, limit - 1)
  return hydrate(ids)
}

async function hydrate(ids: string[]): Promise<PayStatement[]> {
  if (!ids.length) return []
  const raws = await Promise.all(ids.map(id => redis.get(KEY(id))))
  return raws
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r as string) as PayStatement } catch { return null } })
    .filter((x): x is PayStatement => x !== null)
}

// Void frees the period so a corrected statement can be re-issued.
export async function voidStatement(id: string): Promise<PayStatement | null> {
  const s = await getStatement(id)
  if (!s) return null
  s.status = 'void'
  await redis.del(PERIOD_KEY(s.staffId, s.periodStart, s.periodEnd))
  await persist(s)
  return s
}
