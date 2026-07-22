import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { issueSignedToken } from '@vercel/blob'
import { handleUploadPresigned, type HandleUploadPresignedBody } from '@vercel/blob/client'
import { requireCrew } from '../_lib/crew'
import { isEnabled } from '../../../lib/platform/flags'

// Client-upload token broker for CREW completion photos, mirroring the admin
// broker (api/admin/blob-upload) with one difference: it admits a crew principal
// and only a crew principal. The admin broker deliberately rejects crew, so field
// uploads needed their own gate rather than a loosened one.
//
// The Blob onUploadCompleted webhook carries no cookie, so signed-URL issuance IS
// the authorization point — hence the session check inside getSignedToken.
// Photos are only ever attached to a job through /api/portal/jobs/[id], which
// re-verifies that the caller is assigned to that job; a signed URL by itself
// grants nothing but the ability to store bytes.
export const POST = withTenantRoute(async (req: NextRequest): Promise<NextResponse> => {
  if (!isEnabled('BOOKING_ASSIGNMENT_ENABLED')) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const body = (await req.json()) as HandleUploadPresignedBody
  try {
    const result = await handleUploadPresigned({
      body,
      request: req,
      getSignedToken: async (pathname) => {
        if ((await requireCrew(req)) instanceof NextResponse) throw new Error('unauthorized')
        const allowedContentTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
        const maximumSizeInBytes = 15 * 1024 * 1024
        return {
          token: await issueSignedToken({
            pathname,
            operations: ['put'],
            allowedContentTypes,
            maximumSizeInBytes,
          }),
          urlOptions: {
            allowedContentTypes,
            maximumSizeInBytes, // 15 MB — a phone photo, not a video
            addRandomSuffix: true,
          },
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
