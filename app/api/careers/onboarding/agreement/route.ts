import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../../lib/rate-limit'
import { getApplicant, saveApplicant } from '../../../../lib/applicants'
import { verifyContractorOnboardingToken } from '../../../../lib/applicant-workflow'
import {
  getContractorAgreementVersion,
  readContractorAgreementBytes,
} from '../../../../lib/contractor-agreement'

export const runtime = 'nodejs'
export const maxDuration = 30

// GET /api/careers/onboarding/agreement?token=… — hand ONE approved contractor the
// blank, counsel-approved agreement they were asked to sign.
//
// Everything about which file is served is derived server-side. The caller supplies
// a signed onboarding token and nothing else: no URL, no version, no path. The
// version comes from the applicant's own pinned `contractorOnboarding.agreementVersion`,
// so replacing the published template later cannot change what an outstanding
// request delivers, and a caller cannot ask for a different version.
export const GET = withTenantRoute(async (req: NextRequest) => {
  if (await rateLimit(req, 'contractor-agreement-download', 30, 15 * 60_000)) {
    return NextResponse.json({ error: 'Too many downloads. Please wait a few minutes.' }, { status: 429 })
  }

  const token = req.nextUrl.searchParams.get('token') ?? ''
  const claims = verifyContractorOnboardingToken(token)   // signature + expiry
  if (!claims) return NextResponse.json({ error: 'This onboarding link is invalid or expired.' }, { status: 404 })

  const applicant = await getApplicant(claims.applicantId) // tenant-scoped read
  if (!applicant
      || applicant.status !== 'hired'                                            // still approved
      || applicant.contractEndedAt                                               // relationship not ended
      || applicant.email.trim().toLowerCase() !== claims.email                   // identity
      || applicant.contractorOnboarding?.requestedAt !== claims.requestedAt) {   // current request only
    return NextResponse.json({ error: 'This onboarding link is no longer current.' }, { status: 404 })
  }

  const version = applicant.contractorOnboarding.agreementVersion
  if (!version) {
    return NextResponse.json({
      error: 'No contractor agreement is attached to this onboarding request. Contact J Kiss LLC.',
    }, { status: 409 })
  }
  const template = await getContractorAgreementVersion(version)
  if (!template) {
    return NextResponse.json({
      error: 'The agreement for this onboarding request is unavailable. Contact J Kiss LLC.',
    }, { status: 409 })
  }

  let bytes: Buffer
  try {
    bytes = await readContractorAgreementBytes(template)
  } catch (error) {
    console.error('[contractor-agreement-download]', { version, error })
    return NextResponse.json({ error: 'The agreement could not be opened. Please try again.' }, { status: 502 })
  }

  // Best-effort breadcrumb; never block the download on the write.
  if (!applicant.contractorOnboarding.agreementDownloadedAt) {
    applicant.contractorOnboarding.agreementDownloadedAt = Date.now()
    await saveApplicant(applicant).catch(error => console.error('[contractor-agreement-download] stamp', error))
  }

  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(new Uint8Array(bytes))
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': template.contentType,
      'Content-Disposition': `attachment; filename="contractor-agreement-v${template.version}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  })
})
