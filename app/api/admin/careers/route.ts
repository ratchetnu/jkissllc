import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { can } from '../../../lib/rbac'
import { escapeHtml, str } from '../../../lib/validators'
import { saveStaff, findStaffDuplicate } from '../../../lib/staff'
import {
  getApplicant, listApplicants, saveApplicant, rescore,
  pushApplicantEvent, APPLICANT_STATUS_LABEL,
  claimPromotion, commitPromotion, releasePromotionClaim, promotedStaffIdFor, awaitPromotedStaffId,
  type ApplicantStatus, type Recommendation,
} from '../../../lib/applicants'
import { POSITIONS } from '../../../lib/ats-config'
import { withLock } from '../../../lib/kv-lock'
import { createApplicantInformationToken, transitionApplicantStatus } from '../../../lib/applicant-workflow'
import { emailRaw } from '../../../lib/booking-emails'
import { COMPANY } from '../../../lib/company'

export const runtime = 'nodejs'
export const maxDuration = 30

const STATUSES = new Set<ApplicantStatus>(['new', 'reviewed', 'information_requested', 'interview', 'second_interview', 'waitlist', 'hired', 'rejected', 'withdrawn', 'archived'])
const RECS = new Set<Recommendation>(['hire', 'second_interview', 'waitlist', 'reject'])
const REC_TO_STATUS: Record<Recommendation, ApplicantStatus> = {
  hire: 'hired', second_interview: 'second_interview', waitlist: 'waitlist', reject: 'rejected',
}

function baseUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || process.env.PUBLIC_BASE_URL || COMPANY.siteUrl).replace(/\/$/, '')
}

// GET /api/admin/careers — list all applicants (newest first).
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'applicants:review')
  if (who instanceof NextResponse) return who
  const applicants = await listApplicants()
  return NextResponse.json({ applicants, permissions: { canDecide: can(who.role, 'applicants:decide') } })
})

