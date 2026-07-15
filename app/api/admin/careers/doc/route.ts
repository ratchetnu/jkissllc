import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { get } from '@vercel/blob'
import { requireAdmin } from '../../_lib/session'
import { openDoc } from '../../../../lib/doc-crypto'

export const runtime = 'nodejs'

// GET /api/admin/careers/doc?p=driver-docs/ss_card/<uuid>.jpg.enc
//
// The ONLY way to read an applicant's identity documents. The stored object is
// AES-256-GCM ciphertext (see lib/doc-crypto.ts); this route holds the key and hands
// the plaintext image to a signed-in admin, and to nobody else.
//
// Rendered by <img src="/api/admin/careers/doc?p=…"> on the admin careers page —
// the browser sends the admin session cookie with the image request.

// Only ever serve from the applicant-document prefix, and never let a caller walk
// out of it. `p` is untrusted input. Trailing `.enc` marks a sealed object.
const SEALED_PATH = /^driver-docs\/[a-z_]+\/[a-zA-Z0-9-]+\.(jpg|png|webp|heic|heif)\.enc$/

const MEDIA: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  // Decrypted identity documents (SS card, license, etc.) — admin only.
  const who = await requireAdmin(req)
  if (who instanceof NextResponse) return who

  const pathname = req.nextUrl.searchParams.get('p') ?? ''
  if (pathname.includes('..') || !SEALED_PATH.test(pathname)) {
    return NextResponse.json({ error: 'bad path' }, { status: 400 })
  }

  // "…/<uuid>.jpg.enc" → "jpg"
  const ext = pathname.slice(0, -4).split('.').pop() ?? ''
  const contentType = MEDIA[ext] ?? 'application/octet-stream'

  try {
    const res = await get(pathname, { access: 'public' })   // the object; its BYTES are sealed
    if (!res) return NextResponse.json({ error: 'not found' }, { status: 404 })

    const sealed = Buffer.from(await new Response(res.stream as unknown as ReadableStream).arrayBuffer())
    // GCM authenticates as well as decrypts: a tampered object throws here.
    const plaintext = openDoc(sealed)

    return new NextResponse(new Uint8Array(plaintext), {
      headers: {
        'Content-Type': contentType,
        // Never let an identity document sit in a shared or on-disk cache.
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch (e) {
    console.error('[admin/careers/doc]', e)
    return NextResponse.json({ error: 'could not read document' }, { status: 500 })
  }
})
