import { redis } from './redis'
import { bindToken, revokeTokenBinding } from './platform/tenancy/token-binding'
import { currentTenantId } from './platform/tenancy/context'
import { DEFAULT_TENANT_ID } from './platform/tenancy/types'

// Contractor Pay Statements (Part 5). A statement is an ISSUED, immutable snapshot
// of one crew member's pay for a period — gross, claim-recovery deductions, and net
// — captured from the deterministic pay engine (lib/route-pay.computePay) at issue
// time. We never recompute a statement after issuing it (rates/routes can change);
// the snapshot is the record. Duplicate prevention is keyed on crew + exact period.

export type StatementLine = {
  source?: 'route' | 'booking' | 'historical'
  routeNumber: string
  routeDate: string
  businessName: string
  amountCents: number
  workedMinutes?: number
  description?: string
  earningKind?: 'hourly' | 'daily' | 'fixed'
  quantity?: number
  rateCents?: number
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
  statementSource?: 'operion_generated' | 'historical_manual'
  periodUnit?: 'day' | 'week' | 'month' | 'custom'
  paymentDate?: string
  paymentMethod?: 'cash' | 'check' | 'direct_deposit' | 'zelle' | 'other'
  paymentReference?: string
  historicalNote?: string
  status: 'issued' | 'void'
  issuedBy: string
  issuedAt: number
  emailedAt?: number
  updatedAt: number
}

export type StatementYtd = { grossCents: number; deductionCents: number; netCents: number }

export type CrewStatementSummary = Pick<PayStatement,
  'id' | 'statementNumber' | 'periodStart' | 'periodEnd' | 'netCents' | 'routeCount' | 'issuedAt' | 'paymentDate'
>

export type CrewStatementLine = Omit<StatementLine, 'source' | 'businessName'> & { businessName?: string }

export type CrewPayStatement = Omit<PayStatement,
  'historicalNote' | 'statementSource' | 'issuedBy' | 'periodUnit' | 'lines'
> & { lines: CrewStatementLine[] }

/** Crew-facing records intentionally omit internal/manual-entry provenance. */
export function crewStatementSummary(s: PayStatement): CrewStatementSummary {
  return {
    id: s.id,
    statementNumber: s.statementNumber,
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    netCents: s.netCents,
    routeCount: s.routeCount,
    issuedAt: s.issuedAt,
    ...(s.paymentDate ? { paymentDate: s.paymentDate } : {}),
  }
}

export function crewPayStatement(s: PayStatement): CrewPayStatement {
  const historical = isHistoricalStatement(s)
  const {
    historicalNote: _historicalNote,
    statementSource: _statementSource,
    issuedBy: _issuedBy,
    periodUnit: _periodUnit,
    ...statement
  } = s
  return {
    ...statement,
    lines: statement.lines.map(({ source: _source, businessName, ...line }) => (
      historical ? line : { ...line, businessName }
    )),
  }
}

export function isHistoricalStatement(s: Pick<PayStatement, 'statementSource'>): boolean {
  return s.statementSource === 'historical_manual'
}

