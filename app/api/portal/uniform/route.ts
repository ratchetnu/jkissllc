import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { put } from '@vercel/blob'
import { requireCrew } from '../_lib/crew'
import { saveUniformPhoto, getUniformPhoto } from '../../../lib/uniform'
import { centralToday } from '../../../lib/dates'
import { scopeBlobPath, sanitizeBlobSegment } from '../../../lib/platform/tenancy/blob-keys'

export const runtime = 'nodejs'
export const maxDuration = 30

// Tenant-safe physical path for a crew member's daily uniform photo. The staffId
// stays a directory segment exactly as today (server-controlled), only the
// filename is sanitized. Byte-identical to `uniform-photos/<staffId>/<uuid>.<ext>`
// while tenancy is off; `tenants/<id>/uniform-photos/…` once on.
export function uniformPhotoBlobPath(staffId: string, id: string, ext: string): string {
  return scopeBlobPath(`uniform-photos/${staffId}/${sanitizeBlobSegment(`${id}.${ext}`)}`)
}

// Daily uniform-photo upload (request "Uniform Photo"). A crew member submits today's
// uniform photo; this suppresses the uniform reminder and clears the "missing uniform"
// flag. Scoped to the caller's own staffId.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const photo = await getUniformPhoto(who.staffId, centralToday())
  return NextResponse.json({ uploaded: !!photo, url: photo?.url ?? null, at: photo?.uploadedAt ?? null })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const image = typeof body.image === 'string' ? body.image : ''
  const m = image.match(/^data:(image\/(jpeg|png|webp|heic|heif));base64,(.+)$/)
  if (!m || image.length > 8_000_000) {
    return NextResponse.json({ error: 'Please attach a clear photo (JPG/PNG, under ~6MB).' }, { status: 400 })
  }
  try {
    const buf = Buffer.from(m[3], 'base64')
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2]
    const blob = await put(uniformPhotoBlobPath(who.staffId, crypto.randomUUID(), ext), buf, { access: 'public', contentType: m[1], addRandomSuffix: false })
    const rec = await saveUniformPhoto(who.staffId, blob.url)
    return NextResponse.json({ ok: true, url: rec.url, at: rec.uploadedAt })
  } catch (e) {
    console.error('[portal/uniform]', e)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
})
