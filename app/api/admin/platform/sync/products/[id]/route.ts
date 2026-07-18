import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../../_lib/session'
import { deleteProduct, getProduct, saveProduct } from '../../../../../../lib/platform/sync/store'
import { getProductDetail } from '../../../../../../lib/platform/sync/service'
import { validateAndBuildProduct } from '../../../../../../lib/platform/sync/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

// GET /api/admin/platform/sync/products/[id] — full drill-down: product, latest status,
// reconciliation history, and recommended actions (owner only, read-only).
export const GET = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const detail = await getProductDetail(id)
  if (!detail) return NextResponse.json({ error: 'unknown product' }, { status: 404 })
  return NextResponse.json({ ok: true, ...detail })
})

// PATCH — update a product's registration (owner only). createdAt is preserved.
export const PATCH = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  const existing = await getProduct(id)
  if (!existing) return NextResponse.json({ error: 'unknown product' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const built = validateAndBuildProduct({ ...body, id }, existing, Date.now())
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 })
  await saveProduct(built.product)
  return NextResponse.json({ ok: true, product: built.product })
})

// DELETE — unregister a product (owner only). Reconciliation history is retained as audit.
export const DELETE = withTenantRoute(async (req: NextRequest, ctx: Ctx) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const { id } = await ctx.params
  if (!(await getProduct(id))) return NextResponse.json({ error: 'unknown product' }, { status: 404 })
  await deleteProduct(id)
  return NextResponse.json({ ok: true })
})
