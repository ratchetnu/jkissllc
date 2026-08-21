import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { can } from '../../../lib/rbac'
import { escapeHtml, str } from '../../../lib/validators'
import { getStaff, saveStaff, findStaffDuplicate } from '../../../lib/staff'
import {
  getApplicant, listApplicants, saveApplicant, rescore,
  pushApplicantEvent, APPLICANT_STATUS_LABEL,
  claimPromotion, commitPromotion, releasePromotionClaim, promotedStaffIdFor, awaitPromotedStaffId,
  type ApplicantStatus, type Recommendation,
} from '../../../lib/applicants'
import { CONTRACTOR_ONBOARDING_DOCS, POSITIONS } from '../../../lib/ats-config'
import { withLock } from '../../../lib/kv-lock'
import { createApplicantInformationToken, createContractorOnboardingToken, transitionApplicantStatus } from '../../../lib/applicant-workflow'
import { emailRaw } from '../../../lib/booking-emails'
import { COMPANY } from '../../../lib/company'
import { getUserByStaffId, setUserActive } from '../../../lib/users'
import { getCurrentContractorAgreement } from '../../../lib/contractor-agreement'
import { auditAdmin } from '../../../lib/audit'
import { missingVerificationDocuments, publishExecutedAgreementToCrewDocuments } from '../../../lib/contractor-onboarding-documents'
import type { Applicant } from '../../../lib/applicants'
import type { Principal } from '../_lib/session'
import { createExecutedAgreement, requestEvidence } from '../../../lib/contractor-electronic-signature'
import { commitPendingContractorUploads } from '../../../lib/contractor-upload-registry'

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

const NO_AGREEMENT_ERROR =
  'No counsel-approved contractor agreement is published. Upload one in Settings → Contractor agreement before sending onboarding.'

type OnboardingRequestResult =
  | { ok: true; requestedAt: number; agreementVersion: number; delivered: boolean; error?: string }
  | { ok: false; status: number; error: string }

/**
 * Issue (or re-issue) a contractor onboarding request on `a`.
 *
 * Two invariants live here so both the approval path and the resend path get them:
 *
 *  1. A request is only ever created when a counsel-approved agreement is PUBLISHED.
 *     Operion must not tell a contractor they can "complete onboarding" and then have
 *     nothing for them to sign.
 *  2. The request PINS the agreement version. Publishing a replacement mints a new
 *     version; this contractor keeps being asked for the one they were sent.
 *
 * A fresh `requestedAt` supersedes every previously issued token, because every token
 * and upload receipt is bound to it.
 */
