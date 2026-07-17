import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { rateLimit } from '../../../lib/rate-limit'
import { createCorrection, listForStaff } from '../../../lib/pay-corrections'
import { getStaff } from '../../../lib/staff'
import { sendOwnerAlert } from '../../../lib/owner-alerts'
import { COMPANY } from '../../../lib/company'

// Crew raise a pay-correction request (they can't edit pay). Scoped to their own
// staffId. Management reviews it in Operations.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json({ ok: true, corrections: await listForStaff(who.staffId) })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  // Each submission fires an owner SMS + email (below). Throttle so a logged-in crew
  // member can't loop this to drain the SMS/email budget or flood the owner.
  if (await rateLimit(req, 'paycorrection', 5, 60 * 60_000)) {
    return NextResponse.json({ ok: false, error: 'Too many requests. Please try again later.' }, { status: 429 })
  }

  const body = await req.json().catch(() => ({}))
  // Cap the free-text so an oversized payload can't bloat storage or the alert email.
  const message = String(body?.message ?? '').trim().slice(0, 2000)
  if (!message) return NextResponse.json({ ok: false, error: 'Please describe what looks wrong.' }, { status: 400 })

  const staff = await getStaff(who.staffId)
  const correction = await createCorrection({
    staffId: who.staffId,
    staffName: staff?.name,
    statementNumber: body?.statementNumber ? String(body.statementNumber) : undefined,
    periodStart: body?.periodStart ? String(body.periodStart) : undefined,
    periodEnd: body?.periodEnd ? String(body.periodEnd) : undefined,
    message,
  })

  sendOwnerAlert({
    smsBody: `${COMPANY.legalName}: pay correction request from ${staff?.name ?? 'a crew member'}${correction.statementNumber ? ` re ${correction.statementNumber}` : ''}. Review in Operations → Pay.`,
    emailSubject: `Pay correction request — ${staff?.name ?? 'Crew'}`,
    emailHtml: `<p><strong>${staff?.name ?? 'A crew member'}</strong> requested a pay correction${correction.statementNumber ? ` for statement ${correction.statementNumber}` : ''}.</p><p>${message.replace(/[<>&]/g, '')}</p><p>Review it in Operations → Pay.</p>`,
  }).catch(() => {})

  return NextResponse.json({ ok: true, correction })
})
