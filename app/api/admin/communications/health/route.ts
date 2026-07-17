import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../../_lib/session'
import { smsConfigured } from '../../../../lib/sms'
import { resolveSendMode } from '../../../../lib/comms/policy'
import { COMM_EVENTS } from '../../../../lib/comms/events'
import { AUTOMATION_RULES } from '../../../../lib/comms/automation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 15

// Channel health + configuration snapshot for the console. Read-only; sends nothing.
export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'comms:analytics')
  if (who instanceof NextResponse) return who

  return NextResponse.json({
    sendMode: resolveSendMode(),
    vercelEnv: process.env.VERCEL_ENV ?? 'development',
    channels: {
      sms: { configured: smsConfigured(), provider: 'twilio' },
      email: { configured: !!process.env.RESEND_API_KEY, provider: 'resend' },
    },
    events: COMM_EVENTS.map(e => ({
      event: e.event, label: e.label, audience: e.audience,
      channels: e.channels, reminder: e.reminder, existing: e.existing ?? null,
    })),
    automation: AUTOMATION_RULES.map(r => ({
      id: r.id, label: r.label, description: r.description, event: r.event,
      anchor: r.anchor, offsetHours: r.offsetHours, channels: r.channels,
      enabled: r.enabled, mode: r.mode, overlapsExisting: r.overlapsExisting ?? null,
    })),
  })
})