async function issueOnboardingRequest(a: Applicant, who: Principal): Promise<OnboardingRequestResult> {
  const agreement = await getCurrentContractorAgreement()
  if (!agreement) return { ok: false, status: 409, error: NO_AGREEMENT_ERROR }

  const requestedAt = Date.now()
  const token = createContractorOnboardingToken({ applicantId: a.id, email: a.email, requestedAt })
  const link = `${baseUrl()}/careers/onboarding?token=${encodeURIComponent(token)}`
  const delivery = await emailRaw({
    to: [a.email],
    subject: `${COMPANY.legalName} contractor onboarding — ${a.applicantNumber}`,
    html: `<p>Hi ${escapeHtml(a.name)},</p><p>Your independent-contractor application has been approved. Complete your secure onboarding before accepting work or receiving payment.</p><p><a href="${link}">Complete secure contractor onboarding</a></p><p>The page lets you download the exact J Kiss LLC independent-contractor agreement, consent to electronic records, verify your email with a one-time code, and sign online. You will also upload your completed W-9 and the role-specific documents shown there. Do not upload a Social Security card. This link expires in 7 days and replaces any earlier link.</p><p>— ${COMPANY.legalName} Contractor Operations</p>`,
  })

  a.contractorOnboarding = {
    ...(a.contractorOnboarding ?? {}),
    requestedAt,
    agreementVersion: agreement.version,
    agreementDownloadedAt: undefined,
    electronicSignature: undefined,
    delivery: delivery.ok ? 'sent' : 'failed',
    deliveryAttemptedAt: requestedAt,
    deliveryError: delivery.ok ? undefined : (delivery.error ?? 'Email delivery failed.'),
    // A new request supersedes the previous one; any prior submission belongs to a
    // request that no longer exists.
    submittedAt: undefined,
    verifiedAt: undefined,
    verifiedBy: undefined,
  }
  pushApplicantEvent(a, who.sub,
    delivery.ok ? 'Contractor onboarding link sent' : 'Contractor onboarding email FAILED — resend required',
    `agreement v${agreement.version}`)
  await auditAdmin(who, 'contractor.onboarding_requested', {
    entity: 'applicant',
    entityId: a.id,
    outcome: delivery.ok ? 'success' : 'failure',
    summary: `Contractor onboarding requested for ${a.applicantNumber} (agreement v${agreement.version}).`,
    meta: { applicantNumber: a.applicantNumber, agreementVersion: agreement.version, delivered: delivery.ok },
  })
  return { ok: true, requestedAt, agreementVersion: agreement.version, delivered: delivery.ok, error: delivery.error }
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
  if ((action === 'hire' || action === 'recommendation' || action === 'resend_onboarding' || action === 'countersign_onboarding' || action === 'verify_onboarding' || action === 'legal_hold' || action === 'end_contract' || action === 'reopen_contract' || action === 'confirm_crew_link') && !canDecide) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return withLock(`app:lock:${id}`, async (lock) => {
    const a = await getApplicant(id)
    if (!a) return NextResponse.json({ error: 'not found' }, { status: 404 })
    let linkedExisting = false
    // Surfaced to the admin UI when an action SUCCEEDED but left something the
    // operator must act on — chiefly a failed onboarding email.
    let onboardingWarning: string | undefined
    let generatedAgreementPath: string | undefined
    let countersignAudit: { agreementVersion: number; certificateId: string } | undefined
    switch (action) {
    case 'status': {
      if (!STATUSES.has(body.value as ApplicantStatus)) return NextResponse.json({ error: 'Invalid status.' }, { status: 400 })
      const to = body.value as ApplicantStatus
      if (to === 'archived' && !canDecide) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      const transition = transitionApplicantStatus(a.status, to, { canDecide })
      if (!transition.ok) return NextResponse.json({ error: transition.error }, { status: to === 'hired' ? 400 : 409 })
      const from = a.status
      if (to !== from) pushApplicantEvent(a, who.sub, `Status → ${APPLICANT_STATUS_LABEL[to]}`, `was ${APPLICANT_STATUS_LABEL[from]}`)
      a.status = to
      a.archivedAt = to === 'archived' ? Date.now() : undefined
      // `rejectedAt` belongs to one continuous rejection episode. Reopening review
      // closes that clock; a later rejection starts a new one. The append-only
      // status events above retain the full history of prior decisions.
      if (from === 'rejected' && to !== 'rejected') a.rejectedAt = undefined
      if (to === 'rejected' && from !== 'rejected') a.rejectedAt = Date.now()
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
      if (recommendationStatus === 'hired') return NextResponse.json({ error: 'Use Approve → Contractor/Crew.' }, { status: 400 })
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
      // Approve → create a blocked crew record. Verification activates it later.
      // Idempotent and duplicate-safe: if a crew member
      // already exists for this applicant/email/phone we LINK to it instead of
      // creating a second person, and carry over contact/photo.
      //
      // APP-1: `if (!a.promotedStaffId)` was a check-then-act — three concurrent
      // approvals all read "not promoted" and all minted a person. The promotion is
      // now an atomic claim; only the winner may mint, and losers converge on the
      // winner's staff id instead of creating a rival.
      const statusBeforeHire = a.status
      const recommendationBeforeHire = a.recommendation
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
                // A duplicate that is ALREADY a verified, active crew member links
                // without interruption — they keep working. Anything else would mean
                // pulling a live person off the roster (no assignments, no dispatch,
                // no portal, no ordinary pay) as a side effect of approving a form.
                // That is an explicit admin decision, so approval stops here and
                // changes NOTHING until `confirm_crew_link` is called.
                const alreadyVerified = dup.w9?.status === 'verified' && dup.active
                if (!alreadyVerified && dup.active && !dup.contractorStatus) {
                  await releasePromotionClaim(a.id, claim.token)
                  // Nothing about the roster OR the applicant's decision state moves
                  // until an admin confirms. Only the detected conflict is recorded.
                  a.status = statusBeforeHire
                  a.recommendation = recommendationBeforeHire
                  a.pendingCrewLink = { staffId: dup.id, staffName: dup.name, detectedAt: now }
                  await saveApplicant(a)
                  return NextResponse.json({
                    error: `${dup.name} is already an active crew member whose W-9 is not verified. Linking this application will pause them for onboarding.`,
                    reason: 'crew_link_confirmation_required',
                    pendingCrewLink: { staffId: dup.id, staffName: dup.name },
                    consequence: 'They become unavailable for assignments, dispatch, portal activation, and ordinary pay until an administrator verifies onboarding.',
                  }, { status: 409 })
                }
                promotedId = dup.id
                dup.applicantId = dup.applicantId || a.id
                if (!dup.email && a.email) dup.email = a.email
                if (!dup.photoUrl && a.badgeHeadshotUrl) dup.photoUrl = a.badgeHeadshotUrl
                dup.contractorStatus = alreadyVerified ? 'ready' : 'pending_onboarding'
                dup.onboarding = !alreadyVerified
                dup.active = alreadyVerified ? dup.active : false
                await saveStaff(dup)
                linkedExisting = true
                pushApplicantEvent(a, 'admin', alreadyVerified
                  ? 'Approved — linked to verified crew member'
                  : 'Approved — linked crew record blocked pending onboarding', dup.name)
              } else {
                const sid = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
                await saveStaff({
                  id: sid, name: a.name, phone: a.phone, email: a.email || undefined,
                  role: POSITIONS[a.position].title, photoUrl: a.badgeHeadshotUrl,
                  active: false, applicantId: a.id, onboarding: true,
                  contractorStatus: 'pending_onboarding', payKind: 'contractor',
                  w9: { status: 'not_collected' }, createdAt: now, updatedAt: now,
                })
                promotedId = sid
                pushApplicantEvent(a, 'admin', 'Approved — crew record created (work blocked pending onboarding)')
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
      a.pendingCrewLink = undefined
      if (!a.contractorOnboarding?.requestedAt) {
        const issued = await issueOnboardingRequest(a, who)
        if (!issued.ok) {
          // The crew record exists and is correctly BLOCKED. Nothing was sent, so the
          // approval is reported as incomplete rather than silently half-done.
          await saveApplicant(a)
          return NextResponse.json({
            ok: false, reason: 'agreement_not_published', error: issued.error, applicant: a,
          }, { status: issued.status })
        }
        onboardingWarning = issued.delivered
          ? undefined
          : 'The contractor was approved, but the onboarding email failed to send. Use “Resend onboarding” — they cannot start until they receive the link.'
      }
      break
    }
    case 'confirm_crew_link': {
      // The explicit decision the approval conflict waits for. Admin-only (gated with
      // the other decide-level actions above), idempotent, and serialized by the same
      // per-applicant lock, so two confirmations cannot mint two crew records.
      if (!a.pendingCrewLink) return NextResponse.json({ error: 'There is no crew link awaiting confirmation.' }, { status: 409 })
      const target = await getStaff(a.pendingCrewLink.staffId)
      if (!target) {
        a.pendingCrewLink = undefined
        return NextResponse.json({ error: 'That crew record no longer exists. Re-run the approval.' }, { status: 409 })
      }
      const transition = transitionApplicantStatus(a.status, 'hired', { canDecide, viaHireAction: true })
      if (!transition.ok) return NextResponse.json({ error: transition.error }, { status: 409 })

      const claim = await claimPromotion(a.id)
      let linkedId = a.promotedStaffId ?? (claim.won ? null : claim.staffId ?? await awaitPromotedStaffId(a.id))
      if (claim.won && !linkedId) {
        try {
          target.applicantId = target.applicantId || a.id
          if (!target.email && a.email) target.email = a.email
          if (!target.photoUrl && a.badgeHeadshotUrl) target.photoUrl = a.badgeHeadshotUrl
          target.contractorStatus = 'pending_onboarding'
          target.onboarding = true
          target.active = false
          target.payKind = 'contractor'
          await saveStaff(target)
          await commitPromotion(a.id, target.id)
          linkedId = target.id
        } catch (e) {
          await releasePromotionClaim(a.id, claim.token)
          throw e
        }
      }
      if (!linkedId) return NextResponse.json({ error: 'Crew linking is still in progress. Try again shortly.' }, { status: 423 })

      // Suspend the portal login too — the person is no longer available for work.
      const linkedUser = await getUserByStaffId(linkedId)
      if (linkedUser?.active) await setUserActive(linkedUser.id, false)

      a.status = 'hired'
      a.recommendation = 'hire'
      a.promotedStaffId = linkedId
      a.pendingCrewLink = undefined
      linkedExisting = true
      pushApplicantEvent(a, who.sub, 'Existing crew member linked and paused for onboarding', target.name)
      await auditAdmin(who, 'contractor.crew_link_confirmed', {
        entity: 'applicant',
        entityId: a.id,
        summary: `Linked existing crew member ${target.name} to ${a.applicantNumber} and paused them for onboarding.`,
        meta: { applicantNumber: a.applicantNumber, staffId: linkedId },
      })
      if (!a.contractorOnboarding?.requestedAt) {
        const issued = await issueOnboardingRequest(a, who)
        if (!issued.ok) {
          await saveApplicant(a)
          return NextResponse.json({ ok: false, reason: 'agreement_not_published', error: issued.error, applicant: a }, { status: issued.status })
        }
        onboardingWarning = issued.delivered ? undefined : 'Linked, but the onboarding email failed to send. Use “Resend onboarding”.'
      }
      break
    }
    case 'resend_onboarding': {
      if (a.status !== 'hired' || !a.promotedStaffId) return NextResponse.json({ error: 'Approve the contractor before sending onboarding.' }, { status: 409 })
      if (a.contractEndedAt) return NextResponse.json({ error: 'Reopen the contractor relationship before sending onboarding.' }, { status: 409 })
      if (a.contractorOnboarding?.submittedAt) {
        return NextResponse.json({ error: 'Onboarding is already submitted. Review and countersign it instead of replacing its signed agreement.' }, { status: 409 })
      }
      // A resend mints a fresh `requestedAt`, which supersedes the previous token and
      // every upload receipt bound to it, and re-pins the CURRENT agreement version.
      const issued = await issueOnboardingRequest(a, who)
      if (!issued.ok) {
        await saveApplicant(a)
        return NextResponse.json({ ok: false, reason: 'agreement_not_published', error: issued.error }, { status: issued.status })
      }
      if (!issued.delivered) {
        await saveApplicant(a)   // keep the failure visible on the record
        return NextResponse.json({
          ok: false, reason: 'onboarding_email_failed',
          error: 'The contractor was not emailed. Check email configuration and try again.',
          applicant: a,
        }, { status: 502 })
      }
      break
    }
    case 'countersign_onboarding': {
      const onboarding = a.contractorOnboarding
      if (!onboarding?.submittedAt || !onboarding.agreementVersion || !onboarding.electronicSignature?.contractor) {
        return NextResponse.json({ error: 'The contractor has not electronically signed this agreement.' }, { status: 409 })
      }
      if (a.contractEndedAt) return NextResponse.json({ error: 'Reopen the contractor relationship before countersigning.' }, { status: 409 })
      const value = body.value && typeof body.value === 'object' ? body.value as Record<string, unknown> : {}
      const signatureName = str(value.signatureName, 120) ?? ''
      const signatureTitle = str(value.title, 100) ?? ''
      if (value.intent !== true || signatureName.length < 2 || signatureTitle.length < 2) {
        return NextResponse.json({ error: 'Enter your legal name and title, then confirm your intent and authority to countersign.' }, { status: 400 })
      }
      if (onboarding.electronicSignature.company && a.documents.some(doc => doc.kind === 'contractor_agreement')) break
      const company = {
        name: signatureName,
        title: signatureTitle,
        actorId: who.sub,
        signedAt: Date.now(),
        ...requestEvidence(req),
      }
      await lock?.assertHeld()
      let executed: Awaited<ReturnType<typeof createExecutedAgreement>>
      try {
        executed = await createExecutedAgreement({ applicant: a, company })
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message === 'ELECTRONIC_SIGNATURE_CRYPTO_UNAVAILABLE') {
          return NextResponse.json({ error: 'Secure signing storage is unavailable. Nothing was countersigned.' }, { status: 503 })
        }
        if (message === 'AGREEMENT_VERSION_MISMATCH' || message === 'AGREEMENT_TEMPLATE_HASH_MISMATCH') {
          return NextResponse.json({
            error: 'The published agreement no longer matches this onboarding request. Resend onboarding before countersigning.',
            reason: 'agreement_integrity_error',
          }, { status: 409 })
        }
        console.error('[careers] executed agreement build', { applicantId: a.id, error })
        return NextResponse.json({
          error: 'The published agreement cannot be converted into a signed PDF. Publish a valid agreement and resend onboarding.',
          reason: 'agreement_pdf_invalid',
        }, { status: 422 })
      }
      await lock?.assertHeld()
      a.documents = [
        ...a.documents.filter(doc => doc.kind !== 'contractor_agreement'),
        executed.document,
      ]
      onboarding.documentKinds = Array.from(new Set([...(onboarding.documentKinds ?? []), 'contractor_agreement']))
      onboarding.electronicSignature = {
        ...onboarding.electronicSignature,
        company,
        certificateId: executed.certificateId,
        executedSha256: executed.executedSha256,
      }
      generatedAgreementPath = executed.document.url
      pushApplicantEvent(a, who.sub, 'Contractor agreement countersigned', `certificate ${executed.certificateId}`)
      countersignAudit = { agreementVersion: onboarding.agreementVersion, certificateId: executed.certificateId }
      break
    }
    case 'verify_onboarding': {
      if (!a.contractorOnboarding?.submittedAt || !a.promotedStaffId) return NextResponse.json({ error: 'Contractor onboarding has not been submitted.' }, { status: 409 })
      if (a.contractEndedAt) return NextResponse.json({ error: 'Reopen the contractor relationship before verifying onboarding.' }, { status: 409 })
      const staff = await getStaff(a.promotedStaffId)
      if (!staff) return NextResponse.json({ error: 'Linked contractor record not found.' }, { status: 409 })
      // Verification is the ONLY thing that makes a contractor employable, so it
      // refuses to run on an incomplete file: the request must have pinned an
      // agreement version, and the executed agreement, W-9, and role-specific
      // documents must all actually be present on the record.
      if (!a.contractorOnboarding.agreementVersion) {
        return NextResponse.json({
          error: 'This onboarding request has no contractor agreement attached. Resend onboarding after publishing an agreement.',
          reason: 'agreement_not_pinned',
        }, { status: 409 })
      }
      if (!a.contractorOnboarding.electronicSignature?.company) {
        return NextResponse.json({
          error: 'An authorized administrator must countersign the contractor agreement before verification.',
          reason: 'company_signature_missing',
        }, { status: 409 })
      }
      const missing = missingVerificationDocuments(a, CONTRACTOR_ONBOARDING_DOCS[a.position].map(d => d.kind))
      if (missing.length) {
        return NextResponse.json({
          error: `Cannot verify: missing ${missing.join(', ')}.`,
          reason: 'documents_missing', missing,
        }, { status: 409 })
      }
      const now = Date.now()
      a.contractorOnboarding.verifiedAt = now
      a.contractorOnboarding.verifiedBy = who.sub
      staff.onboarding = false
      staff.contractorStatus = 'ready'
      staff.active = true
      staff.payKind = 'contractor'
      staff.w9 = { ...(staff.w9 ?? { status: 'on_file' }), status: 'verified' }
      await saveStaff(staff)
      const crewUser = await getUserByStaffId(staff.id)
      if (crewUser && !crewUser.active) await setUserActive(crewUser.id, true)
      // Give the contractor their OWN executed agreement in the portal. Best-effort:
      // a storage hiccup must not un-verify someone whose paperwork is in order.
      try {
        await publishExecutedAgreementToCrewDocuments({ applicant: a, publishedBy: who.sub })
      } catch (error) {
        console.error('[careers] executed agreement publish', { applicantId: a.id, error })
        onboardingWarning = 'Verified, but the executed agreement could not be copied to their crew documents. Re-verify to retry.'
      }
      pushApplicantEvent(a, who.sub, 'Contractor onboarding verified', `agreement v${a.contractorOnboarding.agreementVersion}`)
      await auditAdmin(who, 'contractor.onboarding_verified', {
        entity: 'applicant',
        entityId: a.id,
        summary: `Verified contractor onboarding for ${a.applicantNumber}.`,
        meta: {
          applicantNumber: a.applicantNumber,
          staffId: staff.id,
          agreementVersion: a.contractorOnboarding.agreementVersion,
          documentKinds: a.contractorOnboarding.documentKinds,
        },
      })
      break
    }
    case 'legal_hold': {
      const value = body.value && typeof body.value === 'object' ? body.value as Record<string, unknown> : {}
      const active = value.active === true
      const reason = str(value.reason, 500) ?? ''
      if (active && !reason) return NextResponse.json({ error: 'A legal-hold reason is required.' }, { status: 400 })
      const now = Date.now()
      a.legalHold = active
        ? { active: true, placedAt: now, placedBy: who.sub, reason }
        : { ...(a.legalHold ?? { placedAt: now, placedBy: who.sub, reason: 'Released' }), active: false, releasedAt: now, releasedBy: who.sub }
      pushApplicantEvent(a, who.sub, active ? 'Legal hold placed' : 'Legal hold released', active ? reason : undefined)
      break
    }
    case 'end_contract': {
      if (a.status !== 'hired' || !a.promotedStaffId) return NextResponse.json({ error: 'Only an approved contractor relationship can be ended.' }, { status: 409 })
      const staff = await getStaff(a.promotedStaffId)
      if (!staff) return NextResponse.json({ error: 'Linked contractor record not found.' }, { status: 409 })
      if (!a.contractEndedAt) {
        a.contractEndedAt = Date.now()
        staff.active = false
        staff.onboarding = false
        staff.contractorStatus = 'ended'
        await saveStaff(staff)
        const crewUser = await getUserByStaffId(staff.id)
        if (crewUser?.active) await setUserActive(crewUser.id, false)
        pushApplicantEvent(a, who.sub, 'Contractor relationship ended')
      }
      break
    }
    case 'reopen_contract': {
      if (!a.contractEndedAt || !a.promotedStaffId) return NextResponse.json({ error: 'This contractor relationship is not ended.' }, { status: 409 })
      const staff = await getStaff(a.promotedStaffId)
      if (!staff) return NextResponse.json({ error: 'Linked contractor record not found.' }, { status: 409 })
      a.contractEndedAt = undefined
      const verified = Boolean(a.contractorOnboarding?.verifiedAt && staff.w9?.status === 'verified')
      staff.active = verified
      staff.onboarding = !verified
      staff.contractorStatus = verified
        ? 'ready'
        : a.contractorOnboarding?.submittedAt ? 'pending_verification' : 'pending_onboarding'
      await saveStaff(staff)
      const crewUser = await getUserByStaffId(staff.id)
      if (crewUser && crewUser.active !== verified) await setUserActive(crewUser.id, verified)
      pushApplicantEvent(a, who.sub, verified ? 'Contractor relationship reopened — ready for work' : 'Contractor relationship reopened — onboarding review required')
      break
    }
    default:
      return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }

    await lock?.assertHeld()
    await saveApplicant(a)
    if (countersignAudit) {
      await auditAdmin(who, 'contractor.agreement_countersigned', {
        entity: 'applicant', entityId: a.id,
        summary: `Countersigned agreement v${countersignAudit.agreementVersion} for ${a.applicantNumber}.`,
        meta: { applicantNumber: a.applicantNumber, ...countersignAudit },
      })
    }
    if (generatedAgreementPath) {
      await commitPendingContractorUploads([generatedAgreementPath]).catch(error => console.error('[careers] executed agreement registry commit', error))
    }
    return NextResponse.json({ ok: true, applicant: a, linkedExisting, ...(onboardingWarning ? { warning: onboardingWarning } : {}) })
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
