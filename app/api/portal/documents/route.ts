import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireCrew } from '../_lib/crew'
import { listCrewDocumentsFor, type CrewDocCategory } from '../../../lib/crew-documents'
import { listForStaff as listStatementsForStaff } from '../../../lib/pay-statements'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The crew member's document hub: their entitled files (shared library + their own
// sealed documents) PLUS their issued pay statements, merged into one list. File
// documents download through the owner-scoped serve route; statements link to the
// existing print view. Everything is scoped to who.staffId.
type DocItem = {
  id: string
  kind: 'file' | 'statement'
  category: CrewDocCategory
  title: string
  description: string | null
  href: string          // where the portal sends the crew member to open it
  download: boolean     // true → owner-scoped API download; false → in-app link
  createdAt: number
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireCrew(req)
  if (who instanceof NextResponse) return who

  const [docs, statements] = await Promise.all([
    listCrewDocumentsFor(who.staffId),
    listStatementsForStaff(who.staffId),
  ])

  const items: DocItem[] = [
    ...docs.map((d): DocItem => ({
      id: d.id,
      kind: 'file',
      category: d.category,
      title: d.title,
      description: d.description ?? null,
      href: `/api/portal/documents/${d.id}`,
      download: true,
      createdAt: d.createdAt,
    })),
    ...statements
      .filter((s) => s.status === 'issued')
      .map((s): DocItem => ({
        id: s.id,
        kind: 'statement',
        category: 'other',
        title: `Payment statement ${s.statementNumber}`,
        description: `${s.periodStart} – ${s.periodEnd}`,
        href: `/portal/pay/statement/${s.id}`,
        download: false,
        createdAt: s.issuedAt,
      })),
  ].sort((a, b) => b.createdAt - a.createdAt)

  return NextResponse.json({ ok: true, documents: items })
})
