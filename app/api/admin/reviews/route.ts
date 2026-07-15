import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireStaffSession } from '../_lib/session'
import { listReviews, setHidden, deleteReview } from '../../../lib/site-reviews'

// GET /api/admin/reviews — all on-site reviews, newest first.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  const reviews = await listReviews()
  return NextResponse.json({ reviews })
})

// PATCH /api/admin/reviews — { token, hidden } to show/hide on the public page.
export const PATCH = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  if (typeof body.token !== 'string') return NextResponse.json({ error: 'token required' }, { status: 400 })
  const r = await setHidden(body.token, body.hidden === true)
  if (!r) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true, review: r })
})

// DELETE /api/admin/reviews — { token } to permanently remove a review.
export const DELETE = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  if (typeof body.token !== 'string') return NextResponse.json({ error: 'token required' }, { status: 400 })
  await deleteReview(body.token)
  return NextResponse.json({ ok: true })
})
