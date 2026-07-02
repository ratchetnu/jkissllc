import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'

export const runtime = 'nodejs'
export const maxDuration = 30

const KINDS = new Set(['drivers_license', 'id', 'ss_card', 'headshot'])

// POST /api/careers/upload — public applicant document upload (photo ID, SS card,
// badge headshot). Stores a data-URL image to Vercel Blob under driver-docs/ and
// returns its URL. Rate-limited + bot-protected. Mirrors /api/upload.
export async function POST(req: NextRequest) {
  if (await rateLimit(req, 'careers-upload', 40, 15 * 60_000)) {
    return NextResponse.json({ error: 'Too many uploads. Please wait a few minutes.' }, { status: 429 })
  }
  if (await isBlockedBot()) return NextResponse.json({ error: 'Upload blocked.' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const image = typeof body.image === 'string' ? body.image : ''
  const kind = typeof body.kind === 'string' && KINDS.has(body.kind) ? body.kind : 'doc'
  const m = image.match(/^data:(image\/(jpeg|png|webp|heic|heif));base64,(.+)$/)
  if (!m || image.length > 12_000_000) {
    return NextResponse.json({ error: 'Please attach a clear photo (JPG/PNG, under ~9MB).' }, { status: 400 })
  }
  try {
    const buf = Buffer.from(m[3], 'base64')
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2]
    const blob = await put(`driver-docs/${kind}/${crypto.randomUUID()}.${ext}`, buf, { access: 'public', contentType: m[1], addRandomSuffix: false })
    return NextResponse.json({ ok: true, url: blob.url })
  } catch (e) {
    console.error('[careers-upload]', e)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
}
