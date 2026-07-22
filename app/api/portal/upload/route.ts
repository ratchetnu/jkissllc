import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { requireCrew } from '../_lib/crew'
import { isEnabled } from '../../../lib/platform/flags'

// Client-upload token broker for CREW completion photos, mirroring the admin
// broker (api/admin/blob-upload) with one difference: it admits a crew principal
// and only a crew principal. The admin broker deliberately rejects crew, so field
// uploads needed their own gate rather than a loosened one.
//
// The Blob onUploadCompleted webhook carries no cookie, so the token mint IS the
// authorization point — hence the session check inside onBeforeGenerateToken.
// Photos are only ever attached to a job through /api/portal/jobs/[id], which
// re-verifies that the caller is assigned to that job; a minted token by itself
// grants nothing but the ability to store bytes.
export const POST = withTenantRoute(async (req: NextRequest): Promise<NextResponse> => {
  if (!isEnabled('BOOKING_ASSIGNMENT_ENABLED')) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const body = (await req.json()) as HandleUploadBody
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => {
        if ((await requireCrew(req)) instanceof NextResponse) throw new Error('unauthorized')
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
          maximumSizeInBytes: 15 * 1024 * 1024,   // 15 MB — a phone photo, not a video
          addRandomSuffix: true,
        }
      },
      onUploadCompleted: async () => { /* the URL is persisted with the job, not here */ },
    })
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'upload failed'
    return NextResponse.json({ error: msg }, { status: msg === 'unauthorized' ? 401 : 400 })
  }
})
