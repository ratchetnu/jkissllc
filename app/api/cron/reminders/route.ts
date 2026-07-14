import { NextRequest, NextResponse } from 'next/server'
import { runDueReminders, runEscalations } from '../../../lib/reminder-engine'
import { withSmsSuppressed } from '../../../lib/sms'
import { withBackgroundTenant } from '../../../lib/platform/tenancy/request-context'
import { activeTenantIds } from '../../../lib/platform/tenancy/tenant-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The reminder engine cron (request Parts 2, 6). Runs every few minutes: fires every
// due reminder (after smart suppression + occurrence dedup), then walks
// unacknowledged require-ack sends and applies escalation. Mirrors the auth pattern
// of /api/cron/daily (CRON_SECRET bearer; Vercel injects it automatically).
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // fail closed — an unconfigured secret must not leave this open
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const now = Date.now()
  // Automated TEXTS are disabled for the scheduled reminder engine: reminders still
  // fire over in-app + email, and escalations still email the owner, but any outbound
  // SMS is suppressed at the send layer. Wraps only the cron passes — admin-initiated
  // dispatch/bulk sends (sendImmediate) run on their own request and still text.
  // Per-tenant fan-out: each tenant runs in its own explicit context; one tenant's
  // failure is isolated and never executes under another. Counts only (no PII).
  const tenants: { tenant: string; evaluated: number; sent: number; escalated: number; error?: string }[] = []
  for (const tenantId of activeTenantIds()) {
    let due: { evaluated: number; sent: number } = { evaluated: 0, sent: 0 }
    let esc: { escalated: number } = { escalated: 0 }
    try {
      await withBackgroundTenant('cron', () => withSmsSuppressed(async () => {
        try { due = await runDueReminders(now) } catch (e) { console.error('[cron/reminders] due', e) }
        try { esc = await runEscalations(now) } catch (e) { console.error('[cron/reminders] escalations', e) }
      }), tenantId)
      tenants.push({ tenant: tenantId, evaluated: due.evaluated, sent: due.sent, escalated: esc.escalated })
    } catch (e) {
      console.error('[cron/reminders] tenant', tenantId, e)
      tenants.push({ tenant: tenantId, evaluated: due.evaluated, sent: due.sent, escalated: esc.escalated, error: e instanceof Error ? e.name : 'unknown' })
    }
  }
  return NextResponse.json({ ok: true, smsSuppressed: true, tenants, at: now })
}
