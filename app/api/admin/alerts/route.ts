// Admin: read/update the owner-alert config (which channels notify the owner on a
// customer reply, and where). Runtime-editable so "text me / email me" can be
// toggled from the dashboard without a redeploy. Admin-only.

import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireSession, requireAdmin } from '../_lib/session'
import { getOwnerAlertConfig, setOwnerAlertConfig } from '../../../lib/owner-alerts'

export const GET = withTenantRoute(async (req: NextRequest) => {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ config: await getOwnerAlertConfig() })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  // Owner-alert config is a global setting — admin only.
  const who = await requireAdmin(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const config = await setOwnerAlertConfig({
    sms: typeof body.sms === 'boolean' ? body.sms : undefined,
    email: typeof body.email === 'boolean' ? body.email : undefined,
    smsTo: typeof body.smsTo === 'string' ? body.smsTo : undefined,
    emailTo: typeof body.emailTo === 'string' ? body.emailTo : undefined,
  })
  return NextResponse.json({ config })
})
