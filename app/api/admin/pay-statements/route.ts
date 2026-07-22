import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { computePay } from '../../../lib/route-pay'
import { getStaff } from '../../../lib/staff'
import {
  listStatements, findByPeriod, saveStatement, nextStatementNumber, newStatementId,
  type PayStatement, type StatementLine, type StatementDeduction,
} from '../../../lib/pay-statements'
import { roleLabel } from '../../../lib/rbac'
import { isDateStr } from '../../../lib/dates'

// Build the pay figures for ONE crew member over a period from the deterministic
// engine (computePay uses completed routes/bookings + the claims ledger). Returns
// null when the crew member has no activity in the window.
async function buildSnapshot(staffId: string, start: string, end: string) {
  const summary = await computePay(start, end)
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
  const staffId = new URL(req.url).searchParams.get('staffId')
  const all = await listStatements()
  return NextResponse.json({ ok: true, statements: staffId ? all.filter(s => s.staffId === staffId) : all })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'pay:generate')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({}))
  const staffId = String(body?.staffId ?? '')
  const start = String(body?.periodStart ?? '')
  const end = String(body?.periodEnd ?? '')
  const preview = body?.action === 'preview'

  if (!staffId || !isDateStr(start) || !isDateStr(end) || end < start) {
    return NextResponse.json({ ok: false, error: 'Select a crew member and a valid period.' }, { status: 400 })
  }
  const staff = await getStaff(staffId)
  if (!staff) return NextResponse.json({ ok: false, error: 'Crew member not found.' }, { status: 404 })

  const snap = await buildSnapshot(staffId, start, end)
  if (!snap) {
    return NextResponse.json({ ok: false, error: 'No completed jobs for this crew member in that period.' }, { status: 400 })
  }

  if (preview) {
    return NextResponse.json({ ok: true, preview: { staffId, staffName: staff.name, periodStart: start, periodEnd: end, ...snap } })
  }

  // Duplicate prevention: one live statement per crew + exact period.
  const existing = await findByPeriod(staffId, start, end)
  if (existing) {
    return NextResponse.json({ ok: false, error: `A statement for this period already exists (${existing.statementNumber}). Void it first to re-issue.`, existing }, { status: 409 })
  }

  const now = Date.now()
  const statement: PayStatement = {
    id: newStatementId(),
    statementNumber: await nextStatementNumber(),
    staffId,
    staffName: staff.name,
    periodStart: start,
    periodEnd: end,
    grossCents: snap.grossCents,
    deductionCents: snap.deductionCents,
    netCents: snap.netCents,
    routeCount: snap.routeCount,
    lines: snap.lines,
    deductions: snap.deductions,
    status: 'issued',
    issuedBy: who.sub === 'owner' ? 'Owner' : `${roleLabel[who.role]} (${who.sub})`,
    issuedAt: now,
    updatedAt: now,
  }
  await saveStatement(statement)
  return NextResponse.json({ ok: true, statement })
})
