import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../../lib/rate-limit'
import { getApplicant } from '../../../../lib/applicants'
import { verifyContractorOnboardingToken } from '../../../../lib/applicant-workflow'
import { emailRaw } from '../../../../lib/booking-emails'
import { escapeHtml } from '../../../../lib/validators'
import { COMPANY } from '../../../../lib/company'
import { isBlockedBot } from '../../../../lib/botcheck'
import {
  issueElectronicSignatureCode,
  revokeElectronicSignatureCode,
} from '../../../../lib/contractor-electronic-signature'

export const runtime = 'nodejs'

export const POST = withTenantRoute(async (req: NextRequest) => {
  if (await rateLimit(req, 'contractor-signature-code', 5, 30 * 60_000)) {
    return NextResponse.json({ error: 'Too many code requests. Please wait and try again.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Request blocked.' }, { status: 403 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const token = typeof body.token === 'string' ? body.token : ''
  const claims = verifyContractorOnboardingToken(token)
  if (!claims) return NextResponse.json({ error: 'This onboarding link is invalid or expired.' }, { status: 404 })
  const applicant = await getApplicant(claims.applicantId)
  if (!applicant || applicant.status !== 'hired' || applicant.contractEndedAt
      || applicant.email.trim().toLowerCase() !== claims.email
      || applicant.contractorOnboarding?.requestedAt !== claims.requestedAt) {
    return NextResponse.json({ error: 'This onboarding link is no longer current.' }, { status: 404 })
  }
  if (!applicant.contractorOnboarding.agreementDownloadedAt) {
    return NextResponse.json({ error: 'Download and review the agreement before requesting a signing code.' }, { status: 409 })
  }
  const issued = await issueElectronicSignatureCode({ applicantId: applicant.id, requestedAt: claims.requestedAt })
  const delivery = await emailRaw({
    to: [applicant.email],
    subject: `${COMPANY.legalName} agreement signing code`,
    html: `<p>Hi ${escapeHtml(applicant.name)},</p><p>Your one-time agreement signing code is:</p><p style="font-size:28px;font-weight:800;letter-spacing:6px">${issued.code}</p><p>This code expires in 10 minutes. If you did not request it, do not share it.</p>`,
  })
  if (!delivery.ok) {
    await revokeElectronicSignatureCode(applicant.id)
    return NextResponse.json({ error: 'The signing code could not be emailed. Please try again.' }, { status: 502 })
  }
  return NextResponse.json({ ok: true, expiresAt: issued.expiresAt })
})
