import { NextRequest, NextResponse } from 'next/server'
import { PDFDocument } from 'pdf-lib'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { auditAdmin } from '../../../lib/audit'
import { str } from '../../../lib/validators'
import { docCryptoReady } from '../../../lib/doc-crypto'
import {
  getCurrentContractorAgreement,
  listContractorAgreementVersions,
  publishContractorAgreement,
  ContractorAgreementUnavailable,
} from '../../../lib/contractor-agreement'

export const runtime = 'nodejs'
export const maxDuration = 30

const MAX_PDF_BYTES = 12 * 1024 * 1024
// A real PDF starts with %PDF-. Operion refuses anything else rather than storing an
// arbitrary file as if it were the counsel-approved agreement.
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii')

// GET — the setup/status panel. Says plainly when nothing is published yet, which is
// the state that blocks contractor onboarding.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who
  const [current, versions] = await Promise.all([
    getCurrentContractorAgreement(),
    listContractorAgreementVersions(),
  ])
  return NextResponse.json({
    ok: true,
    configured: !!current,
    encryptionReady: docCryptoReady(),
    current,
    versions,
    blocking: current
      ? null
      : 'No counsel-approved contractor agreement is published. Contractor onboarding cannot be sent until an administrator uploads one.',
  })
})

// POST — publish a counsel-approved PDF as the next immutable version.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const file = typeof body.file === 'string' ? body.file : ''
  const filename = str(body.filename, 160) ?? 'contractor-agreement.pdf'
  const note = str(body.note, 500) ?? undefined

  const match = file.match(/^data:application\/pdf;base64,(.+)$/)
  if (!match) {
    return NextResponse.json({ error: 'Attach the counsel-approved agreement as a PDF.' }, { status: 400 })
  }
  let bytes: Buffer
  try { bytes = Buffer.from(match[1], 'base64') } catch { bytes = Buffer.alloc(0) }
  if (!bytes.length || bytes.byteLength > MAX_PDF_BYTES) {
    return NextResponse.json({ error: 'The agreement must be a PDF under 12 MB.' }, { status: 400 })
  }
  if (!bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return NextResponse.json({ error: 'That file is not a PDF.' }, { status: 400 })
  }
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    if (pdf.getPageCount() < 1) throw new Error('PDF has no pages')
  } catch {
    return NextResponse.json({ error: 'That PDF is damaged or cannot be read. Nothing was published.' }, { status: 400 })
  }

  try {
    const previous = await getCurrentContractorAgreement()
    const template = await publishContractorAgreement({
      bytes, filename, publishedBy: who.sub, note,
    })
    // The agreement TEXT is never logged — only which version became current, its
    // digest, and who published it.
    await auditAdmin(who, previous ? 'contractor_agreement.replaced' : 'contractor_agreement.published', {
      entity: 'contractor_agreement',
      entityId: String(template.version),
      summary: previous
        ? `Replaced the published contractor agreement (v${previous.version} → v${template.version}).`
        : `Published contractor agreement v${template.version}.`,
      meta: {
        version: template.version,
        previousVersion: previous?.version,
        filename: template.filename,
        sha256: template.sha256,
        size: template.size,
      },
    })
    return NextResponse.json({ ok: true, current: template, replaced: previous?.version ?? null })
  } catch (error) {
    if (error instanceof ContractorAgreementUnavailable) {
      console.error('[contractor-agreement] publish blocked', error.message)
      return NextResponse.json({ error: 'Secure document storage is unavailable. The agreement was not stored.' }, { status: 503 })
    }
    console.error('[contractor-agreement] publish', error)
    return NextResponse.json({ error: 'The agreement could not be published. Please try again.' }, { status: 500 })
  }
})
