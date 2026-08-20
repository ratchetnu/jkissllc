import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { getApplicant, pushApplicantEvent, saveApplicant } from '../../../lib/applicants'
import { verifyApplicantInformationToken } from '../../../lib/applicant-workflow'
import { str } from '../../../lib/validators'
import { withLock } from '../../../lib/kv-lock'
import { notifyOwnerOfReply } from '../../../lib/owner-alerts'
import { COMPANY } from '../../../lib/company'

export const runtime = 'nodejs'

function baseUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL || process.env.PUBLIC_BASE_URL || COMPANY.siteUrl).replace(/\/$/, '')
}

function safeApplicant(token: string) {
  const claims = verifyApplicantInformationToken(token)
  if (!claims) return null
  return { claims }
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const token = req.nextUrl.searchParams.get('token') ?? ''
  const verified = safeApplicant(token)
  if (!verified) return NextResponse.json({ error: 'This request link is invalid or expired.' }, { status: 404 })
  const a = await getApplicant(verified.claims.applicantId)
  if (!a || a.email.trim().toLowerCase() !== verified.claims.email
      || a.informationRequest?.requestedAt !== verified.claims.requestedAt) {
    return NextResponse.json({ error: 'This request link is no longer active.' }, { status: 404 })
  }
  return NextResponse.json({
    applicantNumber: a.applicantNumber,
    firstName: a.name.trim().split(/\s+/)[0] || 'Applicant',
    request: a.informationRequest.message,
    submitted: Boolean(a.informationResponse),
  })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  if (await rateLimit(req, 'careers-update', 12, 30 * 60_000)) {
    return NextResponse.json({ error: 'Too many attempts. Please wait and try again.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Submission blocked.' }, { status: 403 })
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const token = typeof body.token === 'string' ? body.token : ''
  const response = str(body.response, 2000) ?? ''
  const verified = safeApplicant(token)
  if (!verified) return NextResponse.json({ error: 'This request link is invalid or expired.' }, { status: 404 })
  if (!response) return NextResponse.json({ error: 'Please enter your response.' }, { status: 400 })

  const result = await withLock(`app:lock:${verified.claims.applicantId}`, async (lock) => {
    const a = await getApplicant(verified.claims.applicantId)
    if (!a || a.email.trim().toLowerCase() !== verified.claims.email
        || a.informationRequest?.requestedAt !== verified.claims.requestedAt) {
      return NextResponse.json({ error: 'This request link is no longer active.' }, { status: 404 })
    }
    if (a.informationResponse) return NextResponse.json({ ok: true, alreadySubmitted: true })
    a.informationResponse = { message: response, submittedAt: Date.now() }
    a.status = 'reviewed'
    pushApplicantEvent(a, 'applicant', 'Requested information submitted', response)
    await lock?.assertHeld()
    await saveApplicant(a)
    return NextResponse.json({ ok: true })
  }, {
    attempts: 8, backoffMs: 75, ttlMs: 20_000, onStoreError: 'busy',
    onBusy: () => NextResponse.json({ error: 'Your application is being updated. Please try again.' }, { status: 423 }),
  })

  if (result.ok) {
    void notifyOwnerOfReply({
      via: 'email', customerName: verified.claims.email, fromEmail: verified.claims.email,
      preview: 'An applicant submitted requested information.', adminUrl: `${baseUrl()}/admin/careers`,
    })
  }
  return result
})
