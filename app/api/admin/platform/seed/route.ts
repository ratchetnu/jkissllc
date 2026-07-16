import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../_lib/session'
import { seedPlatform } from '../../../../lib/platform/updates/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/platform/seed — idempotent one-time seed of businesses + real updates.
// Platform-owner only. No-op if already seeded (pass {force:true} to re-seed).
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const result = await seedPlatform(Date.now(), { force: body?.force === true })
  return NextResponse.json({ ok: true, ...result })
})
