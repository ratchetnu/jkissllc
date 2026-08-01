import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { assertClientUploadBlobPath, clientUploadBlobPath } from '../../../lib/platform/tenancy/client-blob-path'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { requireStaffSession } from '../_lib/session'

// Client-upload token broker for invoice photos. The admin form uploads files
// straight to Vercel Blob; this route only mints a short-lived upload token and
// is gated to a signed-in admin session. GET issues the exact tenant-bound
// pathname; POST validates that path again before minting a token.
export const GET = withTenantRoute(async (req: NextRequest): Promise<NextResponse> => {
  const guard = await requireStaffSession(req)
  if (guard instanceof NextResponse) return guard
  const filename = req.nextUrl.searchParams.get('filename') ?? ''
  return NextResponse.json({ pathname: clientUploadBlobPath(filename) })
})

export const POST = withTenantRoute(async (req: NextRequest): Promise<NextResponse>  => {
  const body = (await req.json()) as HandleUploadBody
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // The token mint is the auth point. Staff-only (admin + manager); crew
        // are rejected.
        if ((await requireStaffSession(req)) instanceof NextResponse) throw new Error('unauthorized')
        assertClientUploadBlobPath(pathname)
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif'],
          maximumSizeInBytes: 15 * 1024 * 1024, // 15 MB per photo
          addRandomSuffix: true,
        }
      },
    })
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'upload failed'
    return NextResponse.json({ error: msg }, { status: msg === 'unauthorized' ? 401 : 400 })
  }
})
