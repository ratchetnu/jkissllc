import { NextRequest, NextResponse } from 'next/server'
import { get } from '@vercel/blob'
import { requireSession } from '../../_lib/session'

export const runtime = 'nodejs'

// GET /api/admin/careers/doc?p=driver-docs/ss_card/<uuid>.jpg
//
// The ONLY way to read an applicant's identity documents. They live in a private
// blob (see /api/careers/upload), so there is no URL to leak — this route streams
// the bytes to a signed-in admin and nobody else.
//
// Rendered by <img src="/api/admin/careers/doc?p=…"> on the admin careers page;
// the browser sends the admin session cookie with the image request.

// Only ever serve from the applicant-document prefix, and never let a caller walk
// out of it. `p` arrives from the client, so it is untrusted input.
const SAFE_PATH = /^driver-docs\/[a-z_]+\/[a-zA-Z0-9-]+\.(jpg|png|webp|heic|heif)$/

export async function GET(req: NextRequest) {
  if (!(await requireSession(req))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const pathname = req.nextUrl.searchParams.get('p') ?? ''
  if (pathname.includes('..') || !SAFE_PATH.test(pathname)) {
    return NextResponse.json({ error: 'bad path' }, { status: 400 })
  }

  try {
    const res = await get(pathname, { access: 'private' })
    if (!res) return NextResponse.json({ error: 'not found' }, { status: 404 })

    return new NextResponse(res.stream as unknown as ReadableStream, {
      headers: {
        'Content-Type': res.blob.contentType || 'application/octet-stream',
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
}
