import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { rateLimit } from '../../lib/rate-limit'
import { isBlockedBot } from '../../lib/botcheck'

export const runtime = 'nodejs'
export const maxDuration = 30

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
    const blob = await put(`quote-photos/${crypto.randomUUID()}.${ext}`, buf, { access: 'public', contentType: m[1], addRandomSuffix: false })
    return NextResponse.json({ ok: true, url: blob.url })
  } catch (e) {
    console.error('[upload]', e)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
}
