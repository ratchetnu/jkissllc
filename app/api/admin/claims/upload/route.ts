import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { requireSession } from '../../_lib/session'

// Client-upload token broker for CLAIM EVIDENCE. The admin uploads on-scene photos,
// videos, and documents straight to Vercel Blob; this route only mints a short-lived
// upload token and is gated to a signed-in admin session (the onUploadCompleted
// webhook from Blob carries no cookie, so auth lives in onBeforeGenerateToken).
//
// Unlike the invoice-photo broker (/api/admin/blob-upload, images only), claim
// evidence must also accept the PDF/photo of a damage report, a lumper receipt, or a
// dashcam clip — so documents and video are allowed here. The claim's `attach` action
// stores the returned URL; kind (photo/video/document) is derived client-side.
export const POST = withTenantRoute(async (req: NextRequest): Promise<NextResponse>  => {
  const body = (await req.json()) as HandleUploadBody
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => {
        if (!(await requireSession(req))) throw new Error('unauthorized')
        return {
          allowedContentTypes: [
            // Photos (phone camera, screenshots)
            'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif',
            // Documents (damage reports, receipts, BOLs, letters)
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain',
            // Video (dashcam / walkaround clips)
            'video/mp4', 'video/quicktime', 'video/webm',
          ],
          maximumSizeInBytes: 50 * 1024 * 1024, // 50 MB — a short dashcam clip fits
          addRandomSuffix: true,
        }
      },
      onUploadCompleted: async () => { /* URL is persisted on the claim via the attach action */ },
    })
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'upload failed'
    return NextResponse.json({ error: msg }, { status: msg === 'unauthorized' ? 401 : 400 })
  }
})
