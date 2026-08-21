import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission, requirePrincipal } from '../_lib/session'
import { computePay } from '../../../lib/route-pay'
import { getStaff, staffMayReceivePay } from '../../../lib/staff'
import {
  listStatements, listForStaff, findByPeriod, findOverlappingStatement, findStatementForCorrection, historicalYtdByStaff, issueStatement, newStatementId,
  type PayStatement, type StatementLine, type StatementDeduction,
} from '../../../lib/pay-statements'
import { validateHistoricalPay } from '../../../lib/historical-pay'
import { withPayStatementLock, StatementGenerationBusyError, StatementLockLostError } from '../../../lib/pay-statement-mutex'
import { auditAdmin } from '../../../lib/audit'
import { can, roleLabel } from '../../../lib/rbac'
import { isDateStr } from '../../../lib/dates'
import { isPayPeriodAvailable, payAvailableThrough, scheduledPayDate } from '../../../lib/pay-schedule'
import { getBusinessAddress } from '../../../lib/business-address'
import { resolveCorrection } from '../../../lib/pay-corrections'

type PayrollGap = { bookingNumber: string; staffIds: string[]; reason: string }

// The result of one guarded generation attempt. Returned OUT of the lock so the
// HTTP mapping (and the post-commit audit line) happen after the lock is released.
type GenerateOutcome =
  | { kind: 'created'; statement: PayStatement }
  | { kind: 'duplicate'; existing: PayStatement }
  | { kind: 'overlap'; existing: PayStatement }
  | { kind: 'no_activity' }
  | { kind: 'payroll_gap'; gaps: PayrollGap[] }

const gapError = (gaps: PayrollGap[]) =>
  `Cannot generate this statement: ${gaps.map(g => g.bookingNumber).join(', ')} needs a service date.`

async function resolveIssuedCorrection(
  correctionId: string,
  statement: PayStatement,
  actorLabel: string,
): Promise<string | undefined> {
  if (!correctionId) return undefined
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const resolved = await resolveCorrection(correctionId, statement, actorLabel)
      return resolved
        ? undefined
        : 'The statement was issued, but the correction request could not be linked to it. Review the correction before closing it.'
    } catch (error) {
      lastError = error
    }
  }
  console.error('[pay-statement] correction resolution failed', { correctionId, statementId: statement.id, error: lastError })
  return 'The statement was issued, but its correction request is still open. Retry the correction workflow or contact support.'
}

