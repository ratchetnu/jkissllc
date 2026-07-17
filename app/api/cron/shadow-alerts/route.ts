import { NextRequest, NextResponse } from 'next/server'
import { runShadowAlertEvaluation } from '../../../lib/estimation/shadow-alert-store'
import { withBackgroundTenant } from '../../../lib/platform/tenancy/request-context'
import { activeTenantIds } from '../../../lib/platform/tenancy/tenant-store'
import { isEnabled } from '../../../lib/platform/flags'
import { alert } from '../../../lib/alerts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Its own 60s budget, fully separate from the shadow worker. A run reads at most 1000 jobs
// and evaluates 15 pure policies over them — orders of magnitude cheaper than the vision
// worker, which is why this can run more often than /api/cron/vision-shadow.
export const maxDuration = 60

// Scheduled shadow-alert evaluation. Runs on its OWN schedule and NEVER touches the
// authoritative Book Now estimate, booking status, pricing, or customer communications —
// it only reads persisted shadow jobs and writes to the shadow:alert:* key family.
//
// Why scheduled rather than event-based: the shadow worker processes at most 1 job per
// tenant per 10-minute tick (~6 evaluations/hour), so a */15 pass detects a new condition
// about as fast as one can arise, and the shadow worker path stays untouched.
//
// Auth mirrors the other crons (CRON_SECRET bearer, fail-closed).
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // fail closed — an unconfigured secret must not leave this open
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Cheap no-op unless the flag is on — the route and its schedule can exist safely in
  // production while the subsystem is dormant.
  if (!isEnabled('SHADOW_ALERTING_ENABLED')) {
    return NextResponse.json({ ok: true, enabled: false, opened: 0, at: Date.now() })
  }

  const tenants: { tenant: string; opened: number; skipped?: string; error?: string }[] = []
  let opened = 0
  for (const tenantId of activeTenantIds()) {
    try {
      await withBackgroundTenant('cron', async () => {
        try {
          // The run holds its own lock, so an overlapping tick is a no-op rather than a
          // double-alert. Retrying a failed run is safe: evaluation is idempotent.
          const summary = await runShadowAlertEvaluation()
          opened += summary.opened
          tenants.push({ tenant: tenantId, opened: summary.opened, skipped: summary.skipped })
          if (!summary.ok) {
            await alert({
              type: 'shadow_alert_eval_failed', severity: 'WARNING',
              route: '/api/cron/shadow-alerts', worker: 'runShadowAlertEvaluation',
              errorClass: summary.error ?? 'unknown', tenantId,
            })
          }
        } catch (e) {
          console.error('[cron/shadow-alerts] run', e)
          // A shadow ALERTING failure is not an authoritative-AI health incident, and it is
          // not even a shadow-worker incident — label it precisely.
          await alert({
            type: 'shadow_alert_eval_failed', severity: 'WARNING',
            route: '/api/cron/shadow-alerts', worker: 'runShadowAlertEvaluation',
            errorClass: e instanceof Error ? e.name : 'unknown', tenantId,
          })
          tenants.push({ tenant: tenantId, opened: 0, error: e instanceof Error ? e.name : 'unknown' })
        }
      }, tenantId)
    } catch (e) {
      console.error('[cron/shadow-alerts] tenant', tenantId, e)
      tenants.push({ tenant: tenantId, opened: 0, error: e instanceof Error ? e.name : 'unknown' })
    }
  }
  return NextResponse.json({ ok: true, enabled: true, opened, tenants, at: Date.now() })
}
