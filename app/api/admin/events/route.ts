import { NextRequest, NextResponse } from 'next/server'
import { requireStaffSession } from '../_lib/session'
import { eventLog } from '../../../lib/platform/events/event-log'

// The governed workflow event stream, for the owner-facing live timeline.
// Admin/manager only; strictly tenant-scoped.
//   GET ?entityId=<bookingToken>  → that booking's events (newest-first)
//   GET (no entityId)             → recent events for the caller's tenant
export async function GET(req: NextRequest) {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who

  const entityId = req.nextUrl.searchParams.get('entityId')
  const limit = Math.min(200, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') ?? '100', 10) || 100))

  const events = entityId
    ? await eventLog.readForEntity(who.tenantId, entityId, limit)
    : (await eventLog.readRecent(limit)).filter((e) => e.tenantId === who.tenantId)

  return NextResponse.json({ events })
}
