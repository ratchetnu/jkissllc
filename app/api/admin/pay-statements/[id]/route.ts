import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { getStatement, saveStatement, voidStatement } from '../../../../lib/pay-statements'
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
    const voided = await voidStatement(id)
    return NextResponse.json({ ok: true, statement: voided })
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
