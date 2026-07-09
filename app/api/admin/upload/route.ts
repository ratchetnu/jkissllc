import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { requireSession } from '../_lib/session'

export const runtime = 'nodejs'
export const maxDuration = 30

// POST /api/admin/upload — session-gated image upload for admin-only features (crew
// badge photos, etc.). Same {image: dataURL} → {url} shape as the public /api/upload,
// but behind requireSession instead of the rate-limit/bot-check the public form uses:
// an admin-only feature should ride an authenticated path, not the anonymous uploader.
export async function POST(req: NextRequest) {
  if (!(await requireSession(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const image = typeof body.image === 'string' ? body.image : ''
  const m = image.match(/^data:(image\/(jpeg|png|webp|heic|heif));base64,(.+)$/)
  if (!m || image.length > 8_000_000) {
    return NextResponse.json({ error: 'Please attach a clear photo (JPG/PNG, under ~6MB).' }, { status: 400 })
  }
  try {
    const buf = Buffer.from(m[3], 'base64')
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2]
    const blob = await put(`admin-photos/${crypto.randomUUID()}.${ext}`, buf, { access: 'public', contentType: m[1], addRandomSuffix: false })
    return NextResponse.json({ ok: true, url: blob.url })
  } catch (e) {
    console.error('[admin/upload]', e)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
}
