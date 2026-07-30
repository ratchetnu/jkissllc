// Crew activity — read-only aggregate of the booking ASSIGNMENT audit ledger.
//
// PERMISSION: `audit:view`. This is a view onto the audit trail, so that is the
// semantically exact capability, and it is also the NARROWEST available: rbac.ts
// grants it to admin only and says so explicitly ("NOT audit:view — that stays
// admin-only"). `time:view`, `routes:view` and `reports:view` all also reach
// manager, so any of them would widen access for no reason.
//
// Read-only: no writes, no migrations, no backfills, no new flags. Tenant-scoped
// through the redis chokepoint, which fails closed without a tenant context.
//
// The response carries counts, booleans and date strings only — never a customer
// name, address, booking token, pay figure, note, photo URL, individual crew
// identity, or per-booking row.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import {
  MAX_RANGE_DAYS,
  summarizeAssignmentActivity,
} from '../../../lib/booking-assignment-observability'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RANGE_ERRORS: Record<'invalid_date' | 'inverted_range' | 'range_too_long', string> = {
  invalid_date: 'Use whole calendar dates (YYYY-MM-DD), or a day count of at least 1.',
  inverted_range: 'The start date must not be after the end date.',
  range_too_long: `Ranges are limited to ${MAX_RANGE_DAYS} days.`,
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'audit:view')
  if (who instanceof NextResponse) return who

  try {
    const url = new URL(req.url)
    const result = await summarizeAssignmentActivity({
      start: url.searchParams.get('start'),
      end: url.searchParams.get('end'),
      days: url.searchParams.get('days'),
    })

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error.error, message: RANGE_ERRORS[result.error.error] },
        { status: 400 },
      )
    }
    return NextResponse.json({ ok: true, summary: result.summary })
  } catch {
    // Never echo internal error text to a client.
    return NextResponse.json(
      { error: 'unavailable', message: 'Could not read crew activity right now.' },
      { status: 503 },
    )
  }
})
