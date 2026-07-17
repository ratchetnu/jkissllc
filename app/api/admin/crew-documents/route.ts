import { NextRequest, NextResponse } from 'next/server'
import { put, del } from '@vercel/blob'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { scopeBlobPath, sanitizeBlobSegment } from '../../../lib/platform/tenancy/blob-keys'
import { sealDoc, docCryptoReady } from '../../../lib/doc-crypto'
import {
  newCrewDocId,
  saveCrewDocument,
  deleteCrewDocument,
  listAllCrewDocuments,
  listStaffDocuments,
  defaultSealed,
  type CrewDocCategory,
  type CrewDocScope,
  type CrewDocument,
} from '../../../lib/crew-documents'

export const runtime = 'nodejs'
export const maxDuration = 30

// Admin/manager management of crew documents (the publish/assign side of the crew
// portal's Documents hub). Reads gate on `crew:view`; writes on `crew:manage`.
const CATEGORIES: CrewDocCategory[] = ['agreement', 'policy', 'training', 'tax', 'job', 'other']
const ACCEPT = /^data:(application\/pdf|image\/(?:jpeg|png|webp|heic|heif));base64,(.+)$/
const EXT: Record<string, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
}

// crew-docs/<library|staffId>/<id>.<ext>[.enc] — tenant-scoped, filename sanitized.
function crewDocBlobPath(scope: CrewDocScope, staffId: string | undefined, id: string, ext: string, sealed: boolean): string {
  const bucket = scope === 'staff' && staffId ? staffId : 'library'
  return scopeBlobPath(`crew-docs/${bucket}/${sanitizeBlobSegment(`${id}.${ext}${sealed ? '.enc' : ''}`)}`)
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'crew:view')
  if (who instanceof NextResponse) return who
  const staffId = req.nextUrl.searchParams.get('staffId')
  const documents = staffId ? await listStaffDocuments(staffId) : await listAllCrewDocuments()
  return NextResponse.json({ ok: true, documents })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'crew:manage')
  if (who instanceof NextResponse) return who

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const scope: CrewDocScope = body.scope === 'staff' ? 'staff' : 'library'
  const staffId = typeof body.staffId === 'string' ? body.staffId.trim() : ''
  const category: CrewDocCategory = CATEGORIES.includes(body.category as CrewDocCategory) ? (body.category as CrewDocCategory) : 'other'
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 140) : ''
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 400) : ''
  const data = typeof body.data === 'string' ? body.data : ''

  if (scope === 'staff' && !staffId) return NextResponse.json({ error: 'A staff member is required for a personal document.' }, { status: 400 })
  if (!title) return NextResponse.json({ error: 'A title is required.' }, { status: 400 })

  const m = data.match(ACCEPT)
  if (!m || data.length > 12_000_000) {
    return NextResponse.json({ error: 'Attach a PDF or image under ~9MB.' }, { status: 400 })
  }
  const contentType = m[1]
  const ext = EXT[contentType] ?? 'bin'
  const plain = Buffer.from(m[2], 'base64')

  // Seal personal/tax/agreement docs before they touch the (public) Blob store.
  const sealed = typeof body.sealed === 'boolean' ? body.sealed : defaultSealed(category, scope)
  if (sealed && !docCryptoReady()) {
    return NextResponse.json({ error: 'Document encryption is not configured on this environment.' }, { status: 503 })
  }

  const id = newCrewDocId()
  const path = crewDocBlobPath(scope, staffId || undefined, id, ext, sealed)
  let blobUrl: string
  try {
    const bytes = sealed ? sealDoc(plain) : plain
    const blob = await put(path, bytes, {
      access: 'public',
      addRandomSuffix: false,
      // Sealed bytes are ciphertext — never advertise the plaintext type at rest.
      contentType: sealed ? 'application/octet-stream' : contentType,
    })
    blobUrl = blob.url
  } catch (e) {
    console.error('[admin/crew-documents] upload', e)
    return NextResponse.json({ error: 'Upload failed — please try again.' }, { status: 500 })
  }

  const now = Date.now()
  const doc: CrewDocument = {
    id, scope, staffId: scope === 'staff' ? staffId : undefined, category, title,
    description: description || undefined, blobUrl, blobPath: path, sealed,
    contentType, size: plain.byteLength, uploadedBy: who.sub, createdAt: now, updatedAt: now,
  }
  await saveCrewDocument(doc)
  return NextResponse.json({ ok: true, document: doc })
})

export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'crew:manage')
  if (who instanceof NextResponse) return who
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const doc = await deleteCrewDocument(id)
  if (doc) {
    try { await del(doc.blobUrl) } catch { /* best-effort blob cleanup */ }
  }
  return NextResponse.json({ ok: true })
})