export function paymentMethodLabel(method: PayStatement['paymentMethod']): string | undefined {
  if (!method) return undefined
  return ({ cash: 'Cash', check: 'Check', direct_deposit: 'Direct deposit', zelle: 'Zelle', other: 'Other' })[method]
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

  // WAVE 6D-B — the opaque ps_ id IS the public capability (owner decision 2), so the
  // binding is keyed by the id itself and every printed, emailed and saved
  // verification link keeps working untouched.
  //
  // A VOID statement keeps its binding on purpose. /api/verify/[id] deliberately
  // answers `verified: false` with the same non-sensitive fields for a voided
  // statement — that is the product telling a lender "this document is real but was
  // voided". Revoking the binding would turn that meaningful answer into a bare 404,
  // i.e. "no such statement", which is both less true and less useful. The reader,
  // not the binding, decides what a void statement discloses.
  try {
    await bindToken(s.id, {
      tenantId: currentTenantId() ?? DEFAULT_TENANT_ID,
      resourceType: 'pay-statement',
      resourceId: s.id,
    })
  } catch { /* conflict: never overwrite another tenant's binding */ }
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

const STAFF_SCAN_PAGE = 250

// Exact, uncapped staff history. Each page is one ZRANGE + one MGET, so a 500-row
// history costs four store round trips instead of 501 individual REST requests.
// Paging avoids a hidden correctness cap and keeps each response payload bounded.
async function allForStaff(staffId: string): Promise<PayStatement[]> {
  const all: PayStatement[] = []
  for (let offset = 0; ; offset += STAFF_SCAN_PAGE) {
    const ids = await redis.zrevrange(STAFF_INDEX(staffId), offset, offset + STAFF_SCAN_PAGE - 1)
    all.push(...await hydrate(ids))
    if (ids.length < STAFF_SCAN_PAGE) return all
  }
}

async function allStatements(): Promise<PayStatement[]> {
  const all: PayStatement[] = []
  for (let offset = 0; ; offset += STAFF_SCAN_PAGE) {
    const ids = await redis.zrevrange(INDEX, offset, offset + STAFF_SCAN_PAGE - 1)
    all.push(...await hydrate(ids))
    if (ids.length < STAFF_SCAN_PAGE) return all
  }
}

/** The live statement whose period intersects [start, end], if one exists. */
export async function findOverlappingStatement(staffId: string, start: string, end: string): Promise<PayStatement | null> {
  const statements = await allForStaff(staffId)
  return statements.find(candidate =>
    candidate.status === 'issued' && candidate.periodStart <= end && candidate.periodEnd >= start,
  ) ?? null
}

/** Resolve the immutable statement attached to a correction without relying on a capped admin list. */
export async function findStatementForCorrection(
  staffId: string,
  statementNumber?: string,
  start?: string,
  end?: string,
): Promise<PayStatement | null> {
  const statements = await allForStaff(staffId)
  if (statementNumber) {
    const numbered = statements.find(candidate => candidate.statementNumber === statementNumber)
    if (numbered) return numbered
  }
  if (!start || !end) return null
  return statements.find(candidate =>
    candidate.status === 'issued' && candidate.periodStart <= end && candidate.periodEnd >= start,
  ) ?? null
}

// Recorded YTD is derived from immutable issued statements whose pay period ends in
// the same calendar year and no later than this statement. This includes historical
// stubs and Operion-generated statements exactly once; void records never count.
export async function recordedYtdForStatement(statement: PayStatement): Promise<StatementYtd> {
  const year = statement.periodEnd.slice(0, 4)
  const statements = await allForStaff(statement.staffId)
  return statements.reduce<StatementYtd>((sum, candidate) => {
    if (candidate.status !== 'issued' || candidate.periodEnd.slice(0, 4) !== year || candidate.periodEnd > statement.periodEnd) return sum
    sum.grossCents += candidate.grossCents
    sum.deductionCents += candidate.deductionCents
    sum.netCents += candidate.netCents
    return sum
  }, { grossCents: 0, deductionCents: 0, netCents: 0 })
}

/** Current issued-statement YTD for a crew member, exact and uncapped. */
export async function recordedYtdForStaff(staffId: string, throughDate: string): Promise<StatementYtd> {
  const year = throughDate.slice(0, 4)
  const statements = await allForStaff(staffId)
  return statements.reduce<StatementYtd>((sum, candidate) => {
    if (candidate.status !== 'issued' || candidate.periodEnd.slice(0, 4) !== year || candidate.periodEnd > throughDate) return sum
    sum.grossCents += candidate.grossCents
    sum.deductionCents += candidate.deductionCents
    sum.netCents += candidate.netCents
    return sum
  }, { grossCents: 0, deductionCents: 0, netCents: 0 })
}

/** Historical issued gross by crew for tax readiness; generated payroll is excluded to prevent double-counting routes. */
export async function historicalYtdByStaff(year: string): Promise<Record<string, number>> {
  const statements = await allStatements()
  return statements.reduce<Record<string, number>>((totals, statement) => {
    if (statement.status === 'issued' && statement.statementSource === 'historical_manual' && statement.periodEnd.slice(0, 4) === year) {
      totals[statement.staffId] = (totals[statement.staffId] ?? 0) + statement.grossCents
    }
    return totals
  }, {})
}

async function hydrate(ids: string[]): Promise<PayStatement[]> {
  if (!ids.length) return []
  const raws = await redis.mget(ids.map(KEY))
  return raws
    .filter(Boolean)
    .map(r => { try { return JSON.parse(r as string) as PayStatement } catch { return null } })
    .filter((x): x is PayStatement => x !== null)
}

// ── Void ─────────────────────────────────────────────────────────────────────
//
// FIN-2 (July 2026 audit). Void frees the period so a corrected statement can be
// re-issued. The period key is shared by (staff, period) but a void is addressed by
// STATEMENT ID, and the old implementation deleted the key unconditionally — so
// voiding a statement that had already been superseded deleted the *replacement's*
// index. The duplicate guard then saw a free period and issued a second live
// statement for the same crew member and week. No concurrency was needed: a stale
// tab or a second click on an already-void row was enough.
//
// The key may now only be deleted when it still points at THIS statement, and that
// test happens inside Redis (compare-and-delete), not in the app.
const RELEASE_PERIOD_IF_OWNED =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

/**
 * Free the period index only if it still belongs to `statementId`. Atomic — a
 * GET-then-DEL could still delete a successor's index in the gap. Returns true when
 * this statement actually owned (and released) the period.
 */
export async function releasePeriodIndexIfOwned(s: Pick<PayStatement, 'id' | 'staffId' | 'periodStart' | 'periodEnd'>): Promise<boolean> {
  const res = await redis.eval(RELEASE_PERIOD_IF_OWNED, [PERIOD_KEY(s.staffId, s.periodStart, s.periodEnd)], [s.id])
  return res === 1 || res === '1'
}

export type VoidOutcome =
  | { kind: 'voided'; statement: PayStatement; freedPeriod: boolean }
  | { kind: 'already_void'; statement: PayStatement }
  | { kind: 'not_found' }

/**
 * Void one statement. Reloads the record itself so the status decision is made on
 * the freshest copy — callers hold the per-(staff, period) lock around this, so no
 * generation can interleave.
 *
 * Idempotent: an already-void statement is a truthful no-op that touches NO index
 * and NO other record. `beforeWrite` (FIN-1's lease ownership check) runs only when
 * there is actually something to write.
 *
 * ORDER — persist the void, THEN release the index. The reverse order can leave an
 * issued statement with no index (a live statement the duplicate guard cannot see →
 * duplicates). This order's only failure window leaves the index pointing at a VOID
 * statement, which `findByPeriod` already treats as absent, so the period reads as
 * free and the next successful generation overwrites the key. Self-correcting, and
 * it can never produce two live statements. This is ordering safety, NOT
 * transactional atomicity — the KV store has no multi-key transaction.
 */
export async function voidStatement(
  id: string,
  opts: { beforeWrite?: () => Promise<void> } = {},
): Promise<VoidOutcome> {
  const s = await getStatement(id)
  if (!s) return { kind: 'not_found' }
  if (s.status === 'void') return { kind: 'already_void', statement: s }

  await opts.beforeWrite?.()

  s.status = 'void'
  await persist(s)                                    // persist() never re-claims the period for a void record
  const freedPeriod = await releasePeriodIndexIfOwned(s)
  return { kind: 'voided', statement: s, freedPeriod }
}
