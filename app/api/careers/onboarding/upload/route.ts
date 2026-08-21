import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../../lib/rate-limit'
import { isBlockedBot } from '../../../../lib/botcheck'
import { getApplicant } from '../../../../lib/applicants'
import { isSensitiveDoc, type DocKind } from '../../../../lib/ats-config'
import { docCryptoReady, sealDoc } from '../../../../lib/doc-crypto'
import { scopeBlobPath, sanitizeBlobSegment } from '../../../../lib/platform/tenancy/blob-keys'
import {
  createOnboardingDocumentReceipt,
  verifyContractorOnboardingToken,
} from '../../../../lib/applicant-workflow'
import { registerPendingContractorUpload } from '../../../../lib/contractor-upload-registry'

export const runtime = 'nodejs'
export const maxDuration = 30

// The agreement is no longer accepted as a client upload. Operion creates the
// executed PDF itself after contractor signature + admin countersignature.
const KINDS = new Set<DocKind>(['w9', 'drivers_license', 'insurance', 'headshot'])

// Post-approval only. The signed token is bound to the approved applicant and the
// latest onboarding request. Tax/identity/agreement/insurance bytes are encrypted
// before they reach Blob; only the badge photo is public.
export const POST = withTenantRoute(async (req: NextRequest) => {
  if (await rateLimit(req, 'contractor-onboarding-upload', 30, 15 * 60_000)) {
    return NextResponse.json({ error: 'Too many uploads. Please wait a few minutes.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Upload blocked.' }, { status: 403 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const token = typeof body.token === 'string' ? body.token : ''
  const claims = verifyContractorOnboardingToken(token)
  const kind = typeof body.kind === 'string' && KINDS.has(body.kind as DocKind) ? body.kind as DocKind : null
  if (!claims || !kind) return NextResponse.json({ error: 'This onboarding link is invalid or expired.' }, { status: 404 })

  const applicant = await getApplicant(claims.applicantId)
  if (!applicant || applicant.status !== 'hired' || applicant.contractEndedAt
      || applicant.email.trim().toLowerCase() !== claims.email
      || applicant.contractorOnboarding?.requestedAt !== claims.requestedAt) {
    return NextResponse.json({ error: 'This onboarding link is no longer current.' }, { status: 404 })
  }

  const file = typeof body.file === 'string' ? body.file : ''
  const match = file.match(/^data:(image\/(jpeg|png|webp|heic|heif)|application\/pdf);base64,(.+)$/)
  if (!match || file.length > 16_000_000) {
    return NextResponse.json({ error: 'Attach a PDF or clear image under about 12 MB.' }, { status: 400 })
  }
  const sensitive = isSensitiveDoc(kind)
  if (sensitive && !docCryptoReady()) {
    console.error('[contractor-onboarding-upload] encryption unavailable')
    return NextResponse.json({ error: 'Secure uploads are temporarily unavailable.' }, { status: 503 })
  }

  try {
    const bytes = Buffer.from(match[3], 'base64')
    const ext = match[1] === 'application/pdf' ? 'pdf' : match[2] === 'jpeg' ? 'jpg' : match[2]
    const filename = sanitizeBlobSegment(`${crypto.randomUUID()}.${ext}${sensitive ? '.enc' : ''}`)
    const path = scopeBlobPath(`contractor-docs/${kind}/${filename}`)
    const blob = await put(path, sensitive ? sealDoc(bytes) : bytes, {
      access: 'public',
      contentType: sensitive ? 'application/octet-stream' : match[1],
      addRandomSuffix: false,
    })
    const storedPath = sensitive ? path : blob.url
    const uploadId = crypto.randomUUID()
    await registerPendingContractorUpload({ id: uploadId, applicantId: applicant.id, path: storedPath, createdAt: Date.now() })
    return NextResponse.json({
      ok: true,
      url: storedPath,
      receipt: createOnboardingDocumentReceipt({
        applicantId: applicant.id,
        kind,
        path: storedPath,
        requestedAt: claims.requestedAt,
      }),
    })
  } catch (error) {
    console.error('[contractor-onboarding-upload]', error)
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 })
  }
})
