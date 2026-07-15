import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { put } from '@vercel/blob'
import { rateLimit } from '../../../lib/rate-limit'
import { isBlockedBot } from '../../../lib/botcheck'
import { isSensitiveDoc } from '../../../lib/ats-config'
import { sealDoc, docCryptoReady } from '../../../lib/doc-crypto'
import { scopeBlobPath, sanitizeBlobSegment } from '../../../lib/platform/tenancy/blob-keys'

export const runtime = 'nodejs'
export const maxDuration = 30

const KINDS = new Set(['drivers_license', 'id', 'ss_card', 'headshot'])

// Tenant-safe physical path for an applicant document. `kind` is a directory
// segment drawn only from the fixed KINDS set; the filename is sanitized. Sealed
// identity docs carry a trailing `.enc`. Byte-identical to
// `driver-docs/<kind>/<uuid>.<ext>[.enc]` while tenancy is off;
// `tenants/<id>/driver-docs/…` once on. The RETURNED value (not a URL) is what we
// persist and later read back, so legacy records keep resolving unchanged.
export function driverDocBlobPath(kind: string, id: string, ext: string, sealed: boolean): string {
  const filename = sanitizeBlobSegment(`${id}.${ext}${sealed ? '.enc' : ''}`)
  return scopeBlobPath(`driver-docs/${kind}/${filename}`)
}

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
export const POST = withTenantRoute(async (req: NextRequest) => {
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
  const sensitive = isSensitiveDoc(kind)

  // Fail closed. Storing an unencrypted Social Security card at a public URL because
  // a key was missing is strictly worse than telling the applicant to try again.
  if (sensitive && !docCryptoReady()) {
    console.error('[careers-upload] refusing to store an identity document unsealed — no encryption key configured')
    return NextResponse.json({ error: 'Uploads are temporarily unavailable. Please try again shortly.' }, { status: 503 })
  }

  try {
    const buf = Buffer.from(m[3], 'base64')
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2]

    if (sensitive) {
      // `.enc` marks the object as sealed, so the reader never has to guess. The
      // real media type is recovered from the extension embedded before it.
      const pathname = driverDocBlobPath(kind, crypto.randomUUID(), ext, true)
      await put(pathname, sealDoc(buf), {
        access: 'public',                          // the store is public; the BYTES are not
        contentType: 'application/octet-stream',
        addRandomSuffix: false,
      })
      // Hand back the pathname, never a URL — nothing in an applicant's browser or
      // in the saved record should be a link to their Social Security card.
      return NextResponse.json({ ok: true, url: pathname })
    }

    const blob = await put(driverDocBlobPath(kind, crypto.randomUUID(), ext, false), buf, {
      access: 'public',
      contentType: m[1],
      addRandomSuffix: false,
    })
    return NextResponse.json({ ok: true, url: blob.url })
  } catch (e) {
    console.error('[careers-upload]', e)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }
})
