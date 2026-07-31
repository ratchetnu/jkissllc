// Sprint 5 — the retail customer record.
//
// PERMISSION: `customers:view` (admin + manager). The booking AUDIT trail is a
// separate, narrower grant: `rbac.ts` says `audit:view` "stays admin-only", so a
// manager gets the customer's operational history — bookings, payments, refunds,
// communications — and an admin additionally gets the event trail. The audit
// section is omitted server-side, not hidden in the UI.
//
// Read-only. No writes, no backfill, no migration, no new flag. The
// customer↔booking association is DERIVED at read time and the response says so
// (`linkProvenance: 'derived'`), so a reader never mistakes it for a stored fact.
//
// Tenant-scoped through the redis chokepoint, which fails closed with no tenant
// context — the same guarantee the punch-overlap audit relies on.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { can } from '../../../../lib/rbac'
import { buildCustomerTimeline } from '../../../../lib/customer-timeline'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ID_RE = /^c_[a-f0-9]{20}$/

export const GET = withTenantRoute(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const who = await requirePermission(req, 'customers:view')
  if (who instanceof NextResponse) return who

  const { id } = await ctx.params
  // Validate the RAW value: a malformed id must not reach the store, and it must
  // be indistinguishable from an unknown one.
  if (!ID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  try {
    const timeline = await buildCustomerTimeline(id, { includeAudit: can(who.role, 'audit:view') })
    if (!timeline) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json({ ok: true, ...timeline })
  } catch {
    // Never echo internal error text to a client.
    return NextResponse.json(
      { error: 'unavailable', message: 'Could not load this customer right now.' },
      { status: 503 },
    )
  }
})
