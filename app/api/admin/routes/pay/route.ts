import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requireSession } from '../../_lib/session'
import { computePay, defaultPayPeriod } from '../../../../lib/route-pay'

export const GET = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const url = new URL(req.url)
  const def = defaultPayPeriod()
  const start = url.searchParams.get('start') || def.start
  const end = url.searchParams.get('end') || def.end
  try {
    return NextResponse.json(await computePay(start, end))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    console.error('[routes/pay GET]', err)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
})
