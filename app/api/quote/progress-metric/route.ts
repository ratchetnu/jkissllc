import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { rateLimit } from '../../../lib/rate-limit'
import { isEnabled } from '../../../lib/platform/flags'
import { sanitizeMetric, recordProgressMetric } from '../../../lib/ai/progress-metrics'

export const runtime = 'nodejs'

// POST /api/quote/progress-metric — durable, server-side instrumentation beacon for
// the Option A progress display. The browser sends ONE compact, typed payload at
// the terminal (or on abandonment); the counters live in Redis. No PII, no free
// text. Gated by OPERION_PROGRESS_UX and rate-limited. Always returns ok (fail-soft)
// so a beacon can never surface an error to the customer.
export const POST = withTenantRoute(async (req: NextRequest) => {
  if (!isEnabled('OPERION_PROGRESS_UX')) return NextResponse.json({ ok: false }, { status: 404 })
  if (await rateLimit(req, 'quoteprogressmetric', 60, 5 * 60_000)) {
    return NextResponse.json({ ok: false }, { status: 429 })
  }
  const body = await req.json().catch(() => ({}))
  const metric = sanitizeMetric(body)
  if (!metric) return NextResponse.json({ ok: false }, { status: 400 })
  await recordProgressMetric(metric, new Date().toISOString())
  return NextResponse.json({ ok: true })
})
