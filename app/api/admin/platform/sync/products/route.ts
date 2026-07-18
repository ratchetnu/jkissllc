import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../../_lib/session'
import { getProduct, listProducts, saveProduct } from '../../../../../lib/platform/sync/store'
import { validateAndBuildProduct } from '../../../../../lib/platform/sync/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/platform/sync/products — the product registry (owner only).
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json({ ok: true, products: await listProducts() })
})

// POST /api/admin/platform/sync/products — register a NEW product (owner only). Pure
// registration: no code change is ever required to add a product. Rejects a duplicate id.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const built = validateAndBuildProduct(body ?? {}, null, Date.now())
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 })
  if (await getProduct(built.product.id)) {
    return NextResponse.json({ error: 'a product with this id already exists' }, { status: 409 })
  }
  await saveProduct(built.product)
  return NextResponse.json({ ok: true, product: built.product }, { status: 201 })
})
