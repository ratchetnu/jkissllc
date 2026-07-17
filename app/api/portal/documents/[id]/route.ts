import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../../_lib/crew'
import { getCrewDocument, canAccess } from '../../../../lib/crew-documents'
import { openDoc } from '../../../../lib/doc-crypto'

export const runtime = 'nodejs'
export const maxDuration = 30

// Serve one crew document. Ownership is enforced against the token's staffId:
// library docs are readable by any crew member, personal docs only by their owner.
// A miss and a not-authorized both return 404 — never reveal that someone else's
// document id exists. Sealed (tax / agreement) bytes are decrypted here and sent
// with `private, no-store` so they are never cached by a shared proxy.
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who
  const { id } = await params

  const doc = await getCrewDocument(id)
  if (!doc || !canAccess(doc, who.staffId)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  let bytes: Uint8Array
  try {
    const res = await fetch(doc.blobUrl)
    if (!res.ok) throw new Error(`blob ${res.status}`)
    const raw = Buffer.from(await res.arrayBuffer())
    bytes = new Uint8Array(doc.sealed ? openDoc(raw) : raw)
  } catch (e) {
    console.error('[portal/documents]', id, e)
    return NextResponse.json({ error: 'Could not open this document — please try again.' }, { status: 502 })
  }

  // Copy into a fresh ArrayBuffer so the body is a plain BodyInit (Node's Buffer
  // carries an ArrayBufferLike generic that the Response types reject).
  const body = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(body).set(bytes)

  const safeName = (doc.title || 'document').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 80)
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': doc.contentType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store',
    },
  })
})
