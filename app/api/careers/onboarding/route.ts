import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../lib/rate-limit'
import { getApplicant, pushApplicantEvent, saveApplicant, type ApplicantDoc } from '../../../lib/applicants'
import { getStaff, parseStaffAddress, saveStaff } from '../../../lib/staff'
import { CONTRACTOR_ONBOARDING_DOCS, type DocKind } from '../../../lib/ats-config'
import {
  verifyContractorOnboardingToken,
  verifyOnboardingDocumentReceipt,
} from '../../../lib/applicant-workflow'
import { withLock } from '../../../lib/kv-lock'
import { currentTenantId } from '../../../lib/platform/tenancy/context'
import { validSealedApplicantDocumentPath } from '../../../lib/applicant-workflow'
import { commitPendingContractorUploads } from '../../../lib/contractor-upload-registry'
import { getContractorAgreementVersion } from '../../../lib/contractor-agreement'
import {
  consumeElectronicSignatureCode,
  ELECTRONIC_CONSENT_DISCLOSURE,
  ELECTRONIC_CONSENT_VERSION,
  requestEvidence,
} from '../../../lib/contractor-electronic-signature'
import { recordAudit } from '../../../lib/audit'

export const runtime = 'nodejs'
export const maxDuration = 30

const ACCEPTED = new Set<DocKind>(['w9', 'drivers_license', 'insurance', 'headshot'])
const PUBLIC_URL = /^https:\/\/\S+$/

