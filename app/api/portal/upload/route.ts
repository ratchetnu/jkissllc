import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { issueSignedToken, parseStoreIdFromDelegationToken } from '@vercel/blob'
import { handleUploadPresigned, type HandleUploadPresignedBody } from '@vercel/blob/client'
import { getVercelOidcToken } from '@vercel/oidc'
import { requireCrew } from '../_lib/crew'
import { completionUploadReadiness } from '../../../lib/job-assignment'
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
// A crew member in a driveway needs to know WHICH kind of failure this is: one they
// can retry (signal) or one only the office can fix (configuration). Previously
// every failure surfaced as a generic "Upload failed", so a missing BLOB_STORE_ID
// was indistinguishable from a dead cell tower and would be retried forever.
//
// Each entry maps an internal cause to a stable code plus a message safe to show a
// crew member. Anything NOT listed falls through to a generic 400 — internal error
// text from the Blob SDK is never echoed to a client.
const FAILURES: Record<string, { status: number; message: string }> = {
  // Configuration, not the caller's fault: 503, because the server is genuinely
  // not able to serve this yet and retrying the same request will not help.
  blob_store_not_configured: {
    status: 503,
    message: 'Photo uploads aren’t set up on this deployment yet. Tell the office — retrying won’t help.',
  },
  blob_store_mismatch: {
    status: 503,
    message: 'Photo uploads are misconfigured on this deployment. Tell the office — retrying won’t help.',
  },
  unauthorized: { status: 401, message: 'Sign in again to upload photos.' },
}

export const POST = withTenantRoute(async (req: NextRequest): Promise<NextResponse> => {
  if (!isEnabled('BOOKING_ASSIGNMENT_ENABLED')) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    // Parsed INSIDE the boundary: a malformed body is a client error like any
    // other, and must collapse to the same safe 400 shape. Parsing it outside
    // meant a truncated upload POST — a phone losing signal mid-request is the
    // ordinary way this happens — escaped as an unhandled 500.
    const body = (await req.json()) as HandleUploadPresignedBody
    const result = await handleUploadPresigned({
      body,
      request: req,
      getSignedToken: async (pathname) => {
        if ((await requireCrew(req)) instanceof NextResponse) throw new Error('unauthorized')
        // Never let the SDK fall back to a different store's legacy token. Preview
        // and Production are intentionally isolated; the signed token must name
        // the store explicitly connected to this deployment.
        const readiness = completionUploadReadiness(process.env.BLOB_STORE_ID)
        if (!readiness.ready) throw new Error(readiness.reason)
        const { storeId } = readiness
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
    const cause = err instanceof Error ? err.message : ''
    const known = FAILURES[cause]
    if (known) {
      // Log the real cause server-side; the client gets the code and a safe message.
      if (known.status >= 500) console.error('[portal/upload] misconfigured:', cause)
      return NextResponse.json({ error: cause, message: known.message }, { status: known.status })
    }
    return NextResponse.json(
      { error: 'upload_failed', message: 'Upload failed — check your signal and try again.' },
      { status: 400 },
    )
  }
})
