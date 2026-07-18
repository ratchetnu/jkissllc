import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner } from '../../_lib/session'
import { isEnabled } from '../../../../lib/platform/flags'
import { buildBusinessReleaseViews } from '../../../../lib/platform/release/projection'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/release/businesses — the read-only per-Business release view for the
// Release Center's Businesses section. Platform-owner only (this is owner-tier data), so
// non-owner admins simply don't see the section. READ-ONLY: projects existing Sync Status
// + updates + automation state; no provider calls, no writes, no secrets.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  // `updatesEnabled` lets the UI render Update as live vs. a calm "not enabled here" — the
  // real gate is OPERION_AUTOMATION_ENABLED, re-checked server-side on every Update call.
  return NextResponse.json({ ok: true, updatesEnabled: isEnabled('OPERION_AUTOMATION_ENABLED'), businesses: await buildBusinessReleaseViews() })
})
