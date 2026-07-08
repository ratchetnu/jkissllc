import { NextRequest, NextResponse } from 'next/server'
import { put } from '@vercel/blob'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { isSensitiveDoc } from '../../../lib/ats-config'

export const runtime = 'nodejs'
export const maxDuration = 30

const KINDS = new Set(['drivers_license', 'id', 'ss_card', 'headshot'])

// POST /api/careers/upload — public applicant document upload (photo ID, SS card,
// badge headshot). Rate-limited + bot-protected.
//
// Identity documents (SS card, driver's license, state ID) are stored in a PRIVATE
// blob and we return only the PATHNAME. There is no URL anyone can open — not even
// an unguessable one. An applicant photographs their Social Security card here; a
// public blob would keep that image readable forever to anyone who ever saw the
// link (a forwarded email, a browser history, a log line). Admins read these back
// through /api/admin/careers/doc, which requires a signed-in session.
//
// The headshot stays public: it is a badge photo, it carries no identity data, and
// it flows into staff avatars on crew-facing screens.
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
    const pathname = `driver-docs/${kind}/${crypto.randomUUID()}.${ext}`
    const sensitive = isSensitiveDoc(kind)

    const blob = await put(pathname, buf, {
      access: sensitive ? 'private' : 'public',
      contentType: m[1],
      addRandomSuffix: false,
    })

    // Sensitive: hand back the pathname, which is only resolvable by an authed
    // admin. Non-sensitive: the public URL, exactly as before.
    return NextResponse.json({ ok: true, url: sensitive ? pathname : blob.url })
  } catch (e) {
    console.error('[careers-upload]', e)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
}
