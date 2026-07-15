import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { put } from '@vercel/blob'
import { requireStaffSession } from '../_lib/session'
import { scopeBlobPath, sanitizeBlobSegment } from '../../../lib/platform/tenancy/blob-keys'

export const runtime = 'nodejs'
export const maxDuration = 30

// Tenant-safe physical path for a staff-uploaded ops photo (crew badge, etc.).
// Byte-identical to the legacy `admin-photos/<uuid>.<ext>` while tenancy is off;
// `tenants/<id>/admin-photos/…` once on. Filename sanitized against traversal.
export function adminPhotoBlobPath(id: string, ext: string): string {
  return scopeBlobPath(`admin-photos/${sanitizeBlobSegment(`${id}.${ext}`)}`)
}

// POST /api/admin/upload — staff-gated image upload for ops features (crew badge
// photos, etc.). Same {image: dataURL} → {url} shape as the public /api/upload, but
// behind requireStaffSession (admin + manager, not crew) instead of the
// rate-limit/bot-check the public form uses: an ops feature should ride an
// authenticated path, not the anonymous uploader.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({}))
  const image = typeof body.image === 'string' ? body.image : ''
  const m = image.match(/^data:(image\/(jpeg|png|webp|heic|heif));base64,(.+)$/)
  if (!m || image.length > 8_000_000) {
    return NextResponse.json({ error: 'Please attach a clear photo (JPG/PNG, under ~6MB).' }, { status: 400 })
  }
  try {
    const buf = Buffer.from(m[3], 'base64')
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2]
    const blob = await put(adminPhotoBlobPath(crypto.randomUUID(), ext), buf, { access: 'public', contentType: m[1], addRandomSuffix: false })
    return NextResponse.json({ ok: true, url: blob.url })
  } catch (e) {
    console.error('[admin/upload]', e)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
})
