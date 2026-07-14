import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../lib/rate-limit'
import { recordFunnelEvent, FUNNEL_EVENTS, type FunnelEvent } from '../../../lib/analytics-events'

export const runtime = 'nodejs'

// POST /api/quote/event — durable, server-side funnel beacon for the guided
// confirmation flow (Part 17). The browser only names an allowlisted event; the
// count lives in Redis. No PII, no free content. Rate-limited to curb abuse.
export const POST = withTenantRoute(async (req: NextRequest) => {
  if (await rateLimit(req, 'quoteevent', 60, 5 * 60_000)) {
    return NextResponse.json({ ok: false }, { status: 429 })
  }
  const body = await req.json().catch(() => ({}))
  const event = String(body?.event ?? '')
  if (!(FUNNEL_EVENTS as string[]).includes(event)) {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
  await recordFunnelEvent(event as FunnelEvent, new Date().toISOString())
  return NextResponse.json({ ok: true })
})
