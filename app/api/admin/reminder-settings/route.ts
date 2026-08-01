import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requireStaffSession, requireAdmin } from '../_lib/session'
import { getAutomationSettings, setAutomationSettings } from '../../../lib/automation-settings'

// Crew reminder policy. Kept separate in name from Operion release automation.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requireStaffSession(req)
  if (who instanceof NextResponse) return who
  return NextResponse.json({ ok: true, settings: await getAutomationSettings() })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requireAdmin(req)
  if (who instanceof NextResponse) return who
  const body = await req.json().catch(() => ({}))
  const patch: Record<string, boolean> = {}
  if (typeof body.confirmationReminders === 'boolean') patch.confirmationReminders = body.confirmationReminders
  if (typeof body.morningReminders === 'boolean') patch.morningReminders = body.morningReminders
  const settings = await setAutomationSettings(patch)
  return NextResponse.json({ ok: true, settings })
})
