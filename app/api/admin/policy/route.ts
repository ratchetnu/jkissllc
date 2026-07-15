import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { getCurrentPolicy, savePolicy, listPolicyVersions } from '../../../lib/policy'

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who
  try {
    const current = await getCurrentPolicy()
    const versions = await listPolicyVersions(20)
    return NextResponse.json({ current, versions })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'settings:manage')
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (text.length < 50) return NextResponse.json({ error: 'Policy text is too short.' }, { status: 400 })
  try {
    const policy = await savePolicy(text)
    return NextResponse.json({ ok: true, policy })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'failed'
    if (msg === 'UPSTASH_NOT_CONFIGURED') return NextResponse.json({ error: 'UPSTASH_NOT_CONFIGURED' }, { status: 503 })
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
})
