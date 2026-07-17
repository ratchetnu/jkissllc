import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { previewTemplate } from '../../../../lib/comms/templates'
import { isCommEvent } from '../../../../lib/comms/events'
import type { CommContext } from '../../../../lib/comms/context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 15

const CTX_KEYS: (keyof CommContext)[] = [
  'customerId', 'customerName', 'phone', 'email', 'jobId', 'bookingId', 'bookingNumber',
  'quoteId', 'invoiceNumber', 'dateText', 'windowText', 'address', 'crewName', 'amountText',
  'balanceText', 'bookingLink', 'invoiceLink', 'trackingLink', 'reviewLink', 'etaText', 'note',
]

// Render a template preview from sample data merged over any partial context the
// caller supplies. Pure render — validation only, never a send.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'comms:analytics')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const event = body.event
  if (typeof event !== 'string' || !isCommEvent(event)) {
    return NextResponse.json({ error: 'unknown_event' }, { status: 400 })
  }

  // Whitelist + trim any provided context fields.
  const partial: Partial<CommContext> = {}
  const rawCtx = (body.ctx && typeof body.ctx === 'object') ? body.ctx as Record<string, unknown> : {}
  for (const k of CTX_KEYS) {
    const val = rawCtx[k]
    if (typeof val === 'string' && val.trim()) partial[k] = val.trim().slice(0, 400)
  }

  const rendered = previewTemplate(event, partial)
  return NextResponse.json({ event, ...rendered })
})
