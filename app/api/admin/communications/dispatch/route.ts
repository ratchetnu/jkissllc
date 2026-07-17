import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { dispatchComm } from '../../../../lib/comms/service'
import { isCommEvent } from '../../../../lib/comms/events'
import type { CommContext } from '../../../../lib/comms/context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const CTX_KEYS: (keyof CommContext)[] = [
  'customerId', 'customerName', 'phone', 'email', 'jobId', 'bookingId', 'bookingNumber',
  'quoteId', 'invoiceNumber', 'dateText', 'windowText', 'address', 'crewName', 'amountText',
  'balanceText', 'bookingLink', 'invoiceLink', 'trackingLink', 'reviewLink', 'etaText', 'note',
]

// Run a message through the FULL dispatch pipeline (validation, idempotency,
// opt-out, quiet hours, ledger) in HARD test mode — this endpoint can never send
// a real message, by design. It exists so an operator can verify a template end to
// end from the console. Live sending is intentionally not exposed here.
export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'messages:send')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const event = body.event
  if (typeof event !== 'string' || !isCommEvent(event)) {
    return NextResponse.json({ error: 'unknown_event' }, { status: 400 })
  }

  const ctx: CommContext = {}
  const rawCtx = (body.ctx && typeof body.ctx === 'object') ? body.ctx as Record<string, unknown> : {}
  for (const k of CTX_KEYS) {
    const val = rawCtx[k]
    if (typeof val === 'string' && val.trim()) ctx[k] = val.trim().slice(0, 400)
  }

  // Unique key per click so repeat tests aren't swallowed as duplicates.
  const nonce = `test:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
  const result = await dispatchComm(event, ctx, {
    mode: 'test',                 // HARD test mode — never a real send
    trigger: 'manual',
    actor: who.sub,
    actorRole: who.role,
    idempotencyKey: nonce,
  })

  return NextResponse.json({ ok: true, result })
})