async function resolve(token: string) {
  const claims = verifyContractorOnboardingToken(token)
  if (!claims) return null
  const applicant = await getApplicant(claims.applicantId)
  if (!applicant || applicant.status !== 'hired' || applicant.contractEndedAt || applicant.email.trim().toLowerCase() !== claims.email
      || applicant.contractorOnboarding?.requestedAt !== claims.requestedAt) return null
  return { claims, applicant }
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const found = await resolve(req.nextUrl.searchParams.get('token') ?? '')
  if (!found) return NextResponse.json({ error: 'This onboarding link is invalid, expired, or superseded.' }, { status: 404 })
  const { applicant } = found
  return NextResponse.json({
    ok: true,
    contractor: {
      name: applicant.name,
      email: applicant.email,
      position: applicant.position,
      applicantNumber: applicant.applicantNumber,
      submittedAt: applicant.contractorOnboarding?.submittedAt,
      agreementVersion: applicant.contractorOnboarding?.agreementVersion,
      agreementDownloadedAt: applicant.contractorOnboarding?.agreementDownloadedAt,
      consentVersion: ELECTRONIC_CONSENT_VERSION,
      consentDisclosure: ELECTRONIC_CONSENT_DISCLOSURE,
      requiredDocuments: CONTRACTOR_ONBOARDING_DOCS[applicant.position],
    },
  })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  if (await rateLimit(req, 'contractor-onboarding-submit', 10, 30 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait and try again.' }, { status: 429 })
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const token = typeof body.token === 'string' ? body.token : ''
  const initial = await resolve(token)
  if (!initial) return NextResponse.json({ error: 'This onboarding link is invalid, expired, or superseded.' }, { status: 404 })

  return withLock(`app:lock:${initial.applicant.id}`, async (lock) => {
    const found = await resolve(token)
    if (!found) return NextResponse.json({ error: 'This onboarding link is no longer current.' }, { status: 404 })
    const { applicant, claims } = found
    if (applicant.contractorOnboarding?.submittedAt) {
      await commitPendingContractorUploads(applicant.documents.map(doc => doc.url)).catch(error => console.error('[contractor-onboarding] registry reconcile', error))
      return NextResponse.json({ ok: true, alreadySubmitted: true })
    }

    const legalName = typeof body.legalName === 'string' ? body.legalName.trim().slice(0, 120) : ''
    const businessName = typeof body.businessName === 'string' ? body.businessName.trim().slice(0, 160) : ''
    const taxClassification = body.taxClassification === 'business' ? 'business' : body.taxClassification === 'individual' ? 'individual' : null
    const tinLast4 = typeof body.tinLast4 === 'string' ? body.tinLast4.replace(/\D/g, '').slice(-4) : ''
    const signatureName = typeof body.signatureName === 'string' ? body.signatureName.trim().slice(0, 120) : ''
    const electronicConsent = body.electronicConsent === true
    const intentToSign = body.intentToSign === true
    const informationCertified = body.informationCertified === true
    const signatureCode = typeof body.signatureCode === 'string' ? body.signatureCode.replace(/\D/g, '').slice(0, 6) : ''
    const drivingAuthorized = body.drivingAuthorized === true
    const usesPersonalVehicle = body.usesPersonalVehicle === true
    const addressResult = parseStaffAddress(body.address)
    if (!legalName || !taxClassification || !/^\d{4}$/.test(tinLast4) || !signatureName || !electronicConsent || !intentToSign || !informationCertified || !/^\d{6}$/.test(signatureCode)) {
      return NextResponse.json({ error: 'Complete the legal name, tax classification, tax ID last four, electronic consent, signing intent, signature, and emailed code.' }, { status: 400 })
    }
    if (addressResult.error || !addressResult.address) {
      return NextResponse.json({ error: addressResult.error ?? 'A complete mailing address is required.' }, { status: 400 })
    }
    if (applicant.position === 'driver' && !drivingAuthorized) {
      return NextResponse.json({ error: 'Driving authorization is required for a driver contractor.' }, { status: 400 })
    }
    const onboarding = applicant.contractorOnboarding
    const agreementVersion = onboarding?.agreementVersion
    if (!agreementVersion || !onboarding?.agreementDownloadedAt) {
      return NextResponse.json({ error: 'Download and review the pinned contractor agreement before signing.' }, { status: 409 })
    }
    const agreement = await getContractorAgreementVersion(agreementVersion)
    if (!agreement) return NextResponse.json({ error: 'The agreement for this onboarding request is unavailable.' }, { status: 409 })

    const input = Array.isArray(body.documents) ? body.documents : []
    const documents = new Map<DocKind, ApplicantDoc>()
    for (const item of input) {
      if (!item || typeof item !== 'object') continue
      const raw = item as Record<string, unknown>
      const kind = raw.kind as DocKind
      const url = typeof raw.url === 'string' ? raw.url : ''
      const receipt = typeof raw.receipt === 'string' ? raw.receipt : ''
      if (!ACCEPTED.has(kind) || url.length > 1000 || url.includes('..')) continue
      const validPath = kind === 'headshot' ? PUBLIC_URL.test(url) : validSealedApplicantDocumentPath(url, currentTenantId())
      if (!validPath || !verifyOnboardingDocumentReceipt({ receipt, applicantId: applicant.id, kind, path: url, requestedAt: claims.requestedAt })) continue
      documents.set(kind, { kind, url, uploadedAt: Date.now() })
    }
    const required = CONTRACTOR_ONBOARDING_DOCS[applicant.position].map(d => d.kind)
    if (usesPersonalVehicle) required.push('insurance')
    const missing = required.filter(kind => !documents.has(kind))
    if (missing.length) return NextResponse.json({ error: `Missing required onboarding document: ${missing.join(', ')}.` }, { status: 400 })

    await lock?.assertHeld()
    const codeAccepted = await consumeElectronicSignatureCode({
      applicantId: applicant.id,
      requestedAt: claims.requestedAt,
      code: signatureCode,
    })
    if (!codeAccepted) return NextResponse.json({ error: 'The signing code is invalid, expired, or has already been used.' }, { status: 400 })

    const onboardingKinds = new Set<DocKind>(['w9', 'contractor_agreement', 'drivers_license', 'insurance', 'headshot'])
    applicant.documents = [
      ...applicant.documents.filter(doc => !onboardingKinds.has(doc.kind)),
      ...documents.values(),
    ]
    const headshot = documents.get('headshot')
    if (headshot) applicant.badgeHeadshotUrl = headshot.url
    const now = Date.now()
    const evidence = requestEvidence(req)
    applicant.contractorOnboarding = {
      ...applicant.contractorOnboarding!,
      submittedAt: now,
      legalName,
      businessName: businessName || undefined,
      taxClassification,
      tinLast4,
      signatureName,
      agreementAcceptedAt: now,
      electronicSignature: {
        consentVersion: ELECTRONIC_CONSENT_VERSION,
        consentedAt: now,
        contractor: {
          name: signatureName,
          email: applicant.email.trim().toLowerCase(),
          signedAt: now,
          ...evidence,
          agreementVersion,
          agreementSha256: agreement.sha256,
          requestedAt: claims.requestedAt,
        },
      },
      drivingAuthorized: applicant.position === 'driver' ? drivingAuthorized : undefined,
      usesPersonalVehicle,
      documentKinds: Array.from(documents.keys()),
    }
    pushApplicantEvent(applicant, 'contractor', 'Contractor onboarding submitted')

    const staff = applicant.promotedStaffId ? await getStaff(applicant.promotedStaffId) : null
    if (!staff) return NextResponse.json({ error: 'The linked contractor record could not be found. Contact J Kiss LLC.' }, { status: 409 })
    staff.name = legalName
    staff.address = addressResult.address
    staff.photoUrl = headshot?.url ?? staff.photoUrl
    staff.payKind = 'contractor'
    staff.w9 = { status: 'on_file', addressComplete: true, tinLast4, collectedAt: now }
    staff.onboarding = true
    // Submission is not activation. The contractor remains unavailable for work
    // and pay until an administrator verifies the documents in Operion.
    if (staff.contractorStatus !== 'ready' || !staff.active) {
      staff.contractorStatus = 'pending_verification'
      staff.active = false
    }

    await lock?.assertHeld()
    await saveStaff(staff)
    await saveApplicant(applicant)
    await recordAudit({
      actor: applicant.id,
      actorRole: 'contractor',
      action: 'contractor.agreement_signed',
      entity: 'applicant',
      entityId: applicant.id,
      summary: `Contractor electronically signed agreement v${agreementVersion} for ${applicant.applicantNumber}.`,
      meta: {
        applicantNumber: applicant.applicantNumber,
        agreementVersion,
        agreementSha256: agreement.sha256,
        consentVersion: ELECTRONIC_CONSENT_VERSION,
      },
    })
    await commitPendingContractorUploads(Array.from(documents.values()).map(doc => doc.url)).catch(error => console.error('[contractor-onboarding] registry commit', error))
    return NextResponse.json({ ok: true })
  }, {
    attempts: 8,
    backoffMs: 75,
    ttlMs: 20_000,
    renew: true,
    onStoreError: 'busy',
    onBusy: () => NextResponse.json({ error: 'This onboarding record is being updated. Try again.' }, { status: 423 }),
  })
})
