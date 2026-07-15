// Lightweight unread-count endpoint for the admin nav badge (polled by AdminGate
// + the dashboard). Returns 0 when not authenticated rather than erroring, so the
// badge poll on a signed-out page stays quiet.

import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { unreadCount } from '../../../../lib/messages'

export const GET = withTenantRoute(async (req: NextRequest) => {
  // Gate on messages:send. A caller without it (crew / signed-out) sees a quiet 0
  // rather than an error — the badge poll never leaks the count or throws.
  if ((await requirePermission(req, 'messages:send')) instanceof NextResponse) return NextResponse.json({ unread: 0 })
  try {
    return NextResponse.json({ unread: await unreadCount() })
  } catch {
    return NextResponse.json({ unread: 0 })
  }
})
