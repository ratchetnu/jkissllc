import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { can } from '../../../lib/rbac'
import { str } from '../../../lib/validators'
import { saveStaff, findStaffDuplicate } from '../../../lib/staff'
import {
  getApplicant, listApplicants, saveApplicant, deleteApplicant, rescore,
  pushApplicantEvent, APPLICANT_STATUS_LABEL,
  type ApplicantStatus, type Recommendation,
} from '../../../lib/applicants'
import { POSITIONS } from '../../../lib/ats-config'

export const runtime = 'nodejs'

const STATUSES = new Set<ApplicantStatus>(['new', 'reviewed', 'information_requested', 'interview', 'second_interview', 'waitlist', 'hired', 'rejected', 'withdrawn', 'archived'])
const RECS = new Set<Recommendation>(['hire', 'second_interview', 'waitlist', 'reject'])
const REC_TO_STATUS: Record<Recommendation, ApplicantStatus> = {
  hire: 'hired', second_interview: 'second_interview', waitlist: 'waitlist', reject: 'rejected',
}

// GET /api/admin/careers — list all applicants (newest first).
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'applicants:review')
  if (who instanceof NextResponse) return who
  const applicants = await listApplicants()
  return NextResponse.json({ applicants })
})

// PATCH /api/admin/careers — { id, action, value? } review actions.
export const PATCH = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'applicants:review')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const id = String(body.id || '')
  const a = await getApplicant(id)
  if (!a) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const action = String(body.action || '')
  // Terminal decisions (approving a hire, setting the final recommendation) are a
  // decide-level action managers do NOT hold — hiring also mints a crew record.
  // Review-level actions (notes, request info, non-terminal status, rescore,
  // headshot approval) stay open to reviewers.
  if ((action === 'hire' || action === 'recommendation') && !can(who.role, 'applicants:decide')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  let linkedExisting = false
  switch (action) {
    case 'status':
      if (STATUSES.has(body.value as ApplicantStatus)) {
        const to = body.value as ApplicantStatus
        if (to !== a.status) pushApplicantEvent(a, 'admin', `Status → ${APPLICANT_STATUS_LABEL[to]}`, `was ${APPLICANT_STATUS_LABEL[a.status]}`)
        a.status = to
      }
      break
    case 'notes':
      a.managerNotes = str(body.value, 4000) ?? ''
      pushApplicantEvent(a, 'admin', 'Internal note updated')
      break
    case 'request_info': {
      // Ask the applicant for missing/corrected info. Records the request + moves the
      // applicant to "Information Requested" on the SAME record (never a duplicate).
      a.status = 'information_requested'
      pushApplicantEvent(a, 'admin', 'Information requested', str(body.value, 1000) ?? undefined)
      break
    }
    case 'recommendation':
      if (RECS.has(body.value as Recommendation)) {
        a.recommendation = body.value as Recommendation
        a.status = REC_TO_STATUS[body.value as Recommendation]
        pushApplicantEvent(a, 'admin', `Recommendation: ${body.value}`)
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
      // Approve → activate as crew. Idempotent (promotedStaffId guards re-hiring) and
      // duplicate-safe: if a crew member already exists for this applicant/email/phone
      // we LINK to it instead of creating a second person, and carry over contact/photo.
      a.status = 'hired'
      a.recommendation = 'hire'
      if (!a.promotedStaffId) {
        const now = Date.now()
        const dup = await findStaffDuplicate({ applicantId: a.id, email: a.email, phone: a.phone })
        if (dup) {
          a.promotedStaffId = dup.id
          dup.applicantId = dup.applicantId || a.id
          if (!dup.email && a.email) dup.email = a.email
          if (!dup.photoUrl && a.badgeHeadshotUrl) dup.photoUrl = a.badgeHeadshotUrl
          await saveStaff(dup)
          linkedExisting = true
          pushApplicantEvent(a, 'admin', 'Approved — linked to existing crew member', dup.name)
        } else {
          const sid = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
          await saveStaff({
            id: sid, name: a.name, phone: a.phone, email: a.email || undefined,
            role: POSITIONS[a.position].title, photoUrl: a.badgeHeadshotUrl,
            active: true, applicantId: a.id, onboarding: true, createdAt: now, updatedAt: now,
          })
          a.promotedStaffId = sid
          pushApplicantEvent(a, 'admin', 'Approved — activated as crew (pending onboarding)')
        }
      }
      break
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  await saveApplicant(a)
  return NextResponse.json({ ok: true, applicant: a, linkedExisting })
})

// DELETE /api/admin/careers?id=... — remove an applicant record.
export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'applicants:decide')
  if (who instanceof NextResponse) return who
  const id = new URL(req.url).searchParams.get('id') || ''
  await deleteApplicant(id)
  return NextResponse.json({ ok: true })
})