// PATCH /api/admin/careers — { id, action, value? } review actions.
export const PATCH = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'applicants:review')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const id = String(body.id || '')
  const action = String(body.action || '')
  // Terminal decisions (approving a hire, setting the final recommendation) are a
  // decide-level action managers do NOT hold — hiring also mints a crew record.
  // Review-level actions (notes, request info, non-terminal status, rescore,
  // headshot approval) stay open to reviewers.
  const canDecide = can(who.role, 'applicants:decide')
  if ((action === 'hire' || action === 'recommendation') && !canDecide) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return withLock(`app:lock:${id}`, async (lock) => {
    const a = await getApplicant(id)
    if (!a) return NextResponse.json({ error: 'not found' }, { status: 404 })
    let linkedExisting = false
    switch (action) {
    case 'status': {
      if (!STATUSES.has(body.value as ApplicantStatus)) return NextResponse.json({ error: 'Invalid status.' }, { status: 400 })
      const to = body.value as ApplicantStatus
      if (to === 'archived' && !canDecide) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      const transition = transitionApplicantStatus(a.status, to, { canDecide })
      if (!transition.ok) return NextResponse.json({ error: transition.error }, { status: to === 'hired' ? 400 : 409 })
      if (to !== a.status) pushApplicantEvent(a, who.sub, `Status → ${APPLICANT_STATUS_LABEL[to]}`, `was ${APPLICANT_STATUS_LABEL[a.status]}`)
      a.status = to
      a.archivedAt = to === 'archived' ? Date.now() : undefined
      break
    }
    case 'notes':
      a.managerNotes = str(body.value, 4000) ?? ''
      pushApplicantEvent(a, 'admin', 'Internal note updated')
      break
    case 'request_info': {
      // Ask the applicant for missing/corrected info. Records the request + moves the
      // applicant to "Information Requested" on the SAME record (never a duplicate).
      const message = str(body.value, 1000) ?? ''
      if (!message) return NextResponse.json({ error: 'Describe the information you need.' }, { status: 400 })
      const transition = transitionApplicantStatus(a.status, 'information_requested', { canDecide })
      if (!transition.ok) return NextResponse.json({ error: transition.error }, { status: 409 })
      const requestedAt = Date.now()
      const token = createApplicantInformationToken({ applicantId: a.id, email: a.email, requestedAt })
      const link = `${baseUrl()}/careers/update?token=${encodeURIComponent(token)}`
      const delivery = await emailRaw({
        to: [a.email],
        subject: `${COMPANY.legalName} needs more information for application ${a.applicantNumber}`,
        html: `<p>Hi ${escapeHtml(a.name)},</p><p>We need the following information to continue reviewing your application:</p><blockquote>${escapeHtml(message)}</blockquote><p><a href="${link}">Respond securely to this request</a></p><p>This link expires in 7 days.</p><p>— ${COMPANY.legalName} Hiring</p>`,
      })
      if (!delivery.ok) return NextResponse.json({ error: 'The request was not sent. Check email configuration and try again.' }, { status: 502 })
      a.status = 'information_requested'
      a.informationRequest = { message, requestedAt, delivery: 'sent' }
      a.informationResponse = undefined
      pushApplicantEvent(a, who.sub, 'Information requested and emailed', message)
      break
    }
    case 'recommendation': {
      if (!RECS.has(body.value as Recommendation)) return NextResponse.json({ error: 'Invalid recommendation.' }, { status: 400 })
      const recommendation = body.value as Recommendation
      const recommendationStatus = REC_TO_STATUS[recommendation]
      if (recommendationStatus === 'hired') return NextResponse.json({ error: 'Use Approve → Crew to hire an applicant.' }, { status: 400 })
      const recommendationTransition = transitionApplicantStatus(a.status, recommendationStatus, { canDecide })
      if (!recommendationTransition.ok) return NextResponse.json({ error: recommendationTransition.error }, { status: 409 })
      a.recommendation = recommendation
      a.status = recommendationStatus
      pushApplicantEvent(a, who.sub, `Recommendation: ${body.value}`)
      break
    }
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
      const transition = transitionApplicantStatus(a.status, 'hired', { canDecide, viaHireAction: true })
      if (!transition.ok) return NextResponse.json({ error: transition.error }, { status: 409 })
      // Approve → activate as crew. Idempotent and duplicate-safe: if a crew member
      // already exists for this applicant/email/phone we LINK to it instead of
      // creating a second person, and carry over contact/photo.
      //
      // APP-1: `if (!a.promotedStaffId)` was a check-then-act — three concurrent
      // approvals all read "not promoted" and all minted a person. The promotion is
      // now an atomic claim; only the winner may mint, and losers converge on the
      // winner's staff id instead of creating a rival.
      a.status = 'hired'
      a.recommendation = 'hire'
      if (!a.promotedStaffId) {
        // A committed promotion from an earlier (possibly crashed) attempt wins
        // outright — this is also the recovery path when a previous run saved the
        // staff record but died before saving the applicant.
        const committed = await promotedStaffIdFor(a.id)
        if (committed) {
          a.promotedStaffId = committed
          linkedExisting = true
        } else {
          const claim = await claimPromotion(a.id)
          if (!claim.won) {
            // Someone else is promoting this applicant right now. Converge on their
            // record rather than minting a second person.
            const winner = claim.staffId ?? await awaitPromotedStaffId(a.id)
            if (winner) {
              a.promotedStaffId = winner
              linkedExisting = true
            }
            // winner === null → the claimant died before committing; the claim's TTL
            // frees the identity and the next approval promotes cleanly.
          } else {
            const now = Date.now()
            let promotedId: string | null = null
            try {
              const dup = await findStaffDuplicate({ applicantId: a.id, email: a.email, phone: a.phone })
              if (dup) {
                promotedId = dup.id
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
                promotedId = sid
                pushApplicantEvent(a, 'admin', 'Approved — activated as crew (pending onboarding)')
              }
              // Commit BEFORE the applicant save: the mapping is what a loser reads
              // and what a retry recovers from if this request dies below.
              await commitPromotion(a.id, promotedId)
              a.promotedStaffId = promotedId
            } catch (e) {
              // Nothing was promoted — free the identity so a retry can.
              if (!promotedId) await releasePromotionClaim(a.id, claim.token)
              throw e
            }
          }
        }
      }
      if (!a.promotedStaffId) return NextResponse.json({ error: 'Applicant promotion is still in progress. Try again shortly.' }, { status: 423 })
      break
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }

    await lock?.assertHeld()
    await saveApplicant(a)
    return NextResponse.json({ ok: true, applicant: a, linkedExisting })
  }, {
    attempts: 8,
    backoffMs: 75,
    ttlMs: 20_000,
    renew: true,
    onStoreError: 'busy',
    onBusy: () => NextResponse.json({ error: 'This applicant is being updated by someone else. Try again.' }, { status: 423 }),
  })
})

// DELETE /api/admin/careers?id=... — remove an applicant record.
export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'applicants:decide')
  if (who instanceof NextResponse) return who
  return NextResponse.json({ error: 'Applications are retained for audit and privacy handling. Archive the record instead.' }, { status: 409 })
})
