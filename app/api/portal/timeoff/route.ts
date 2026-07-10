import { NextRequest, NextResponse } from 'next/server'
import { requireCrew } from '../_lib/crew'
import { createRequest, listForStaff, cancelRequest, isLateRequest } from '../../../lib/timeoff'
import { getStaff } from '../../../lib/staff'
import { sendOwnerAlert } from '../../../lib/owner-alerts'
import { isDateStr } from '../../../lib/dates'
import { COMPANY } from '../../../lib/company'

// Crew manage their OWN time-off requests. staffId is always the token's — never
// from the body.
export async function GET(req: NextRequest) {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json({ ok: true, requests: await listForStaff(who.staffId) })
}

export async function POST(req: NextRequest) {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({}))
  const startDate = String(body?.startDate ?? '')
  const endDate = String(body?.endDate ?? startDate)
  const partial = !!body?.partial
  const startTime = partial ? String(body?.startTime ?? '') : undefined
  const endTime = partial ? String(body?.endTime ?? '') : undefined
  const reason = typeof body?.reason === 'string' ? body.reason : undefined
  const submit = body?.submit !== false // default true

  if (!isDateStr(startDate)) return NextResponse.json({ ok: false, error: 'A valid start date is required.' }, { status: 400 })
  if (endDate && !isDateStr(endDate)) return NextResponse.json({ ok: false, error: 'A valid end date is required.' }, { status: 400 })

  // 24-hour policy: a late request MUST include a reason.
  const late = isLateRequest(startDate, startTime, Date.now())
  if (submit && late && !reason?.trim()) {
    return NextResponse.json({ ok: false, error: 'This is a late request (within 24 hours). Please include a reason.', late: true }, { status: 400 })
  }

  const staff = await getStaff(who.staffId)
  const request = await createRequest({
    staffId: who.staffId, staffName: staff?.name,
    startDate, endDate, partial, startTime, endTime, reason, submit,
  })

  // Notify management on a submitted LATE request (best-effort, never blocks).
  if (submit && request.isLate) {
    const range = request.startDate === request.endDate ? request.startDate : `${request.startDate} → ${request.endDate}`
    sendOwnerAlert({
      smsBody: `${COMPANY.legalName}: LATE time-off request from ${staff?.name ?? 'a crew member'} for ${range}. Reason: ${request.reason ?? '—'}. Review in Operations.`,
      emailSubject: `Late time-off request — ${staff?.name ?? 'Crew'}`,
      emailHtml: `<p><strong>${staff?.name ?? 'A crew member'}</strong> submitted a <strong>late</strong> time-off request (within 24 hours).</p><p>Dates: ${range}<br/>Reason: ${request.reason ?? '—'}</p><p>Review it in Operations → Time Off.</p>`,
    }).catch(() => {})
  }

  return NextResponse.json({ ok: true, request, late: request.isLate })
}

export async function PATCH(req: NextRequest) {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const id = String(body?.id ?? '')
  if (body?.action !== 'cancel' || !id) {
    return NextResponse.json({ ok: false, error: 'Unsupported action.' }, { status: 400 })
  }
  const request = await cancelRequest(id, who.staffId)
  if (!request) return NextResponse.json({ ok: false, error: 'Request not found.' }, { status: 404 })
  return NextResponse.json({ ok: true, request })
}
