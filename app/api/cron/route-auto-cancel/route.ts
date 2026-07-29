import { NextRequest, NextResponse } from 'next/server'
import { listRoutes, getRouteByToken, saveRoute, setStatus, pushAudit } from '../../../lib/routes'
import { withRouteLock, RouteBusyError } from '../../../lib/route-mutex'
import { isEnabled } from '../../../lib/platform/flags'
import { withBackgroundTenant } from '../../../lib/platform/tenancy/request-context'
import { activeTenantIds } from '../../../lib/platform/tenancy/tenant-store'
import { alert } from '../../../lib/alerts'
import {
  selectAutoCancelCandidates, isCancellationWindow, centralDate, centralHour,
  autoCancelAuditNote, isLiveRoute, hasNoCrew, OPS_TIMEZONE,
  type AutoCancelCandidate,
} from '../../../lib/schedule/auto-cancel'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────────────────────
// Stale-route auto-cancellation — the WRITE path.
//
// At midnight America/Chicago, as a route day begins, a committed route dated that
// day with nobody assigned is called off. Selection lives in lib/schedule/auto-cancel
// (pure, clock-injected, independently tested); this file is scheduling, safety and
// persistence.
//
// THREE INDEPENDENT BRAKES, all of which must release before a single record changes:
//   1. ROUTE_AUTO_CANCEL_ENABLED — off by default, in every environment. Off, this
//      job still runs and still reports exactly what it WOULD cancel and why. That
//      report IS the dry run; there is no separate mode to remember to use.
//   2. The cancellation window — writes only inside hour 0 Central. Vercel crons are
//      UTC-only, so this is fired at 05:00 and 06:00 UTC to cover CDT and CST;
//      exactly one of those lands in hour 0 on any date and the other no-ops.
//   3. ?dryRun=1 — an operator override that forces reporting even with the flag on.
//
// IDEMPOTENT BY CONSTRUCTION. Eligibility is re-checked INSIDE the per-route lock
// against a freshly-read record, so a retry, an overlapping firing, or a concurrent
// admin edit cannot double-cancel or cancel something that just got crewed. Running
// this twice in the same minute produces the same end state as running it once.
// ─────────────────────────────────────────────────────────────────────────────

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // fail closed — an unconfigured secret must not leave this open
  return req.headers.get('authorization') === `Bearer ${secret}`
}

type Outcome = {
  candidates: AutoCancelCandidate[]
  cancelled: string[]
  skipped: { routeNumber: string; why: string }[]
  errors: { routeNumber: string; error: string }[]
}

async function runForTenant(now: number, write: boolean): Promise<Outcome> {
  const routes = await listRoutes(1000)
  const candidates = selectAutoCancelCandidates(routes, now)
  const out: Outcome = { candidates, cancelled: [], skipped: [], errors: [] }

  if (!write) return out

  for (const c of candidates) {
    try {
      await withRouteLock(c.token, async () => {
        // Re-read under the lock. The candidate list was computed from a snapshot
        // that is now seconds old; between then and here an admin may have assigned
        // crew, cancelled it by hand, or completed it. The snapshot proposes — the
        // record under the lock decides.
        const fresh = await getRouteByToken(c.token)
        if (!fresh) { out.skipped.push({ routeNumber: c.routeNumber, why: 'route no longer exists' }); return }
        if (!isLiveRoute(fresh)) { out.skipped.push({ routeNumber: c.routeNumber, why: `already ${fresh.status}` }); return }
        if (!hasNoCrew(fresh)) { out.skipped.push({ routeNumber: c.routeNumber, why: 'crew assigned since selection' }); return }
        if (fresh.routeDate !== c.routeDate) { out.skipped.push({ routeNumber: c.routeNumber, why: 'route date changed' }); return }

        const note = autoCancelAuditNote(c)
        setStatus(fresh, 'cancelled', 'system', note)
        // A second, explicit lifecycle entry. setStatus records the transition; this
        // records WHY a machine made it, so the audit trail distinguishes an
        // automatic cancellation from an owner calling a route off by hand.
        pushAudit(fresh, 'system', 'auto-cancel: no crew at route day start', {
          to: 'cancelled', note,
        })
        await saveRoute(fresh)
        out.cancelled.push(c.routeNumber)
      })
    } catch (e) {
      if (e instanceof RouteBusyError) {
        // Someone else holds the lock right now. Not an error: the next run picks it
        // up, and the route is still dated today until the day rolls over.
        out.skipped.push({ routeNumber: c.routeNumber, why: 'route busy — will retry next run' })
        continue
      }
      out.errors.push({ routeNumber: c.routeNumber, error: e instanceof Error ? e.name : 'unknown' })
    }
  }
  return out
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const now = Date.now()
  const forcedDryRun = new URL(req.url).searchParams.get('dryRun') === '1'
  const flagOn = isEnabled('ROUTE_AUTO_CANCEL_ENABLED')
  const inWindow = isCancellationWindow(now)
  const write = flagOn && inWindow && !forcedDryRun

  // Why this run did or did not write — reported on every invocation so an operator
  // reading the log never has to infer which brake was engaged.
  const mode = write ? 'live'
    : forcedDryRun ? 'dry-run (forced)'
    : !flagOn ? 'dry-run (ROUTE_AUTO_CANCEL_ENABLED off)'
    : 'dry-run (outside 00:00 window)'

  try {
    // Per-tenant fan-out, each in its own explicit context. One tenant's failure is
    // isolated and never runs under another's keys.
    const tenants: Record<string, unknown>[] = []
    for (const tenantId of activeTenantIds()) {
      try {
        const r = await withBackgroundTenant('cron', () => runForTenant(now, write), tenantId)
        tenants.push({
          tenant: tenantId,
          candidates: r.candidates.map(c => ({
            routeNumber: c.routeNumber, routeDate: c.routeDate, business: c.businessName,
            status: c.status, reason: c.reason, detail: c.detail,
          })),
          candidateCount: r.candidates.length,
          cancelled: r.cancelled,
          cancelledCount: r.cancelled.length,
          skipped: r.skipped,
          errors: r.errors,
        })
      } catch (e) {
        console.error('[cron/route-auto-cancel] tenant', tenantId, e)
        tenants.push({ tenant: tenantId, error: e instanceof Error ? e.name : 'unknown' })
      }
    }

    return NextResponse.json({
      ok: true,
      mode,
      write,
      flag: { ROUTE_AUTO_CANCEL_ENABLED: flagOn },
      timezone: OPS_TIMEZONE,
      centralDate: centralDate(now),
      centralHour: centralHour(now),
      inCancellationWindow: inWindow,
      tenants,
    })
  } catch (e) {
    console.error('[cron/route-auto-cancel] fatal', e)
    try {
      await alert({
        type: 'cron_job_failed', severity: 'WARNING', worker: 'route-auto-cancel',
        route: '/api/cron/route-auto-cancel',
        errorClass: e instanceof Error ? e.name : 'unknown',
      })
    } catch (alertErr) {
      console.error('[cron/route-auto-cancel] alert failed', alertErr)
    }
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
}
