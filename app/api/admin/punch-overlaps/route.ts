// Sprint 3.1 Phase A — read-only punch-overlap measurement.
//
// PERMISSION: `audit:view` — admin only. Same reasoning as Crew Activity: this is a
// view onto the audit trail, and `rbac.ts` says explicitly that `audit:view` "stays
// admin-only", whereas `time:view`, `routes:view` and `reports:view` all also reach
// manager. This reports on payroll-sensitive behaviour, so it takes the narrowest fit.
//
// NOT gated on any feature flag, deliberately and for the same reason Crew Activity
// is not: an audit view must be able to read history regardless of what is currently
// switched on, or "no overlaps" becomes ambiguous between "none happened" and "the
// surface is off".
//
// Read-only: no writes, no migrations, no backfills, no new flags, no punch
// behaviour change. Tenant-scoped through the redis chokepoint, which fails closed
// without a tenant context.
//
// The response is counts, booleans and epoch timestamps only — never a name, staff
// id, job token, job number, location, or per-record array.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { buildPunchOverlapReport } from '../../../lib/timeclock/punch-overlap-scan'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'audit:view')
  if (who instanceof NextResponse) return who
  try {
    const report = await buildPunchOverlapReport()
    return NextResponse.json({ ok: true, ...report })
  } catch {
    // Never echo internal error text to a client.
    return NextResponse.json(
      { error: 'unavailable', message: 'Could not measure punch overlaps right now.' },
      { status: 503 },
    )
  }
})