// Build the pay figures for ONE crew member over a period from the deterministic
// engine (computePay uses completed routes/bookings + the claims ledger). Returns
// null when the crew member has no activity in the window.
async function buildSnapshot(staffId: string, start: string, end: string) {
  const summary = await computePay(start, end)
  const payrollGaps = (summary.payrollGaps ?? []).filter(g => g.staffIds.includes(staffId))
  if (payrollGaps.length) return { blockedBy: payrollGaps }
  const cp = summary.contractors.find(c => c.staffId === staffId)
  if (!cp) return null
  const lines: StatementLine[] = cp.routes
    .filter(r => r.amountCents != null)
    .map(r => ({ source: r.source, routeNumber: r.routeNumber, routeDate: r.routeDate, businessName: r.businessName, amountCents: r.amountCents as number, workedMinutes: r.workedMinutes }))
  const deductions: StatementDeduction[] = cp.deductions.map(d => ({
    label: `${d.reason}${d.claimNumber ? ` (${d.claimNumber})` : ''}`,
    amountCents: d.amountCents,
  }))
  return {
    name: cp.name,
    grossCents: cp.grossCents,
    deductionCents: cp.appliedCents,
    netCents: cp.netCents,
    routeCount: cp.count,
    lines,
    deductions,
  }
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'pay:view:all')
  if (who instanceof NextResponse) return who
  const params = new URL(req.url).searchParams
  const staffId = params.get('staffId')
  const offset = Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0)
  const limit = Math.min(500, Math.max(1, Number.parseInt(params.get('limit') ?? '500', 10) || 500))
  const historicalYear = params.get('historicalYtdYear')
  if (historicalYear) {
    if (!/^\d{4}$/.test(historicalYear)) return NextResponse.json({ ok: false, error: 'Invalid year.' }, { status: 400 })
    return NextResponse.json({ ok: true, historicalGrossByStaff: await historicalYtdByStaff(historicalYear) })
  }
  if (params.get('resolveCorrection') === '1') {
    const statementNumber = params.get('statementNumber')?.trim() || undefined
    const periodStart = params.get('periodStart')?.trim() || undefined
    const periodEnd = params.get('periodEnd')?.trim() || undefined
    if (!staffId || (!statementNumber && (!periodStart || !periodEnd))) {
      return NextResponse.json({ ok: false, error: 'Correction statement context is incomplete.' }, { status: 400 })
    }
    const statement = await findStatementForCorrection(staffId, statementNumber, periodStart, periodEnd)
    return NextResponse.json({ ok: true, statement })
  }
  const statements = staffId ? await listForStaff(staffId, limit, offset) : await listStatements(limit, offset)
  return NextResponse.json({ ok: true, statements, nextOffset: statements.length === limit ? offset + statements.length : null })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  // Authenticate before parsing an attacker-controlled body. Authorization is
  // selected after parsing because historical imports have a narrower permission.
  const principal = await requirePrincipal(req)
  if (principal instanceof NextResponse) return principal
  const body = await req.json().catch(() => ({}))
  const historical = body?.action === 'historical'
  const permission = historical ? 'pay:history:import' : 'pay:generate'
  if (!can(principal.role, permission)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const who = principal
  const correctionId = typeof body?.correctionId === 'string' ? body.correctionId.trim() : ''
  const actorLabel = who.sub === 'owner' ? 'Owner' : `${roleLabel[who.role]} (${who.sub})`

  const staffId = String(body?.staffId ?? '')
  const start = String(body?.periodStart ?? '').trim()
  const end = String(body?.periodEnd ?? '').trim()
  const preview = body?.action === 'preview'

  if (!staffId || !isDateStr(start) || !isDateStr(end) || end < start) {
    return NextResponse.json({ ok: false, error: 'Select a crew member and a valid period.' }, { status: 400 })
  }
  const availableThrough = payAvailableThrough()
  if (!preview && !isPayPeriodAvailable(end)) {
    return NextResponse.json({
      ok: false,
      error: `The current week is not available until Friday. Statements are available through ${availableThrough}.`,
    }, { status: 400 })
  }
  const staff = await getStaff(staffId)
  if (!staff) return NextResponse.json({ ok: false, error: 'Crew member not found.' }, { status: 404 })
  if (!staffMayReceivePay(staff)) {
    return NextResponse.json({ ok: false, error: 'This contractor cannot receive a pay statement until onboarding is verified.' }, { status: 409 })
  }
  const businessAddress = preview ? undefined : await getBusinessAddress()

  if (historical) {
    const validated = validateHistoricalPay({
      periodStart: start,
      periodEnd: end,
      periodUnit: body?.periodUnit,
      paymentDate: body?.paymentDate,
      paymentMethod: body?.paymentMethod,
      paymentReference: body?.paymentReference,
      note: body?.note,
      lines: body?.lines,
      deductions: body?.deductions,
    })
    if (!validated.ok) {
      return NextResponse.json({ ok: false, error: validated.error, field: validated.field }, { status: 400 })
    }

    let historicalOutcome: GenerateOutcome
    try {
      historicalOutcome = await withPayStatementLock({ staffId, periodStart: start, periodEnd: end }, async (lock) => {
        const existing = await findByPeriod(staffId, start, end)
        if (existing) return { kind: 'duplicate', existing } as const
        const overlap = await findOverlappingStatement(staffId, start, end)
        if (overlap) return { kind: 'overlap', existing: overlap } as const
        await lock.assertHeld()

        const value = validated.value
        const now = Date.now()
        const statement: PayStatement = {
          id: newStatementId(),
          statementNumber: '',
          staffId,
          staffName: staff.name,
          contractorAddress: staff.address,
          businessAddress,
          periodStart: value.periodStart,
          periodEnd: value.periodEnd,
          grossCents: value.grossCents,
          deductionCents: value.deductionCents,
          netCents: value.netCents,
          routeCount: 0,
          lines: value.lines,
          deductions: value.deductions,
          statementSource: 'historical_manual',
          periodUnit: value.periodUnit,
          paymentDate: value.paymentDate,
          paymentMethod: value.paymentMethod,
          paymentReference: value.paymentReference,
          historicalNote: value.note,
          status: 'issued',
          issuedBy: actorLabel,
          issuedAt: now,
          updatedAt: now,
        }
        const issued = await issueStatement(statement)
        return { kind: 'created', statement: issued } as const
      })
    } catch (err) {
      if (err instanceof StatementGenerationBusyError || err instanceof StatementLockLostError) {
        return NextResponse.json({
          ok: false,
          reason: 'generation_in_progress',
          error: 'This crew member’s pay period is being updated. Try again in a moment.',
        }, { status: 423 })
      }
      throw err
    }

    if (historicalOutcome.kind === 'duplicate') {
      return NextResponse.json({
        ok: false,
        reason: 'duplicate_period',
        error: `A statement for this period already exists (${historicalOutcome.existing.statementNumber}). Void it first to replace it.`,
        existing: historicalOutcome.existing,
      }, { status: 409 })
    }
    if (historicalOutcome.kind === 'overlap') {
      return NextResponse.json({
        ok: false,
        reason: 'overlapping_period',
        error: `This period overlaps ${historicalOutcome.existing.statementNumber} (${historicalOutcome.existing.periodStart} → ${historicalOutcome.existing.periodEnd}). Void that statement or choose a non-overlapping period.`,
        existing: historicalOutcome.existing,
      }, { status: 409 })
    }
    if (historicalOutcome.kind !== 'created') throw new Error('Unexpected historical statement outcome')

    await auditAdmin(who, 'paystatement.historical_issued', {
      entity: 'pay_statement',
      entityId: historicalOutcome.statement.id,
      summary: `Recorded historical pay statement ${historicalOutcome.statement.statementNumber} for ${historicalOutcome.statement.staffName} (${start} → ${end})`,
      meta: {
        statementNumber: historicalOutcome.statement.statementNumber,
        staffId,
        periodStart: start,
        periodEnd: end,
        statementSource: 'historical_manual',
      },
    })
    const warning = await resolveIssuedCorrection(correctionId, historicalOutcome.statement, actorLabel)
    return NextResponse.json({ ok: true, statement: historicalOutcome.statement, ...(warning ? { warning } : {}) })
  }

  // Preview reads only — it issues nothing, so it never takes the generation lock
  // and can never be blocked by (or block) an in-flight generation.
  if (preview) {
    const snap = await buildSnapshot(staffId, start, end)
    if (!snap) {
      return NextResponse.json({ ok: false, error: 'No completed jobs for this crew member in that period.' }, { status: 400 })
    }
    if ('blockedBy' in snap && snap.blockedBy) {
      return NextResponse.json({ ok: false, error: gapError(snap.blockedBy), payrollGaps: snap.blockedBy }, { status: 409 })
    }
    return NextResponse.json({ ok: true, preview: { staffId, staffName: staff.name, periodStart: start, periodEnd: end, ...snap } })
  }

  // FIN-1: the duplicate check and the write must be ONE atomic step. Everything
  // that decides whether a statement may exist — the duplicate check, the payroll-gap
  // validation, the immutable snapshot, the statement number and the persist — runs
  // inside the per-crew lock, so a second caller cannot pass the duplicate/overlap
  // check while the first is still generating. Losers return before any number is
  // allocated, so a blocked request never consumes a statement number.
  let outcome: GenerateOutcome
  try {
    outcome = await withPayStatementLock({ staffId, periodStart: start, periodEnd: end }, async (lock) => {
      const existing = await findByPeriod(staffId, start, end)
      if (existing) return { kind: 'duplicate', existing } as const
      const overlap = await findOverlappingStatement(staffId, start, end)
      if (overlap) return { kind: 'overlap', existing: overlap } as const

      const snap = await buildSnapshot(staffId, start, end)
      if (!snap) return { kind: 'no_activity' } as const
      if ('blockedBy' in snap && snap.blockedBy) return { kind: 'payroll_gap', gaps: snap.blockedBy } as const

      // The snapshot above is the long part of this section (thousands of KV reads,
      // proportional to store size). Re-verify the lease before the FIRST write, so a
      // generation that outlived its lock aborts instead of issuing a duplicate.
      await lock.assertHeld()

      const now = Date.now()
      const statement: PayStatement = {
        id: newStatementId(),
        statementNumber: '',
        staffId,
        staffName: staff.name,
        contractorAddress: staff.address,
        businessAddress,
        periodStart: start,
        periodEnd: end,
        grossCents: snap.grossCents,
        deductionCents: snap.deductionCents,
        netCents: snap.netCents,
        routeCount: snap.routeCount,
        lines: snap.lines,
        deductions: snap.deductions,
        statementSource: 'operion_generated',
        paymentDate: scheduledPayDate(end),
        status: 'issued',
        issuedBy: actorLabel,
        issuedAt: now,
        updatedAt: now,
      }
      const issued = await issueStatement(statement)
      return { kind: 'created', statement: issued } as const
    })
  } catch (err) {
    // Ordinary contention is not an error condition: the lock is held by another
    // generation for this crew member, or this caller's lease lapsed before
    // it could write (nothing was written — it aborted). 423 Locked, never a 500.
    if (err instanceof StatementGenerationBusyError || err instanceof StatementLockLostError) {
      return NextResponse.json({
        ok: false,
        reason: 'generation_in_progress',
        error: 'A statement for this crew member and period is already being generated. Try again in a moment.',
      }, { status: 423 })
    }
    throw err
  }

  switch (outcome.kind) {
    case 'no_activity':
      return NextResponse.json({ ok: false, error: 'No completed jobs for this crew member in that period.' }, { status: 400 })
    case 'payroll_gap':
      return NextResponse.json({ ok: false, error: gapError(outcome.gaps), payrollGaps: outcome.gaps }, { status: 409 })
    case 'duplicate':
      return NextResponse.json({
        ok: false,
        reason: 'duplicate_period',
        error: `A statement for this period already exists (${outcome.existing.statementNumber}). Void it first to re-issue.`,
        existing: outcome.existing,
      }, { status: 409 })
    case 'overlap':
      return NextResponse.json({
        ok: false,
        reason: 'overlapping_period',
        error: `This period overlaps ${outcome.existing.statementNumber} (${outcome.existing.periodStart} → ${outcome.existing.periodEnd}). Void that statement or choose a non-overlapping period.`,
        existing: outcome.existing,
      }, { status: 409 })
    case 'created':
      // Post-commit and fail-open (auditAdmin swallows its own errors). Emitted only
      // on the one request that actually issued — blocked duplicates record nothing.
      await auditAdmin(who, 'paystatement.issued', {
        entity: 'pay_statement',
        entityId: outcome.statement.id,
        summary: `Issued pay statement ${outcome.statement.statementNumber} for ${outcome.statement.staffName} (${start} → ${end})`,
        meta: { statementNumber: outcome.statement.statementNumber, staffId, periodStart: start, periodEnd: end },
      })
      const warning = await resolveIssuedCorrection(correctionId, outcome.statement, actorLabel)
      return NextResponse.json({ ok: true, statement: outcome.statement, ...(warning ? { warning } : {}) })
  }
})
