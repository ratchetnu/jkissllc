import { NextRequest, NextResponse } from 'next/server'
import { runDueShadowJobs } from '../../../lib/estimation/shadow-worker'
import { withBackgroundTenant } from '../../../lib/platform/tenancy/request-context'
import { activeTenantIds } from '../../../lib/platform/tenancy/tenant-store'
import { isEnabled } from '../../../lib/platform/flags'
import { alert } from '../../../lib/alerts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Its OWN 300s budget, fully separate from /api/cron/ai-jobs. The worker enforces a
// graceful per-job deadline (VISION_SHADOW_DEADLINE_MS) + a run-level budget below this,
// and processes at most 1 job per tick, so it can never hard-kill mid-run or stall.
export const maxDuration = 300

// Independent V2 shadow worker. Runs on its OWN schedule and NEVER touches the
// authoritative Book Now estimate, booking status, pricing, or customer communications.
// A shadow failure is isolated to the shadow store. Auth mirrors /api/cron/ai-jobs
// (CRON_SECRET bearer, fail-closed).
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // fail closed
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Cheap no-op unless the worker flag is on — the route can exist safely in production
  // while the subsystem is dormant.
  if (!isEnabled('VISION_SHADOW_WORKER_ENABLED')) {
    return NextResponse.json({ ok: true, enabled: false, processed: 0, at: Date.now() })
  }

  const tenants: { tenant: string; processed: number; error?: string }[] = []
  let processed = 0
  for (const tenantId of activeTenantIds()) {
    let summary: { processed: number; results: { bookingId: string; status: string }[] } = { processed: 0, results: [] }
    try {
      await withBackgroundTenant('cron', async () => {
        try {
          // At most ONE job per tenant per tick — the shadow path is deliberately slow
          // and low-priority so it can never crowd real work.
          summary = await runDueShadowJobs(1)
        } catch (e) {
          console.error('[cron/vision-shadow] run', e)
          // A shadow failure is NOT an authoritative-AI health incident — label it clearly.
          await alert({ type: 'shadow_worker_failed', severity: 'WARNING', route: '/api/cron/vision-shadow', worker: 'runDueShadowJobs', errorClass: e instanceof Error ? e.name : 'unknown' })
        }
      }, tenantId)
      processed += summary.processed
      tenants.push({ tenant: tenantId, processed: summary.processed })
    } catch (e) {
      console.error('[cron/vision-shadow] tenant', tenantId, e)
      tenants.push({ tenant: tenantId, processed: summary.processed, error: e instanceof Error ? e.name : 'unknown' })
    }
  }
  return NextResponse.json({ ok: true, enabled: true, processed, tenants, at: Date.now() })
}
