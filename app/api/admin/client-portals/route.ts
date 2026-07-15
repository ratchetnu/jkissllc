import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { listClientPortals, saveClientPortal, generateClientToken, type ClientPortal } from '../../../lib/client-portal'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'businesses:manage')
  if (who instanceof NextResponse) return who
  try {
    return NextResponse.json({ items: await listClientPortals() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'list failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[client-portals GET]', err)
    return NextResponse.json({ error: 'list failed' }, { status: 500 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'businesses:manage')
  if (who instanceof NextResponse) return who
  const b = await req.json().catch(() => ({}))
  const businessName = S(b.businessName, 200)
  if (!businessName) return NextResponse.json({ error: 'Business/client name is required.' }, { status: 400 })
  const now = Date.now()
  const p: ClientPortal = {
    token: generateClientToken(), businessName,
    label: S(b.label, 200) || undefined, createdAt: now, updatedAt: now,
  }
  await saveClientPortal(p)
  return NextResponse.json({ ok: true, portal: p })
})
