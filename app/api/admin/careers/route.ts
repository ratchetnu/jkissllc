import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../_lib/session'
import { str } from '../../../lib/validators'
import { saveStaff } from '../../../lib/staff'
import {
  getApplicant, listApplicants, saveApplicant, deleteApplicant, rescore,
  type ApplicantStatus, type Recommendation,
} from '../../../lib/applicants'
import { POSITIONS } from '../../../lib/ats-config'

export const runtime = 'nodejs'

const STATUSES = new Set<ApplicantStatus>(['new', 'reviewed', 'interview', 'second_interview', 'waitlist', 'hired', 'rejected'])
const RECS = new Set<Recommendation>(['hire', 'second_interview', 'waitlist', 'reject'])
const REC_TO_STATUS: Record<Recommendation, ApplicantStatus> = {
  hire: 'hired', second_interview: 'second_interview', waitlist: 'waitlist', reject: 'rejected',
}

function unauthorized() { return NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }

// GET /api/admin/careers — list all applicants (newest first).
export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) return unauthorized()
  const applicants = await listApplicants()
  return NextResponse.json({ applicants })
}

// PATCH /api/admin/careers — { id, action, value? } review actions.
export async function PATCH(req: NextRequest) {
  if (!(await requireSession(req))) return unauthorized()
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const id = String(body.id || '')
  const a = await getApplicant(id)
  if (!a) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const action = String(body.action || '')
  switch (action) {
    case 'status':
      if (STATUSES.has(body.value as ApplicantStatus)) a.status = body.value as ApplicantStatus
      break
    case 'notes':
      a.managerNotes = str(body.value, 4000) ?? ''
      break
    case 'recommendation':
      if (RECS.has(body.value as Recommendation)) {
        a.recommendation = body.value as Recommendation
        a.status = REC_TO_STATUS[body.value as Recommendation]
      }
      break
    case 'approve_headshot': {
      const doc = a.documents.find(d => d.kind === 'headshot')
      if (doc) { doc.approved = true; a.badgeHeadshotUrl = doc.url }
      break
    }
    case 'unapprove_headshot': {
      const doc = a.documents.find(d => d.kind === 'headshot')
      if (doc) doc.approved = false
      a.badgeHeadshotUrl = undefined
      break
    }
    case 'rescore':
      rescore(a)
      break
    case 'hire': {
      a.status = 'hired'
      a.recommendation = 'hire'
      if (!a.promotedStaffId) {
        const sid = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
        const now = Date.now()
        await saveStaff({ id: sid, name: a.name, phone: a.phone, role: POSITIONS[a.position].title, active: true, createdAt: now, updatedAt: now })
        a.promotedStaffId = sid
      }
      break
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  await saveApplicant(a)
  return NextResponse.json({ ok: true, applicant: a })
}

// DELETE /api/admin/careers?id=... — remove an applicant record.
export async function DELETE(req: NextRequest) {
  if (!(await requireSession(req))) return unauthorized()
  const id = new URL(req.url).searchParams.get('id') || ''
  await deleteApplicant(id)
  return NextResponse.json({ ok: true })
}
