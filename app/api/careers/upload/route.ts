import { NextResponse } from 'next/server'
import { scopeBlobPath, sanitizeBlobSegment } from '../../../lib/platform/tenancy/blob-keys'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'

export const runtime = 'nodejs'

// Retained for legacy migration/tests. New contractor documents use the signed,
// post-approval /api/careers/onboarding/upload route.
export function driverDocBlobPath(kind: string, id: string, ext: string, sealed: boolean): string {
  const filename = sanitizeBlobSegment(`${id}.${ext}${sealed ? '.enc' : ''}`)
  return scopeBlobPath(`driver-docs/${kind}/${filename}`)
}

// Pre-approval document collection is intentionally closed. In particular, no
// public route accepts Social Security-card, ID, or headshot uploads from applicants.
export const POST = withTenantRoute(async () => {
  return NextResponse.json({
    error: 'Documents are collected only after contractor approval through a secure onboarding link.',
  }, { status: 410 })
})
