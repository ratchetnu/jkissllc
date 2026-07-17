import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { reviewUniformPhoto, listUniformPhotos, getUniformPhoto, uniformStatus } from '../../../lib/uniform'
import { centralToday } from '../../../lib/dates'

export const runtime = 'nodejs'

// Manager review of a crew member's uniform photo — approve it or bounce it back
// with a reason (which the crew member sees, prompting a resubmit). Reads gate on
// `crew:view`, the decision on `crew:manage`. The crew portal never exposes this;
// review is an operations action.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'crew:view')
  if (who instanceof NextResponse) return who
  const staffId = req.nextUrl.searchParams.get('staffId')
  if (!staffId) return NextResponse.json({ error: 'staffId required' }, { status: 400 })
  const photos = await listUniformPhotos(staffId, 30)
  return NextResponse.json({ ok: true, photos: photos.map((p) => ({ ...p, status: uniformStatus(p) })) })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'crew:manage')
  if (who instanceof NextResponse) return who
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const staffId = typeof body.staffId === 'string' ? body.staffId.trim() : ''
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : centralToday()
  const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : null
  const note = typeof body.note === 'string' ? body.note.slice(0, 300) : undefined

  if (!staffId) return NextResponse.json({ error: 'staffId required' }, { status: 400 })
  if (!decision) return NextResponse.json({ error: 'decision must be approved or rejected' }, { status: 400 })
  if (decision === 'rejected' && !note?.trim()) {
    return NextResponse.json({ error: 'A note is required when rejecting a photo.' }, { status: 400 })
  }
  if (!(await getUniformPhoto(staffId, date))) {
    return NextResponse.json({ error: 'No uniform photo on file for that day.' }, { status: 404 })
  }

  const updated = await reviewUniformPhoto(staffId, date, decision, who.sub, note)
  return NextResponse.json({ ok: true, photo: updated })
})
