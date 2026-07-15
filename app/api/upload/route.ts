import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { rateLimit } from '../../lib/rate-limit'
import { isBlockedBot } from '../../lib/botcheck'
import { alert } from '../../lib/alerts'
import { scopeBlobPath, sanitizeBlobSegment } from '../../lib/platform/tenancy/blob-keys'

export const runtime = 'nodejs'
export const maxDuration = 30

// Tenant-safe physical path for a public quote/booking photo. `scopeBlobPath`
// returns this UNCHANGED while tenancy is off (byte-identical to the legacy
// `quote-photos/<uuid>.<ext>`), and `tenants/<id>/quote-photos/…` once tenancy is
// on (fail-closed if no tenant context). The filename is sanitized so a crafted
// id/ext can never smuggle a path segment or traversal.
export function quotePhotoBlobPath(id: string, ext: string): string {
  return scopeBlobPath(`quote-photos/${sanitizeBlobSegment(`${id}.${ext}`)}`)
}

// POST /api/upload — public image upload for the booking/quote flow. Stores a
// data-URL image to Vercel Blob and returns its URL. Rate-limited + bot-protected.
export async function POST(req: NextRequest) {
  if (await rateLimit(req, 'upload', 20, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many uploads. Please wait a few minutes.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Upload blocked.' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const image = typeof body.image === 'string' ? body.image : ''
  const m = image.match(/^data:(image\/(jpeg|png|webp|heic|heif));base64,(.+)$/)
  if (!m || image.length > 8_000_000) {
    return NextResponse.json({ error: 'Please attach a clear photo (JPG/PNG, under ~6MB).' }, { status: 400 })
  }
  try {
    const buf = Buffer.from(m[3], 'base64')
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2]
    const blob = await put(quotePhotoBlobPath(crypto.randomUUID(), ext), buf, { access: 'public', contentType: m[1], addRandomSuffix: false })
    return NextResponse.json({ ok: true, url: blob.url })
  } catch (e) {
    console.error('[upload]', e)
    await alert({ type: 'upload_failed', severity: 'ERROR', route: '/api/upload', errorClass: e instanceof Error ? e.name : 'blob_put_failed' })
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
}
