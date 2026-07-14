import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { requireSession } from '../_lib/session'

// Client-upload token broker for invoice photos. The admin form uploads files
// straight to Vercel Blob; this route only mints a short-lived upload token and
// is gated to a signed-in admin session (the onUploadCompleted webhook from Blob
// carries no cookie, so auth lives in onBeforeGenerateToken).
export const POST = withTenantRoute(async (req: NextRequest): Promise<NextResponse>  => {
  const body = (await req.json()) as HandleUploadBody
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => {
        if (!(await requireSession(req))) throw new Error('unauthorized')
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'],
          maximumSizeInBytes: 15 * 1024 * 1024, // 15 MB per photo
          addRandomSuffix: true,
        }
      },
      onUploadCompleted: async () => { /* nothing to persist here — the URL is saved with the booking */ },
    })
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'upload failed'
    return NextResponse.json({ error: msg }, { status: msg === 'unauthorized' ? 401 : 400 })
  }
})
