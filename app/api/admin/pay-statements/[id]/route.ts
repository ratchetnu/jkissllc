import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { getStatement, saveStatement, voidStatement, type VoidOutcome } from '../../../../lib/pay-statements'
import { withPayStatementLock, StatementGenerationBusyError, StatementLockLostError } from '../../../../lib/pay-statement-mutex'
import { auditAdmin } from '../../../../lib/audit'
import { getStaff } from '../../../../lib/staff'
import { emailRaw } from '../../../../lib/booking-emails'
import { renderStatementEmail } from '../../../../lib/statement-render'
import { COMPANY } from '../../../../lib/company'

export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePermission(req, 'pay:view:all')
  if (who instanceof NextResponse) return who
  const { id } = await params
  const statement = await getStatement(id)
  if (!statement) return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 })
  return NextResponse.json({ ok: true, statement })
})

export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePermission(req, 'pay:generate')
  if (who instanceof NextResponse) return who
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const statement = await getStatement(id)
  if (!statement) return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 })

  if (body?.action === 'void') {
    // FIN-2: void takes the SAME per-(tenant, staff, period) lock as generation, so a
    // void can never interleave with the duplicate check it is about to invalidate,
    // and two voids of one statement converge. The statement loaded above only
    // supplies the lock scope — the authoritative status read happens inside the lock.
    let outcome: VoidOutcome
    try {
      outcome = await withPayStatementLock(
        { staffId: statement.staffId, periodStart: statement.periodStart, periodEnd: statement.periodEnd },
        (lock) => voidStatement(id, { beforeWrite: lock.assertHeld }),
      )
    } catch (err) {
      // Ordinary contention (a generation or another void holds the period) is not an
      // error condition. 423 Locked, never a 500.
      if (err instanceof StatementGenerationBusyError || err instanceof StatementLockLostError) {
        return NextResponse.json({
          ok: false,
          reason: 'statement_busy',
          error: 'This crew member’s period is being updated right now. Try again in a moment.',
        }, { status: 423 })
      }
      throw err
    }

    if (outcome.kind === 'not_found') return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 })
    if (outcome.kind === 'already_void') {
      // Truthful idempotent no-op: nothing changed, so nothing is audited.
      return NextResponse.json({ ok: true, statement: outcome.statement, alreadyVoid: true })
    }
    // Post-commit, fail-open, and only on a real state change — a repeated void
    // records no second event.
    await auditAdmin(who, 'paystatement.voided', {
      entity: 'pay_statement',
      entityId: outcome.statement.id,
      summary: `Voided pay statement ${outcome.statement.statementNumber} for ${outcome.statement.staffName} (${outcome.statement.periodStart} → ${outcome.statement.periodEnd})`,
      meta: {
        statementNumber: outcome.statement.statementNumber,
        staffId: outcome.statement.staffId,
        periodStart: outcome.statement.periodStart,
        periodEnd: outcome.statement.periodEnd,
        freedPeriod: outcome.freedPeriod,   // false = it had already been superseded
      },
    })
    return NextResponse.json({ ok: true, statement: outcome.statement })
  }

  if (body?.action === 'email') {
    const staff = await getStaff(statement.staffId)
    const to = staff?.email
    if (!to) return NextResponse.json({ ok: false, error: 'This crew member has no email on file.' }, { status: 400 })
    await emailRaw({
      to: [to],
      subject: `Pay statement ${statement.statementNumber} — ${COMPANY.legalName}`,
      html: renderStatementEmail(statement),
    })
    statement.emailedAt = Date.now()
    await saveStatement(statement)
    return NextResponse.json({ ok: true, statement })
  }

  return NextResponse.json({ ok: false, error: 'Unsupported action.' }, { status: 400 })
})
