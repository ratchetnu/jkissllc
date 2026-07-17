import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { listCommHistory, estimateUsage, type CommHistoryFilter } from '../../../../lib/comms/history'
import { isCommEvent } from '../../../../lib/comms/events'
import type { MsgChannel, MsgStatus } from '../../../../lib/messages'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const CHANNELS = new Set<MsgChannel>(['sms', 'email', 'note', 'system'])
const STATUSES = new Set<MsgStatus>(['queued', 'sent', 'delivered', 'failed', 'received', 'read', 'archived'])

// Read-only communications history + usage estimate. Reading this NEVER sends a
// message — it only queries the existing ledger and filters in memory.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'comms:analytics')
  if (who instanceof NextResponse) return who

  const q = new URL(req.url).searchParams
  const ch = q.get('channel')
  const st = q.get('status')
  const ev = q.get('event')
  const filter: CommHistoryFilter = {
    channel: ch && CHANNELS.has(ch as MsgChannel) ? (ch as MsgChannel) : undefined,
    status: st && STATUSES.has(st as MsgStatus) ? (st as MsgStatus) : undefined,
    event: ev && isCommEvent(ev) ? ev : undefined,
    bookingToken: q.get('booking') || undefined,
    onlyComms: q.get('onlyComms') === '1',
    onlyFailed: q.get('onlyFailed') === '1',
    includeSimulated: q.get('includeSimulated') !== '0',
    limit: Math.min(500, Math.max(1, Number(q.get('limit')) || 200)),
  }

  try {
    const rows = await listCommHistory(filter)
    return NextResponse.json({ rows, usage: estimateUsage(rows) })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'history failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    return NextResponse.json({ error: 'history failed' }, { status: 500 })
  }
})
