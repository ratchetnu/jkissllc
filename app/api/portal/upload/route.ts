import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { issueSignedToken, parseStoreIdFromDelegationToken } from '@vercel/blob'
import { handleUploadPresigned, type HandleUploadPresignedBody } from '@vercel/blob/client'
import { getVercelOidcToken } from '@vercel/oidc'
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
        // Never let the SDK fall back to a different store's legacy token. Preview
        // and Production are intentionally isolated; the signed token must name
        // the store explicitly connected to this deployment.
        const storeId = process.env.BLOB_STORE_ID?.trim()
        if (!storeId) throw new Error('blob_store_not_configured')
        const oidcToken = await getVercelOidcToken()
        if (!oidcToken) throw new Error('blob_store_not_configured')
        const allowedContentTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
        const maximumSizeInBytes = 15 * 1024 * 1024
        const signedToken = await issueSignedToken({
          oidcToken,
          storeId,
          pathname,
          operations: ['put'],
          allowedContentTypes,
          maximumSizeInBytes,
        })
        const expectedStoreId = storeId.replace(/^store_/, '')
        if (parseStoreIdFromDelegationToken(signedToken.delegationToken) !== expectedStoreId) {
          throw new Error('blob_store_mismatch')
        }
        return {
          token: signedToken,
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
